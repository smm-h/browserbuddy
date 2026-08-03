import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  chromeExtensionIdFromKey,
  chromeHostManifest,
  firefoxHostManifest,
  launcherScript
} from './host-manifest.js';

/**
 * Installing the native-messaging host manifest: the one step that lets a
 * browser find and spawn the host. It lives in server/src (not in scripts/) so
 * that an npm install ships it and `browserbuddy install-host` can call it;
 * scripts/install-native-host.mjs is a thin CLI over the same function, and
 * nothing duplicates the manifest shapes from host-manifest.js.
 *
 * Nothing here writes to stdout: this file is inside the MCP server's source
 * tree, where fd 1 is never ours.
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The script the generated launcher execs. Absolute, because the browser gives the host a minimal environment with no usable PATH or cwd. */
export const HOST_SCRIPT = path.join(SRC_DIR, 'native-host-bin.js');

const PACKAGE_ROOT = path.resolve(SRC_DIR, '..', '..');

export const EXTENSION_DIR = path.join(PACKAGE_ROOT, 'extension');

/** Where the host keeps event logs, demos, and its endpoint files. */
export const DEFAULT_HOST_DATA_DIR = path.join(PACKAGE_ROOT, 'server', 'data');

export const BROWSER_CHOICES = ['chrome', 'firefox'];

/**
 * Chrome-family user-data-dirs on Linux, in the order they are probed. The
 * browser reads NativeMessagingHosts/ from its user-data-dir, so installing
 * into the wrong family's directory produces an extension that can never spawn
 * the host -- hence: probe for one that exists, never invent one.
 */
const CHROME_USER_DATA_DIRS = [
  '.config/google-chrome',
  '.config/chromium',
  '.config/google-chrome-beta',
  '.config/google-chrome-unstable'
];

/**
 * The install writes into platform-specific locations, and only the Linux ones
 * are implemented. Guessing at the macOS or Windows layout would produce a
 * silent no-op install: files written where no browser looks.
 */
export function assertInstallSupported(platform = process.platform) {
  if (platform !== 'linux') {
    throw new Error(
      `native host install is Linux-only in this version; macOS/Windows support is not yet implemented (platform: ${platform}).`
    );
  }
}

/** The first Chrome-family profile directory that exists, or a hard error naming the candidates. */
export function defaultChromeUserDataDir(home = os.homedir()) {
  const candidates = CHROME_USER_DATA_DIRS.map((rel) => path.join(home, rel));
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) {
    throw new Error(
      'No Chrome or Chromium user-data-dir found. Looked for:\n  ' +
        candidates.join('\n  ') +
        '\nPass --user-data-dir <dir> with the profile directory the browser actually uses.'
    );
  }
  return found;
}

/** Firefox keys its native-messaging directory on HOME, not on the profile. */
export function defaultFirefoxHome(home = os.homedir()) {
  return home;
}

/**
 * Writes the launcher and the host manifest, and returns every path it touched.
 *
 * `browser` is `"chrome"` (the Chromium family) or `"firefox"`. `profileDir` is
 * the Chrome user-data-dir; `homeDir` is the Firefox HOME. Both may be omitted,
 * in which case the platform default is resolved.
 */
export function installNativeHost({
  browser,
  profileDir = null,
  homeDir = null,
  dataDir = DEFAULT_HOST_DATA_DIR,
  launcherDir = null,
  extensionDir = EXTENSION_DIR,
  hostScript = HOST_SCRIPT
}) {
  assertInstallSupported();
  if (!BROWSER_CHOICES.includes(browser)) {
    throw new Error(`browser must be one of ${BROWSER_CHOICES.join(', ')}; got ${JSON.stringify(browser)}.`);
  }

  const extensionManifestPath = path.join(extensionDir, 'manifest.json');
  const extManifest = JSON.parse(fs.readFileSync(extensionManifestPath, 'utf8'));

  let targetDir;
  let extensionId;
  if (browser === 'chrome') {
    if (!extManifest.key) {
      throw new Error(
        `${extensionManifestPath} has no "key". Without it Chrome derives a random extension id from the ` +
          'unpacked path and allowed_origins cannot name it. Add the base64 SubjectPublicKeyInfo back.'
      );
    }
    extensionId = chromeExtensionIdFromKey(extManifest.key);
    targetDir = path.join(profileDir ?? defaultChromeUserDataDir(), 'NativeMessagingHosts');
  } else {
    extensionId = extManifest.browser_specific_settings?.gecko?.id;
    if (!extensionId) throw new Error(`${extensionManifestPath} has no browser_specific_settings.gecko.id.`);
    targetDir = path.join(homeDir ?? defaultFirefoxHome(), '.mozilla', 'native-messaging-hosts');
  }

  const launcherTarget = launcherDir ?? targetDir;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(launcherTarget, { recursive: true });

  const launcherPath = path.join(launcherTarget, `${HOST_NAME}.sh`);
  fs.writeFileSync(
    launcherPath,
    launcherScript({ nodePath: process.execPath, hostScript, dataDir }),
    { mode: 0o755 }
  );
  fs.chmodSync(launcherPath, 0o755);

  const manifest =
    browser === 'chrome'
      ? chromeHostManifest({ hostPath: launcherPath, extensionId })
      : firefoxHostManifest({ hostPath: launcherPath, extensionId });

  const manifestPath = path.join(targetDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifestPath, launcherPath, extensionId, targetDir, dataDir, hostScript };
}

#!/usr/bin/env node
/**
 * Installs the BrowserBuddy native-messaging host manifest so a browser can
 * spawn the host with ext.runtime.connectNative().
 *
 * Every path written outside the repository is printed. Nothing is installed
 * implicitly: --target-dir is always derived from an explicit --profile (Chrome)
 * or --home (Firefox), so a run can be pointed at a throwaway directory.
 *
 *   node scripts/install-native-host.mjs --browser chromium --profile <user-data-dir> [--data-dir <dir>]
 *   node scripts/install-native-host.mjs --browser firefox  --home <home-dir>       [--data-dir <dir>]
 *
 *   --browser    chromium | firefox (required)
 *   --profile    Chromium --user-data-dir; the manifest goes in
 *                <profile>/NativeMessagingHosts/ (Chromium reads it from there,
 *                so the user's ~/.config/chromium is never touched)
 *   --home       Firefox HOME; the manifest goes in
 *                <home>/.mozilla/native-messaging-hosts/ (Firefox keys this
 *                directory on HOME, not on the profile)
 *   --data-dir   where the host keeps event logs, demos and mcp-endpoint.json
 *                (default: server/data inside this checkout)
 *   --launcher-dir  where to write the generated launcher shell script
 *                (default: alongside the manifest)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  chromeExtensionIdFromKey,
  chromeHostManifest,
  firefoxHostManifest,
  launcherScript
} from '../server/src/host-manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOST_SCRIPT = path.join(ROOT, 'server', 'src', 'native-host-bin.js');
const EXTENSION_MANIFEST = path.join(ROOT, 'extension', 'manifest.json');

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function die(message) {
  console.error(message);
  process.exit(2);
}

export function installNativeHost({ browser, profileDir, homeDir, dataDir, launcherDir, extensionDir = path.join(ROOT, 'extension') }) {
  const extManifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));

  let targetDir;
  let manifest;
  let extensionId;
  if (browser === 'chromium') {
    if (!extManifest.key) {
      throw new Error(
        `${EXTENSION_MANIFEST} has no "key". Without it Chrome derives a random extension id from the ` +
          'unpacked path and allowed_origins cannot name it. Add the base64 SubjectPublicKeyInfo back.'
      );
    }
    extensionId = chromeExtensionIdFromKey(extManifest.key);
    targetDir = path.join(profileDir, 'NativeMessagingHosts');
  } else {
    extensionId = extManifest.browser_specific_settings?.gecko?.id;
    if (!extensionId) throw new Error(`${EXTENSION_MANIFEST} has no browser_specific_settings.gecko.id.`);
    targetDir = path.join(homeDir, '.mozilla', 'native-messaging-hosts');
  }

  const launcherTarget = launcherDir ?? targetDir;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(launcherTarget, { recursive: true });

  const launcherPath = path.join(launcherTarget, `${HOST_NAME}.sh`);
  fs.writeFileSync(
    launcherPath,
    launcherScript({ nodePath: process.execPath, hostScript: HOST_SCRIPT, dataDir }),
    { mode: 0o755 }
  );
  fs.chmodSync(launcherPath, 0o755);

  manifest =
    browser === 'chromium'
      ? chromeHostManifest({ hostPath: launcherPath, extensionId })
      : firefoxHostManifest({ hostPath: launcherPath, extensionId });

  const manifestPath = path.join(targetDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifestPath, launcherPath, extensionId, targetDir, dataDir };
}

function main() {
  const browser = option('--browser');
  if (browser !== 'chromium' && browser !== 'firefox') {
    die('--browser must be "chromium" or "firefox".');
  }
  const profileDir = option('--profile');
  const homeDir = option('--home');
  if (browser === 'chromium' && !profileDir) die('--profile <user-data-dir> is required for --browser chromium.');
  if (browser === 'firefox' && !homeDir) die('--home <home-dir> is required for --browser firefox.');

  const dataDir = path.resolve(option('--data-dir') ?? path.join(ROOT, 'server', 'data'));
  const launcherDir = option('--launcher-dir') ? path.resolve(option('--launcher-dir')) : null;

  const result = installNativeHost({
    browser,
    profileDir: profileDir ? path.resolve(profileDir) : null,
    homeDir: homeDir ? path.resolve(homeDir) : null,
    dataDir,
    launcherDir
  });

  console.log(`host name:     ${HOST_NAME}`);
  console.log(`extension id:  ${result.extensionId}`);
  console.log(`manifest:      ${result.manifestPath}`);
  console.log(`launcher:      ${result.launcherPath}`);
  console.log(`host data dir: ${result.dataDir}`);
  console.log(`endpoint file: ${path.join(result.dataDir, 'mcp-endpoint.json')} (written when the browser spawns the host)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

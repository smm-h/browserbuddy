#!/usr/bin/env node
/**
 * Installs the BrowserBuddy native-messaging host manifest so a browser can
 * spawn the host with ext.runtime.connectNative().
 *
 * This is the development entry point: it can point the install at a throwaway
 * profile, which is what the smoke tests need. End users run the shipped
 * command instead -- `browserbuddy install-host --browser chrome|firefox` --
 * which calls the very same installNativeHost() from server/src/install-host.js.
 *
 *   node scripts/install-native-host.mjs --browser chrome   --profile <user-data-dir> [--data-dir <dir>]
 *   node scripts/install-native-host.mjs --browser firefox  --home <home-dir>         [--data-dir <dir>]
 *
 *   --browser    chrome | firefox (required; "chrome" covers the Chromium family)
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
 *
 * Every path written outside the repository is printed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAME } from '../server/src/host-manifest.js';
import { installNativeHost, DEFAULT_HOST_DATA_DIR, BROWSER_CHOICES } from '../server/src/install-host.js';

export { installNativeHost };

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function die(message) {
  console.error(message);
  process.exit(2);
}

function main() {
  const browser = option('--browser');
  if (!BROWSER_CHOICES.includes(browser)) {
    die(`--browser must be one of ${BROWSER_CHOICES.join(', ')}.`);
  }
  const profileDir = option('--profile');
  const homeDir = option('--home');
  if (browser === 'chrome' && !profileDir) die('--profile <user-data-dir> is required for --browser chrome.');
  if (browser === 'firefox' && !homeDir) die('--home <home-dir> is required for --browser firefox.');

  const dataDir = path.resolve(option('--data-dir') ?? DEFAULT_HOST_DATA_DIR);
  const launcherDir = option('--launcher-dir') ? path.resolve(option('--launcher-dir')) : null;

  let result;
  try {
    result = installNativeHost({
      browser,
      profileDir: profileDir ? path.resolve(profileDir) : null,
      homeDir: homeDir ? path.resolve(homeDir) : null,
      dataDir,
      launcherDir
    });
  } catch (err) {
    die(err.message);
  }

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

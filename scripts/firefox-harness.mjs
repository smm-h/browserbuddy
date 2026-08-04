/**
 * The Firefox half of the live harnesses, in one place.
 *
 * Both scripts/e2e-smoke.mjs (WebSocket carrier) and
 * scripts/spike-nativemsg.mjs (native-messaging carrier) have to do the same
 * three awkward things to test against a real Firefox: write a profile that
 * grants MV3 host permissions without a human clicking, launch the browser with
 * the remote debugging protocol open, and install extension/ as a temporary
 * add-on over that protocol (the mechanism web-ext uses). Duplicating the RDP
 * client in both would guarantee they drift.
 *
 * Nothing here is Firefox-version-specific beyond the RDP packet shapes, which
 * have been stable since the actor system landed.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Profile preferences every live Firefox run needs.
 *
 * `extensions.originControls.grantByDefault` is the important one: Firefox MV3
 * treats `host_permissions` as opt-in, and without the grant the content script
 * never runs, so every page-level check would fail for a reason unrelated to
 * what is being tested.
 */
export const FIREFOX_PREFS = {
  // Remote debugging protocol, used to install the temporary add-on.
  'devtools.debugger.remote-enabled': true,
  'devtools.debugger.prompt-connection': false,
  'devtools.chrome.enabled': true,
  // MV3 host permissions are opt-in on Firefox; grant them non-interactively.
  'extensions.originControls.grantByDefault': true,
  // Quiet first-run behaviour so the run starts on a blank page.
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'browser.startup.homepage': 'about:blank',
  'startup.homepage_welcome_url': 'about:blank'
};

/** Writes user.js into the profile directory, creating it if needed. */
export function writeFirefoxProfile(profileDir, extraPrefs = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const prefs = { ...FIREFOX_PREFS, ...extraPrefs };
  const userJs = Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
  fs.writeFileSync(path.join(profileDir, 'user.js'), `${userJs}\n`);
  return profileDir;
}

/**
 * Spawns Firefox with the debugger server listening.
 *
 * Headed under Xvfb when possible: `--headless` Firefox does not paint, so
 * `captureVisibleTab` returns an empty image and a screenshot check cannot be
 * exercised honestly.
 *
 * `env` is merged over the parent environment -- the native-messaging harness
 * uses it to point HOME at a throwaway directory, since Firefox reads
 * `$HOME/.mozilla/native-messaging-hosts/` and the real one must never be
 * touched by a test.
 *
 * detached: the binary is usually a wrapper script, and signals must reach the
 * whole process group or the real browser survives and keeps the profile locked.
 */
export function launchFirefox(binary, { profileDir, rdpPort, xvfb, env = {}, extraArgs = [] }) {
  const ffArgs = [
    ...(xvfb ? [] : ['--headless']),
    '--no-remote',
    '--new-instance',
    '-profile',
    profileDir,
    '--start-debugger-server',
    String(rdpPort),
    ...extraArgs,
    'about:blank'
  ];
  const cmd = xvfb ? 'xvfb-run' : binary;
  const args = xvfb ? ['-a', binary, ...ffArgs] : ffArgs;
  return spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...env }
  });
}

// ---------------------------------------------------------------------------
// Firefox remote debugging protocol client -- the minimum needed to install a
// temporary add-on. Packets are `<byteLength>:<json>`; requests carry `to`,
// replies carry `from`.
// ---------------------------------------------------------------------------

export function rdpConnect(port, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => resolve(wrapRdpSocket(sock)));
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) reject(new Error(`RDP port ${port} never became reachable`));
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
}

function wrapRdpSocket(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const colon = buf.indexOf(0x3a);
      if (colon === -1) return;
      const length = Number(buf.slice(0, colon).toString('ascii'));
      if (!Number.isInteger(length)) {
        sock.destroy(new Error('RDP framing error'));
        return;
      }
      if (buf.length < colon + 1 + length) return;
      const body = buf.slice(colon + 1, colon + 1 + length).toString('utf8');
      buf = buf.slice(colon + 1 + length);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].match(msg)) {
          const [w] = waiters.splice(i, 1);
          w.resolve(msg);
          break;
        }
      }
    }
  });
  return {
    /** Resolves with the next packet satisfying `match`, or rejects on timeout. */
    expect(match, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) {
            waiters.splice(i, 1);
            reject(new Error('Timed out waiting for RDP reply'));
          }
        }, timeoutMs).unref();
      });
    },
    send(obj) {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      sock.write(`${body.length}:${body}`);
    },
    close() {
      sock.destroy();
    }
  };
}

/** Installs `addonPath` as a temporary add-on and returns the addon descriptor. */
export async function installTemporaryAddon(rdpPort, addonPath) {
  const rdp = await rdpConnect(rdpPort);
  try {
    await rdp.expect((m) => m.from === 'root' && m.applicationType !== undefined);
    const rootReply = rdp.expect((m) => m.from === 'root' && m.addonsActor !== undefined);
    rdp.send({ to: 'root', type: 'getRoot' });
    const { addonsActor } = await rootReply;
    const installReply = rdp.expect(
      (m) => m.from === addonsActor && (m.addon !== undefined || m.error !== undefined)
    );
    rdp.send({ to: addonsActor, type: 'installTemporaryAddon', addonPath, openDevTools: false });
    const result = await installReply;
    if (result.error) {
      throw new Error(`installTemporaryAddon failed: ${result.error} ${result.message || ''}`);
    }
    return result.addon;
  } finally {
    rdp.close();
  }
}

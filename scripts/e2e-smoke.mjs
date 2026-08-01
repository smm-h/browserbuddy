#!/usr/bin/env node
/**
 * BrowserBuddy end-to-end smoke test.
 *
 * Drives the real product: spawns the MCP stdio server, launches a real browser
 * (Chromium or Firefox) with extension/ loaded, and exercises the MCP tools
 * against live pages.
 *
 * Runnable from any cwd; all paths are resolved from this file's location.
 *
 *   node scripts/e2e-smoke.mjs [--browser chromium|firefox] [--keep] [--headed] [--port N]
 *
 *   --browser  which browser to test (default chromium)
 *   --keep     leave the temp profile/data dirs in place for inspection
 *   --headed   Chromium only: skip --headless=new, go straight to xvfb-run
 *   --port     hub port to use (default 8590)
 *
 * Firefox notes: the extension is installed as a temporary add-on through the
 * Firefox remote debugging protocol (the same mechanism web-ext uses), and the
 * profile sets extensions.originControls.grantByDefault so the MV3 host
 * permissions are granted without the interactive opt-in a human would use.
 *
 * Exit code is 0 only when every check passes.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'src', 'index.js');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const TMP_DIR = path.join(ROOT, 'server', 'test', '.tmp');
const PROFILE_DIR = path.join(TMP_DIR, 'e2e-profile');
const DATA_DIR = path.join(TMP_DIR, 'e2e-data');

const CHROME_CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
const FIREFOX_CANDIDATES = ['firefox', 'firefox-esr'];

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const HEADED_ONLY = argv.includes('--headed');
const PORT = (() => {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : 8590;
})();
const BROWSER = (() => {
  const i = argv.indexOf('--browser');
  const value = i >= 0 ? argv[i + 1] : 'chromium';
  if (value !== 'chromium' && value !== 'firefox') {
    console.error(`--browser must be "chromium" or "firefox", got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return value;
})();

const CONNECT_TIMEOUT_MS = 30000;
const LOAD_POLL_MS = 10000;

/**
 * The directory actually loaded into the browser: a staged copy of extension/
 * with WS_URL rewritten to the test port. Staging keeps the repo untouched and
 * lets the test run on a secondary port while a live hub occupies 8590.
 */
let stagedExtensionDir = EXTENSION_DIR;

function stageExtension(port) {
  const staged = path.join(TMP_DIR, 'e2e-extension');
  fs.rmSync(staged, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(staged, { recursive: true });
  for (const name of fs.readdirSync(EXTENSION_DIR)) {
    fs.copyFileSync(path.join(EXTENSION_DIR, name), path.join(staged, name));
  }
  const bgPath = path.join(staged, 'background.js');
  const bg = fs.readFileSync(bgPath, 'utf8');
  const anchor = "const WS_URL = 'ws://127.0.0.1:8590/ws';";
  if (!bg.includes(anchor)) {
    throw new Error(`background.js no longer contains ${JSON.stringify(anchor)}; update stageExtension().`);
  }
  fs.writeFileSync(bgPath, bg.replace(anchor, `const WS_URL = 'ws://127.0.0.1:${port}/ws';`));
  return staged;
}

// Primary navigation targets. Swapped for data: URLs when the network is down.
let TARGET_URL = 'https://example.com/';
let TARGET_MATCH = 'example.com';
let TARGET_TEXT = 'Example Domain';
let CLICK_TEXT = 'More information';
let OFFSITE_MATCH = 'iana.org';
let usingDataUrls = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` -- ${detail}` : ''}`);
}
function fatal(name, detail) {
  record(name, false, detail);
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

function which(bin) {
  const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return r.status === 0 && out ? out.split('\n')[0] : null;
}

function findBrowser(candidates) {
  for (const candidate of candidates) {
    const found = which(candidate);
    if (found) return { name: candidate, path: found };
  }
  return null;
}

function browserVersion(binary) {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || 'unknown';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** Cheap reachability probe so we can fall back to data: URLs when offline. */
function networkUp(host) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: 443, timeout: 5000 });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

/** Self-contained pages used when the public internet is unreachable. */
function useDataUrls() {
  usingDataUrls = true;
  const dest = 'data:text/html,' + encodeURIComponent('<html><body><h1>Offsite Landing</h1></body></html>');
  const page =
    '<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1>' +
    `<p><a id="more" href="${dest}">More information</a></p></body></html>`;
  TARGET_URL = 'data:text/html,' + encodeURIComponent(page);
  TARGET_MATCH = 'Example%20Domain';
  TARGET_TEXT = 'Example Domain';
  CLICK_TEXT = 'More information';
  OFFSITE_MATCH = 'Offsite%20Landing';
}

// ---------------------------------------------------------------------------
// MCP client (SDK is installed under the repo-root node_modules)
// ---------------------------------------------------------------------------

async function loadSdk() {
  const req = createRequire(path.join(ROOT, 'package.json'));
  // The package is dual-published; resolve() lands on dist/cjs, so derive the
  // package root and load the ESM build explicitly.
  const cjsEntry = req.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkRoot = cjsEntry.split(`${path.sep}dist${path.sep}`)[0];
  const clientMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/index.js')).href);
  const stdioMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/stdio.js')).href);
  return { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
}

const serverStderr = [];

async function startMcp({ Client, StdioClientTransport }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, 'serve', '--data-dir', DATA_DIR, '--port', String(PORT)],
    cwd: ROOT,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'browserbuddy-e2e-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  if (transport.stderr) {
    transport.stderr.setEncoding('utf8');
    transport.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) serverStderr.push(line.trim());
    });
  }
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

/** Every JSON-returning tool wraps its payload in a single text content block. */
async function callJson(client, name, args = {}) {
  const res = await callTool(client, name, args);
  if (res.isError) {
    const text = (res.content ?? []).map((c) => c.text ?? '').join(' ');
    throw new Error(`${name} returned isError: ${text}`);
  }
  const block = (res.content ?? []).find((c) => c.type === 'text');
  if (!block) throw new Error(`${name} returned no text content block`);
  return JSON.parse(block.text);
}

// ---------------------------------------------------------------------------
// Browser processes
// ---------------------------------------------------------------------------

let browserChild = null;
const browserOutput = [];

function captureStreams(child) {
  const capture = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) browserOutput.push(line.trim());
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  child.on('error', (err) => browserOutput.push(`spawn error: ${err.message}`));
}

function launchChrome(binary, { headless, xvfb }) {
  const chromeArgs = [
    ...(headless ? ['--headless=new'] : []),
    `--load-extension=${stagedExtensionDir}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ];
  const cmd = xvfb ? 'xvfb-run' : binary;
  const args = xvfb ? ['-a', binary, ...chromeArgs] : chromeArgs;
  // detached: the binary may be a wrapper script; signals must reach the whole
  // process group or the real browser survives and keeps the profile locked.
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  captureStreams(child);
  return child;
}

const FIREFOX_PREFS = {
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

function launchFirefox(binary, rdpPort, { xvfb }) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const userJs = Object.entries(FIREFOX_PREFS)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'user.js'), userJs + '\n');
  // Headed under Xvfb when possible: --headless Firefox does not paint, so
  // captureVisibleTab returns an empty image and the screenshot check cannot
  // be exercised honestly.
  const ffArgs = [
    ...(xvfb ? [] : ['--headless']),
    '--no-remote',
    '--new-instance',
    '-profile',
    PROFILE_DIR,
    '--start-debugger-server',
    String(rdpPort),
    'about:blank'
  ];
  const cmd = xvfb ? 'xvfb-run' : binary;
  const args = xvfb ? ['-a', binary, ...ffArgs] : ffArgs;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  captureStreams(child);
  return child;
}

// ---------------------------------------------------------------------------
// Firefox remote debugging protocol client -- the minimum needed to install a
// temporary add-on. Packets are `<byteLength>:<json>`; requests carry `to`,
// replies carry `from`.
// ---------------------------------------------------------------------------

function rdpConnect(port, timeoutMs = 60000) {
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

async function installTemporaryAddon(rdpPort) {
  const rdp = await rdpConnect(rdpPort);
  try {
    await rdp.expect((m) => m.from === 'root' && m.applicationType !== undefined);
    const rootReply = rdp.expect((m) => m.from === 'root' && m.addonsActor !== undefined);
    rdp.send({ to: 'root', type: 'getRoot' });
    const { addonsActor } = await rootReply;
    const installReply = rdp.expect(
      (m) => m.from === addonsActor && (m.addon !== undefined || m.error !== undefined)
    );
    rdp.send({ to: addonsActor, type: 'installTemporaryAddon', addonPath: stagedExtensionDir, openDevTools: false });
    const result = await installReply;
    if (result.error) {
      throw new Error(`installTemporaryAddon failed: ${result.error} ${result.message || ''}`);
    }
    return result.addon;
  } finally {
    rdp.close();
  }
}

function signalBrowser(child, sig) {
  // The whole process group: browser binaries are often launched via wrapper
  // scripts, and signalling only the wrapper leaves the real browser running.
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

async function stopBrowser() {
  if (!browserChild || browserChild.exitCode !== null) return;
  const child = browserChild;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  signalBrowser(child, 'SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    signalBrowser(child, 'SIGKILL');
    await Promise.race([exited, sleep(3000)]);
  }
  // The wrapper's exit can precede the browser's; give the group a beat to
  // release profile files before callers delete the profile directory.
  await sleep(1000);
  browserChild = null;
}

async function waitForConnected(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await callJson(client, 'browser_state');
      last = state;
      if (state.connected === true) return state;
    } catch (err) {
      last = { error: err.message };
    }
    await sleep(500);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Polling helper: retries fn until it reports ok, then returns its last report.
// ---------------------------------------------------------------------------

async function poll(fn, timeoutMs = LOAD_POLL_MS, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, detail: 'never ran' };
  for (;;) {
    try {
      last = await fn();
      if (last && last.ok) return last;
    } catch (err) {
      last = { ok: false, detail: err.message };
    }
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function runChecks(client, state) {
  record('browser_state.connected === true', state && state.connected === true, `connected=${state?.connected}`);

  // --- open a tab -----------------------------------------------------------
  let tabId = null;
  try {
    const opened = await callJson(client, 'browser_open_tab', { url: TARGET_URL });
    tabId = opened.tabId;
    record('browser_open_tab returns a tabId', typeof tabId === 'number', `tabId=${JSON.stringify(tabId)}`);
  } catch (err) {
    record('browser_open_tab returns a tabId', false, err.message);
  }
  if (typeof tabId !== 'number') {
    record('remaining tab-scoped checks', false, 'skipped: no tabId from browser_open_tab');
    return;
  }

  // --- read -----------------------------------------------------------------
  const read = await poll(async () => {
    const r = await callJson(client, 'browser_read', { mode: 'text', tabId });
    const text = JSON.stringify(r);
    return { ok: text.includes(TARGET_TEXT), detail: `text length=${text.length}`, payload: r };
  });
  record(`browser_read text contains "${TARGET_TEXT}"`, read.ok, read.detail);

  // --- page state -----------------------------------------------------------
  const pageState = await poll(async () => {
    const r = await callJson(client, 'browser_page_state', { tabId });
    const urlOk = typeof r.url === 'string' && r.url.includes(TARGET_MATCH);
    const readyOk = typeof r.readyState === 'string' && r.readyState.length > 0;
    return {
      ok: urlOk && readyOk,
      detail: `url=${String(r.url).slice(0, 60)} readyState=${r.readyState}`,
      payload: r
    };
  });
  record('browser_page_state has target url + readyState', pageState.ok, pageState.detail);

  // --- eval (main-world injection) ------------------------------------------
  try {
    const evaled = await callJson(client, 'browser_eval', { code: '6 * 7', tabId });
    record('browser_eval runs in the page main world', evaled.result === 42, `result=${JSON.stringify(evaled.result)}`);
  } catch (err) {
    record('browser_eval runs in the page main world', false, err.message);
  }

  // --- screenshot -----------------------------------------------------------
  // Firefox MV3 never lets an extension capture without a user gesture
  // (activeTab); the honest behaviour there is the documented hard error.
  if (BROWSER === 'firefox') {
    try {
      const shot = await callTool(client, 'browser_screenshot', { tabId });
      const text = (shot.content ?? []).map((c) => c.text ?? '').join(' ');
      record(
        'browser_screenshot hard-errors on Firefox (activeTab gesture required)',
        shot.isError === true && /activeTab/.test(text),
        `isError=${shot.isError} message=${text.slice(0, 90)}`
      );
    } catch (err) {
      record('browser_screenshot hard-errors on Firefox (activeTab gesture required)', false, err.message);
    }
  } else {
    try {
      const shot = await callTool(client, 'browser_screenshot', { tabId });
      const img = (shot.content ?? []).find((c) => c.type === 'image');
      const len = img && typeof img.data === 'string' ? img.data.length : 0;
      record('browser_screenshot returns image base64 > 1000 chars', Boolean(img) && len > 1000, `base64 length=${len}`);
    } catch (err) {
      record('browser_screenshot returns image base64 > 1000 chars', false, err.message);
    }
  }

  // --- click that navigates -------------------------------------------------
  // Discover the outbound link instead of hardcoding page copy: example.com has
  // already changed its link text once ("More information..." -> "Learn more").
  let clickText = CLICK_TEXT;
  try {
    const links = await callJson(client, 'browser_read', { mode: 'links', tabId });
    const list = Array.isArray(links.content) ? links.content : [];
    const offsite = list.find(
      (l) => l && l.text && l.href && /^(https?:|data:)/.test(l.href) && !l.href.includes(TARGET_MATCH)
    );
    if (offsite) clickText = offsite.text;
    record(
      'browser_read mode:"links" finds an outbound link',
      Boolean(offsite),
      offsite
        ? `"${offsite.text}" -> ${String(offsite.href).slice(0, 55)}`
        : `no offsite link in ${JSON.stringify(list).slice(0, 120)}`
    );
  } catch (err) {
    record('browser_read mode:"links" finds an outbound link', false, err.message);
  }

  let clickErr = null;
  try {
    await callJson(client, 'browser_click', { text: clickText, tabId });
  } catch (err) {
    clickErr = err.message;
  }
  const navigated = await poll(async () => {
    const r = await callJson(client, 'browser_page_state', { tabId });
    const moved = typeof r.url === 'string' && !r.url.includes(TARGET_MATCH);
    return { ok: moved, detail: `url=${String(r.url).slice(0, 70)}`, payload: r };
  });
  record(
    `browser_click "${clickText}" navigates away`,
    navigated.ok && !clickErr,
    clickErr ? `click rpc error: ${clickErr}` : navigated.detail
  );

  // Give the extension's event stream a moment to flush navigation events.
  await sleep(1500);

  // --- attribution ----------------------------------------------------------
  // Match on where we actually ended up, not just the assumed destination.
  const landedUrl = navigated.payload && typeof navigated.payload.url === 'string' ? navigated.payload.url : '';
  const landedToken = (() => {
    try {
      return new URL(landedUrl).hostname || OFFSITE_MATCH;
    } catch {
      return OFFSITE_MATCH;
    }
  })();
  const relevant = (e) =>
    ['navigation', 'page_loaded', 'tab_created', 'tab_activated'].includes(e.type) &&
    typeof e.url === 'string' &&
    (e.url.includes(TARGET_MATCH) || e.url.includes(OFFSITE_MATCH) || (landedToken && e.url.includes(landedToken)));

  let agentEvents = [];
  let userEvents = [];
  try {
    agentEvents = (await callJson(client, 'browser_observe', { actor: 'agent', limit: 200 })).events ?? [];
    const agentHits = agentEvents.filter(relevant);
    record(
      'browser_observe actor:"agent" contains agent navigation/tab events',
      agentHits.length > 0,
      `${agentHits.length} matching agent events (${[...new Set(agentHits.map((e) => e.type))].join(',') || 'none'})`
    );
  } catch (err) {
    record('browser_observe actor:"agent" contains agent navigation/tab events', false, err.message);
  }

  try {
    userEvents = (await callJson(client, 'browser_observe', { actor: 'user', limit: 200 })).events ?? [];
    const leaked = userEvents.filter(relevant);
    record(
      'browser_observe actor:"user" excludes agent navigations',
      leaked.length === 0,
      leaked.length === 0
        ? 'no agent-driven events attributed to user'
        : `leaked ${leaked.length}: ` +
          leaked
            .slice(0, 4)
            .map((e) => `${e.type}@${String(e.url).slice(0, 45)}`)
            .join(' | ')
    );
  } catch (err) {
    record('browser_observe actor:"user" excludes agent navigations', false, err.message);
  }

  // --- demo lifecycle -------------------------------------------------------
  try {
    await callJson(client, 'demo_record_start', { name: 'e2e-probe', overwrite: true });
    const stopped = await callJson(client, 'demo_record_stop');
    record(
      'demo_record_start/stop lifecycle',
      typeof stopped.stepCount === 'number' && stopped.stepCount >= 0,
      `name=${stopped.name} stepCount=${stopped.stepCount}`
    );
  } catch (err) {
    record('demo_record_start/stop lifecycle', false, err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function tail(lines, n, label) {
  if (lines.length === 0) return `  (no ${label} output)`;
  return lines
    .slice(-n)
    .map((l) => `  ${l}`)
    .join('\n');
}

function summarize() {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log('\n================ E2E SMOKE SUMMARY ================');
  for (const r of results) {
    console.log(`${(r.ok ? 'PASS' : 'FAIL').padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('---------------------------------------------------');
  console.log(`${results.length - failed.length}/${results.length} checks passed${usingDataUrls ? ' (data: URL mode -- no network)' : ''}`);
  console.log('===================================================');
  return failed.length === 0;
}

/** Chromium connect phase: headless first, then headed under xvfb-run. */
async function connectViaChromium(client, binary) {
  let state = null;
  if (!HEADED_ONLY) {
    console.log('Launching Chrome with --headless=new ...');
    browserChild = launchChrome(binary, { headless: true, xvfb: false });
    state = await waitForConnected(client, CONNECT_TIMEOUT_MS);
  }

  if (!state || state.connected !== true) {
    const xvfb = which('xvfb-run');
    if (xvfb) {
      if (!HEADED_ONLY) {
        console.log('Extension did not connect under --headless=new; retrying headed under xvfb-run.');
        await stopBrowser();
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } else {
        console.log('Launching Chrome headed under xvfb-run ...');
      }
      browserChild = launchChrome(binary, { headless: false, xvfb: true });
      state = await waitForConnected(client, CONNECT_TIMEOUT_MS);
    }
  }
  return state;
}

/** Firefox connect phase: temporary add-on installed over RDP. */
async function connectViaFirefox(client, binary) {
  const rdpPort = await freePort();
  const xvfb = which('xvfb-run') !== null;
  console.log(`Launching Firefox ${xvfb ? 'headed under xvfb-run' : 'with --headless'} (RDP on ${rdpPort}) ...`);
  browserChild = launchFirefox(binary, rdpPort, { xvfb });
  const addon = await installTemporaryAddon(rdpPort);
  console.log(`Temporary add-on installed: ${addon && addon.id ? addon.id : JSON.stringify(addon)}`);
  return waitForConnected(client, CONNECT_TIMEOUT_MS);
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const browser =
    BROWSER === 'firefox' ? findBrowser(FIREFOX_CANDIDATES) : findBrowser(CHROME_CANDIDATES);
  if (!browser) {
    const tried = BROWSER === 'firefox' ? FIREFOX_CANDIDATES : CHROME_CANDIDATES;
    console.error(
      `No ${BROWSER} binary found. Tried: ${tried.join(', ')}.\n` +
        'Install one of them to run this smoke test. Nothing was installed automatically.'
    );
    process.exit(2);
  }
  console.log(`Browser binary: ${browser.path} (${browserVersion(browser.path)})`);

  if (!(await portFree(PORT))) {
    console.error(
      `Port ${PORT} is already in use. Another BrowserBuddy server (or something else) is bound to ` +
        `127.0.0.1:${PORT}. Stop it and rerun, or pass --port <other>.`
    );
    process.exit(2);
  }

  if (!(await networkUp('example.com'))) {
    console.log('example.com unreachable -- switching to self-contained data: URLs.');
    useDataUrls();
  }

  // Fresh dirs every run so state never leaks between runs.
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  stagedExtensionDir = stageExtension(PORT);

  const sdk = await loadSdk();
  let client = null;
  let transport = null;
  let ok = false;

  try {
    ({ client, transport } = await startMcp(sdk));
    console.log(`MCP server started (data-dir ${DATA_DIR}, port ${PORT}).`);

    const state =
      BROWSER === 'firefox'
        ? await connectViaFirefox(client, browser.path)
        : await connectViaChromium(client, browser.path);

    if (!state || state.connected !== true) {
      fatal('extension connects to hub', `browser_state never reported connected. last=${JSON.stringify(state)}`);
      console.error('\n--- Browser output (tail) ---\n' + tail(browserOutput, 30, 'browser'));
      console.error('\n--- MCP server stderr (tail) ---\n' + tail(serverStderr, 20, 'server'));
    } else {
      record('extension connects to hub', true, `connected after handshake`);
      await runChecks(client, state);
    }
  } catch (err) {
    fatal('smoke harness', err.stack || err.message);
    console.error('\n--- Browser output (tail) ---\n' + tail(browserOutput, 30, 'browser'));
    console.error('\n--- MCP server stderr (tail) ---\n' + tail(serverStderr, 20, 'server'));
  } finally {
    await stopBrowser();
    try {
      if (client) await client.close();
    } catch {
      /* transport may already be down */
    }
    try {
      if (transport) await transport.close();
    } catch {
      /* already closed */
    }
    if (!KEEP) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(path.join(TMP_DIR, 'e2e-extension'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } else {
      console.log(`\n--keep: left ${PROFILE_DIR}, ${DATA_DIR} and the staged extension in place.`);
    }
    ok = summarize();
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});

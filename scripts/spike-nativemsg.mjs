#!/usr/bin/env node
/**
 * BrowserBuddy transport spike: end-to-end proof of the native-messaging path,
 * on Chromium and on Firefox.
 *
 * Nothing here is simulated. The sequence is:
 *   1. install the native-messaging host manifest somewhere throwaway --
 *      a scratch Chromium user-data-dir (Chromium reads NativeMessagingHosts/
 *      from there) or a scratch HOME (Firefox reads
 *      $HOME/.mozilla/native-messaging-hosts/ from there). The user's real
 *      ~/.config/chromium and ~/.mozilla are never touched;
 *   2. launch the real browser with extension/ loaded -- Chromium by
 *      --load-extension with the id pinned by the manifest "key", Firefox as a
 *      temporary add-on over the remote debugging protocol, with the gecko id
 *      the host manifest's allowed_extensions names;
 *   3. the EXTENSION calls connectNative -- the BROWSER spawns the host;
 *   4. the host binds a loopback port, serves Streamable-HTTP MCP behind a
 *      bearer token, and writes mcp-endpoint.json;
 *   5. this script reads that file and connects a real MCP SDK client to the
 *      url with the token;
 *   6. tool calls travel client -> HTTP -> host -> native pipe -> extension ->
 *      page, and back.
 *
 *   node scripts/spike-nativemsg.mjs [--browser chromium|firefox] [--keep]
 *                                    [--headed] [--idle-probe-sec N]
 *   node scripts/spike-nativemsg.mjs --hard-error-probe
 *
 *   --browser          which browser to prove (default chromium)
 *   --keep             leave the profile/data dirs for inspection
 *   --headed           Chromium only: skip --headless=new, go to xvfb-run
 *                      (Firefox always runs headed under xvfb-run when it is
 *                      available, because headless Firefox does not paint)
 *   --idle-probe-sec   after the checks, sit idle this long and re-call a tool,
 *                      to measure whether the background context keeps the
 *                      native port -- and therefore the host -- alive
 *                      (0 disables; default 0)
 *   --hard-error-probe Chromium only: launch with NO host manifest installed
 *                      and assert that the extension reports a precise,
 *                      actionable error and does not quietly fall back to the
 *                      WebSocket wire
 *
 * Exit code is 0 only when every check passes.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNativeHost } from './install-native-host.mjs';
import { writeFirefoxProfile, launchFirefox, installTemporaryAddon } from './firefox-harness.mjs';
import { HOST_NAME } from '../server/src/host-manifest.js';
import { ENDPOINT_FILENAME, readEndpointFile } from '../server/src/endpoint-file.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const CLI_ENTRY = path.join(ROOT, 'server', 'src', 'index.js');
const TMP_DIR = path.join(ROOT, 'server', 'test', '.tmp');
const PROFILE_DIR = path.join(TMP_DIR, 'spike-nm-profile');
const DATA_DIR = path.join(TMP_DIR, 'spike-nm-data');
/** Firefox keys its native-messaging directory on HOME, so the run gets its own. */
const FIREFOX_HOME = path.join(TMP_DIR, 'spike-nm-ff-home');

const CHROME_CANDIDATES = ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome'];
const FIREFOX_CANDIDATES = ['firefox', 'firefox-esr'];

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const HEADED_ONLY = argv.includes('--headed');
const HARD_ERROR_PROBE = argv.includes('--hard-error-probe');
const BROWSER = (() => {
  const i = argv.indexOf('--browser');
  const value = i >= 0 ? argv[i + 1] : 'chromium';
  if (value !== 'chromium' && value !== 'firefox') {
    console.error(`--browser must be "chromium" or "firefox", got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return value;
})();
const IDLE_PROBE_SEC = (() => {
  const i = argv.indexOf('--idle-probe-sec');
  return i >= 0 ? Number(argv[i + 1]) : 0;
})();

const ENDPOINT_TIMEOUT_MS = 45000;

const PAGE_HTML =
  '<html><head><title>Spike Target</title></head><body>' +
  '<h1>Spike Target</h1><p id="p">native messaging round trip</p>' +
  '<input id="field" name="field"><button id="btn">Press</button></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The page under test is served over loopback HTTP rather than a data: URL:
 * content scripts do not run on data: URLs and <all_urls> does not cover them,
 * so a data: page would fail every DOM check for reasons unrelated to the
 * transport. This keeps the run self-contained and offline.
 */
function startPageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/spike`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const notes = [];
function note(line) {
  notes.push(line);
  console.log(`[NOTE] ${line}`);
}

// ---------------------------------------------------------------------------
// Environment
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

/** An unused loopback port for Firefox's debugger server. */
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

// ---------------------------------------------------------------------------
// MCP client over Streamable HTTP
// ---------------------------------------------------------------------------

async function loadSdk() {
  const req = createRequire(path.join(ROOT, 'package.json'));
  const cjsEntry = req.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkRoot = cjsEntry.split(`${path.sep}dist${path.sep}`)[0];
  const clientMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/index.js')).href);
  const httpMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/streamableHttp.js')).href);
  return { Client: clientMod.Client, StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport };
}

async function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function callJson(client, name, args = {}) {
  const res = await callTool(client, name, args);
  if (res.isError) {
    throw new Error(`${name} returned isError: ${(res.content ?? []).map((c) => c.text ?? '').join(' ')}`);
  }
  const block = (res.content ?? []).find((c) => c.type === 'text');
  if (!block) throw new Error(`${name} returned no text content block`);
  return JSON.parse(block.text);
}

async function poll(fn, timeoutMs = 15000, intervalMs = 500) {
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
// Browser
// ---------------------------------------------------------------------------

let browserChild = null;
const browserOutput = [];

function captureStreams(child) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) browserOutput.push(line.trim());
    });
  }
  child.on('error', (err) => browserOutput.push(`spawn error: ${err.message}`));
}

function launchChrome(binary, { headless, xvfb }) {
  const chromeArgs = [
    ...(headless ? ['--headless=new'] : []),
    `--load-extension=${EXTENSION_DIR}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--enable-logging=stderr',
    'about:blank'
  ];
  const cmd = xvfb ? 'xvfb-run' : binary;
  const args = xvfb ? ['-a', binary, ...chromeArgs] : chromeArgs;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  captureStreams(child);
  return child;
}

/**
 * Firefox cannot be handed an unpacked extension on the command line, so the
 * add-on goes in over the remote debugging protocol, exactly as web-ext does.
 * HOME is redirected at the browser process: Firefox resolves
 * $HOME/.mozilla/native-messaging-hosts/ from the environment, and this run
 * must find the throwaway manifest rather than anything the user installed.
 */
async function startFirefox(binary, { xvfb }) {
  const rdpPort = await freePort();
  writeFirefoxProfile(PROFILE_DIR);
  console.log(`Launching Firefox ${xvfb ? 'headed under xvfb-run' : 'with --headless'} (RDP on ${rdpPort}, HOME=${FIREFOX_HOME}) ...`);
  browserChild = launchFirefox(binary, {
    profileDir: PROFILE_DIR,
    rdpPort,
    xvfb,
    env: { HOME: FIREFOX_HOME }
  });
  captureStreams(browserChild);
  const addon = await installTemporaryAddon(rdpPort, EXTENSION_DIR);
  const id = addon && addon.id ? addon.id : JSON.stringify(addon);
  console.log(`Temporary add-on installed: ${id}`);
  record(
    'Firefox installs extension/ as a temporary add-on under the pinned gecko id',
    id === 'browserbuddy@localhost',
    `id=${id}`
  );
  return browserChild;
}

async function stopBrowser() {
  if (!browserChild || browserChild.exitCode !== null) return;
  const child = browserChild;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  if (await Promise.race([exited.then(() => false), sleep(5000).then(() => true)])) {
    signal('SIGKILL');
    await Promise.race([exited, sleep(3000)]);
  }
  await sleep(1000);
  browserChild = null;
}

/**
 * The host writes mcp-endpoint.json only after the browser spawned it.
 * readEndpointFile returns null while there is no live endpoint (absent file,
 * or one left behind by a host that is gone), so polling it is exactly right.
 */
async function waitForEndpointFile(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const parsed = readEndpointFile(DATA_DIR);
      if (parsed && parsed.url && parsed.token) return parsed;
    } catch {
      /* half-written or malformed; the writer renames atomically, so retry */
    }
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function runChecks(client, endpoint, pageUrl) {
  const state = await callJson(client, 'browser_state');
  record('browser_state.connected === true over the native pipe', state.connected === true, `connected=${state.connected}`);

  const tabs = await callJson(client, 'browser_tabs');
  record(
    'browser_tabs round-trips host -> native pipe -> extension',
    Array.isArray(tabs.tabs) && tabs.tabs.length > 0,
    `${tabs.tabs?.length ?? 0} tabs`
  );

  let tabId = null;
  try {
    const opened = await callJson(client, 'browser_open_tab', { url: pageUrl });
    tabId = opened.tabId;
    record('browser_open_tab returns a tabId', typeof tabId === 'number', `tabId=${JSON.stringify(tabId)}`);
  } catch (err) {
    record('browser_open_tab returns a tabId', false, err.message);
    return;
  }

  const read = await poll(async () => {
    const r = await callJson(client, 'browser_read', { mode: 'text', tabId });
    const text = JSON.stringify(r);
    return { ok: text.includes('native messaging round trip'), detail: `payload length=${text.length}` };
  });
  record('browser_read reaches the content script and returns page text', read.ok, read.detail);

  const pageState = await poll(async () => {
    const r = await callJson(client, 'browser_page_state', { tabId });
    return { ok: typeof r.readyState === 'string' && r.readyState.length > 0, detail: `readyState=${r.readyState}` };
  });
  record('browser_page_state answers through the pipe', pageState.ok, pageState.detail);

  try {
    const evaled = await callJson(client, 'browser_eval', { code: '6 * 7', tabId });
    record('browser_eval runs in the page main world', evaled.result === 42, `result=${JSON.stringify(evaled.result)}`);
  } catch (err) {
    record('browser_eval runs in the page main world', false, err.message);
  }

  try {
    await callJson(client, 'browser_fill', { selector: '#field', value: 'typed by the agent', tabId });
    const after = await callJson(client, 'browser_eval', { code: "document.getElementById('field').value", tabId });
    record('browser_fill mutates the live DOM', after.result === 'typed by the agent', `field=${JSON.stringify(after.result)}`);
  } catch (err) {
    record('browser_fill mutates the live DOM', false, err.message);
  }

  // Firefox MV3 never treats granted host permissions as capture permission, so
  // a gesture-less screenshot must fail loudly and name the workaround. That is
  // the correct behaviour there, and it is asserted rather than skipped.
  if (BROWSER === 'firefox') {
    try {
      const shot = await callTool(client, 'browser_screenshot', { tabId });
      const text = (shot.content ?? []).map((c) => c.text ?? '').join(' ');
      record(
        'browser_screenshot hard-errors on Firefox (activeTab gesture required)',
        shot.isError === true && /activeTab/i.test(text),
        `isError=${shot.isError} message=${text.slice(0, 100)}`
      );
    } catch (err) {
      record('browser_screenshot hard-errors on Firefox (activeTab gesture required)', false, err.message);
    }
  } else {
    try {
      const shot = await callTool(client, 'browser_screenshot', { tabId });
      const img = (shot.content ?? []).find((c) => c.type === 'image');
      const len = img && typeof img.data === 'string' ? img.data.length : 0;
      record('browser_screenshot returns image bytes over HTTP', Boolean(img) && len > 1000, `base64 length=${len}`);
    } catch (err) {
      record('browser_screenshot returns image bytes over HTTP', false, err.message);
    }
  }

  // Events flow the other way down the same pipe.
  await sleep(1500);
  try {
    const observed = await callJson(client, 'browser_observe', { actor: 'agent', limit: 100 });
    record(
      'browser_observe sees events streamed up the native pipe',
      (observed.events ?? []).length > 0,
      `${observed.events?.length ?? 0} agent events, latestSeq=${observed.latestSeq}`
    );
  } catch (err) {
    record('browser_observe sees events streamed up the native pipe', false, err.message);
  }

  // The token is the whole access control story; prove it is enforced.
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    record('the live endpoint refuses an unauthenticated request', res.status === 401, `status=${res.status}`);
  } catch (err) {
    record('the live endpoint refuses an unauthenticated request', false, err.message);
  }

  // The user-facing half of discovery: with a host actually running, the CLI
  // must hand back a registration that names this endpoint. Run as a real
  // subprocess, because that is how a user runs it.
  try {
    const cc = spawnSync(process.execPath, [CLI_ENTRY, 'client-config', '--data-dir', DATA_DIR], {
      encoding: 'utf8',
      timeout: 20000
    });
    const printed = cc.stdout ?? '';
    record(
      'browserbuddy client-config prints a registration for the live endpoint',
      cc.status === 0 && printed.includes(endpoint.url) && printed.includes(endpoint.token),
      `exit=${cc.status} url=${printed.includes(endpoint.url)} token=${printed.includes(endpoint.token)}`
    );
  } catch (err) {
    record('browserbuddy client-config prints a registration for the live endpoint', false, err.message);
  }

  if (IDLE_PROBE_SEC > 0) {
    // Two different questions, and only the second one is about the host.
    // "Does a tool still work?" can be answered yes by a background context
    // that was torn down and respawned -- the endpoint identity is designed to
    // survive exactly that. Whether the HOST PROCESS survived is visible only
    // in the pid, because a teardown kills it and the respawn is a new one.
    console.log(`\nIdling ${IDLE_PROBE_SEC}s to probe background-context lifetime ...`);
    const pidBefore = endpoint.pid;
    await sleep(IDLE_PROBE_SEC * 1000);
    try {
      const afterIdle = await callJson(client, 'browser_tabs');
      record(
        `the native port survives ${IDLE_PROBE_SEC}s of idleness`,
        Array.isArray(afterIdle.tabs),
        `${afterIdle.tabs.length} tabs after idle`
      );
    } catch (err) {
      record(`the native port survives ${IDLE_PROBE_SEC}s of idleness`, false, err.message);
    }
    const after = readEndpointFile(DATA_DIR);
    record(
      `the same host process is still serving after ${IDLE_PROBE_SEC}s (no teardown/respawn)`,
      Boolean(after) && after.pid === pidBefore,
      after ? `pid ${pidBefore} -> ${after.pid}, url ${after.url}` : 'no live endpoint after idle'
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function tail(lines, n, label) {
  if (lines.length === 0) return `  (no ${label} output)`;
  return lines.slice(-n).map((l) => `  ${l}`).join('\n');
}

function summarize() {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log('\n============ NATIVE-MESSAGING SPIKE SUMMARY ============');
  for (const r of results) console.log(`${(r.ok ? 'PASS' : 'FAIL').padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  if (notes.length > 0) {
    console.log('--------------------------------------------------------');
    for (const n of notes) console.log(`NOTE  ${n}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('--------------------------------------------------------');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log('========================================================');
  return failed.length === 0;
}

/**
 * Negative proof of the no-fallback rule: with no host manifest installed the
 * browser cannot spawn the host, and the extension must say so precisely
 * rather than quietly dialling the old WebSocket hub.
 */
async function hardErrorProbe(binary) {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Launching Chromium with NO host manifest installed ...');

  browserChild = launchChrome(binary, { headless: true, xvfb: false });
  const endpoint = await waitForEndpointFile(20000);
  record('no host manifest means no endpoint file (the host was never spawned)', endpoint === null, endpoint ? endpoint.url : 'none appeared');

  const complaint = browserOutput.find((l) => l.includes('could not start its native messaging host'));
  record('the extension reports a precise, actionable error', Boolean(complaint), complaint ? complaint.slice(0, 160) : 'no complaint in the browser log');
  // The message is multi-line, and the browser log splits it across captured
  // lines, so match against the whole log rather than one line.
  const log = browserOutput.join('\n');
  record(
    'the error names the host and both expected manifest paths',
    log.includes(HOST_NAME) && log.includes('NativeMessagingHosts') && log.includes('native-messaging-hosts'),
    `host name=${log.includes(HOST_NAME)} chrome path=${log.includes('NativeMessagingHosts')} firefox path=${log.includes('native-messaging-hosts')}`
  );

  // The dormant WebSocket wire must not have been used behind our back.
  const wsAttempt = browserOutput.some((l) => l.includes('ws://127.0.0.1:8590'));
  record('no silent fallback to the WebSocket wire', !wsAttempt, wsAttempt ? 'the extension dialled the old hub' : 'no WebSocket attempt observed');

  await stopBrowser();
  if (!KEEP) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return summarize();
}

/** Chromium: headless first, then headed under xvfb-run if no host appeared. */
async function connectViaChromium(binary) {
  let endpoint = null;
  if (!HEADED_ONLY) {
    console.log('Launching Chromium with --headless=new ...');
    browserChild = launchChrome(binary, { headless: true, xvfb: false });
    endpoint = await waitForEndpointFile(ENDPOINT_TIMEOUT_MS);
  }
  if (!endpoint && which('xvfb-run')) {
    if (!HEADED_ONLY) {
      console.log('No endpoint file under --headless=new; retrying headed under xvfb-run.');
      await stopBrowser();
      fs.rmSync(path.join(PROFILE_DIR, 'Default'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } else {
      console.log('Launching Chromium headed under xvfb-run ...');
    }
    browserChild = launchChrome(binary, { headless: false, xvfb: true });
    endpoint = await waitForEndpointFile(ENDPOINT_TIMEOUT_MS);
  }
  return endpoint;
}

/** Firefox: one launch, headed under Xvfb when available, add-on over RDP. */
async function connectViaFirefox(binary) {
  await startFirefox(binary, { xvfb: which('xvfb-run') !== null });
  return waitForEndpointFile(ENDPOINT_TIMEOUT_MS);
}

async function main() {
  const candidates = BROWSER === 'firefox' ? FIREFOX_CANDIDATES : CHROME_CANDIDATES;
  const browser = findBrowser(candidates);
  if (!browser) {
    console.error(`No ${BROWSER} binary found. Tried: ${candidates.join(', ')}.`);
    process.exit(2);
  }
  const version = spawnSync(browser.path, ['--version'], { encoding: 'utf8', timeout: 15000 });
  console.log(`Browser: ${browser.path} (${((version.stdout || '') + (version.stderr || '')).trim().split('\n')[0]})`);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  if (HARD_ERROR_PROBE) {
    // Chromium-only, and refused rather than faked elsewhere: the probe reads
    // the extension's own error out of the browser's stderr, and Firefox keeps
    // extension console output inside the Browser Console instead.
    if (BROWSER !== 'chromium') {
      console.error('--hard-error-probe is Chromium-only: Firefox does not surface extension console output on stderr, so the assertion could not be made honestly.');
      process.exit(2);
    }
    process.exit((await hardErrorProbe(browser.path)) ? 0 : 1);
  }

  for (const dir of [PROFILE_DIR, DATA_DIR, FIREFOX_HOME]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.mkdirSync(dir, { recursive: true });
  }

  const install =
    BROWSER === 'firefox'
      ? installNativeHost({ browser: 'firefox', homeDir: FIREFOX_HOME, dataDir: DATA_DIR })
      : installNativeHost({ browser: 'chrome', profileDir: PROFILE_DIR, dataDir: DATA_DIR });
  console.log(`Installed host "${HOST_NAME}" for extension id ${install.extensionId}`);
  console.log(`  manifest: ${install.manifestPath}`);
  console.log(`  launcher: ${install.launcherPath}`);
  note(`host manifest written only inside the throwaway ${BROWSER === 'firefox' ? 'HOME' : 'profile'} (${install.manifestPath}); no path outside the repo was touched`);

  const pageServer = await startPageServer();
  console.log(`Test page served at ${pageServer.url}`);

  const sdk = await loadSdk();
  let client = null;
  let transport = null;
  let ok = false;

  try {
    const endpoint =
      BROWSER === 'firefox' ? await connectViaFirefox(browser.path) : await connectViaChromium(browser.path);

    record('the browser spawned the host, which wrote mcp-endpoint.json', Boolean(endpoint), endpoint ? endpoint.url : 'no endpoint file appeared');
    if (!endpoint) {
      console.error('\n--- Browser output (tail) ---\n' + tail(browserOutput, 40, 'browser'));
      return;
    }
    record('the host bound an ephemeral loopback port', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint.url) && Number(new URL(endpoint.url).port) !== 8590, endpoint.url);
    record('the endpoint file carries a bearer token', typeof endpoint.token === 'string' && endpoint.token.length >= 32, `token length=${endpoint.token?.length ?? 0}`);

    transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
    });
    client = new sdk.Client({ name: 'browserbuddy-spike-nativemsg', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    record('an MCP SDK client connects over Streamable HTTP with the token', true, 'initialize succeeded');

    const tools = await client.listTools();
    record('the host advertises the full tool surface', tools.tools.length === 25, `${tools.tools.length} tools`);

    await runChecks(client, endpoint, pageServer.url);
  } catch (err) {
    record('spike harness', false, err.stack || err.message);
    console.error('\n--- Browser output (tail) ---\n' + tail(browserOutput, 40, 'browser'));
  } finally {
    try {
      if (transport) await transport.close();
    } catch {
      /* already closed */
    }
    await stopBrowser();
    await pageServer.close();
    // Closing the browser closes the pipe, which must stop the host.
    await sleep(3000);
    const endpointGone = !fs.existsSync(path.join(DATA_DIR, ENDPOINT_FILENAME));
    record('the host exits and removes its endpoint file when the browser closes the pipe', endpointGone, endpointGone ? 'endpoint file removed' : 'endpoint file still present');

    for (const line of browserOutput.filter((l) => l.includes('[browserbuddy]'))) {
      note(`browser log: ${line.slice(0, 200)}`);
    }

    if (!KEEP) {
      for (const dir of [PROFILE_DIR, DATA_DIR, FIREFOX_HOME]) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    } else {
      console.log(`\n--keep: left ${PROFILE_DIR}, ${DATA_DIR} and ${FIREFOX_HOME} in place.`);
    }
    ok = summarize();
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});

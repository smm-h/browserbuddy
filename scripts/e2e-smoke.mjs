#!/usr/bin/env node
/**
 * BrowserBuddy end-to-end smoke test.
 *
 * Drives the real product: spawns the MCP stdio server, launches a real Chrome
 * with extension/ loaded, and exercises the MCP tools against live pages.
 *
 * Runnable from any cwd; all paths are resolved from this file's location.
 *
 *   node scripts/e2e-smoke.mjs [--keep] [--headed] [--port N]
 *
 *   --keep    leave the temp profile/data dirs in place for inspection
 *   --headed  skip --headless=new and go straight to the xvfb-run path
 *   --port    hub port to use (default 8590)
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

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const HEADED_ONLY = argv.includes('--headed');
const PORT = (() => {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : 8590;
})();

const CONNECT_TIMEOUT_MS = 30000;
const LOAD_POLL_MS = 10000;

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

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    const found = which(candidate);
    if (found) return { name: candidate, path: found };
  }
  return null;
}

function chromeVersion(binary) {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || 'unknown';
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
// MCP client (SDK is installed under server/node_modules)
// ---------------------------------------------------------------------------

async function loadSdk() {
  const req = createRequire(path.join(ROOT, 'server', 'package.json'));
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
    args: [SERVER_ENTRY, '--data-dir', DATA_DIR, '--port', String(PORT)],
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
// Chrome
// ---------------------------------------------------------------------------

let chromeChild = null;
const chromeOutput = [];

function launchChrome(binary, { headless, xvfb }) {
  const chromeArgs = [
    ...(headless ? ['--headless=new'] : []),
    `--load-extension=${EXTENSION_DIR}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ];
  const cmd = xvfb ? 'xvfb-run' : binary;
  const args = xvfb ? ['-a', binary, ...chromeArgs] : chromeArgs;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) chromeOutput.push(line.trim());
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  child.on('error', (err) => chromeOutput.push(`spawn error: ${err.message}`));
  return child;
}

async function stopChrome() {
  if (!chromeChild || chromeChild.exitCode !== null) return;
  const child = chromeChild;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(3000)]);
  }
  chromeChild = null;
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

  // --- screenshot -----------------------------------------------------------
  try {
    const shot = await callTool(client, 'browser_screenshot', { tabId });
    const img = (shot.content ?? []).find((c) => c.type === 'image');
    const len = img && typeof img.data === 'string' ? img.data.length : 0;
    record('browser_screenshot returns image base64 > 1000 chars', Boolean(img) && len > 1000, `base64 length=${len}`);
  } catch (err) {
    record('browser_screenshot returns image base64 > 1000 chars', false, err.message);
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

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const chrome = findChrome();
  if (!chrome) {
    console.error(
      `No Chrome/Chromium binary found. Tried: ${CHROME_CANDIDATES.join(', ')}.\n` +
        'Install one of them to run this smoke test. Nothing was installed automatically.'
    );
    process.exit(2);
  }
  console.log(`Chrome binary: ${chrome.path} (${chromeVersion(chrome.path)})`);

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
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const sdk = await loadSdk();
  let client = null;
  let transport = null;
  let ok = false;

  try {
    ({ client, transport } = await startMcp(sdk));
    console.log(`MCP server started (data-dir ${DATA_DIR}, port ${PORT}).`);

    let state = null;
    if (!HEADED_ONLY) {
      console.log('Launching Chrome with --headless=new ...');
      chromeChild = launchChrome(chrome.path, { headless: true, xvfb: false });
      state = await waitForConnected(client, CONNECT_TIMEOUT_MS);
    }

    if (!state || state.connected !== true) {
      const xvfb = which('xvfb-run');
      if (xvfb) {
        if (!HEADED_ONLY) {
          console.log('Extension did not connect under --headless=new; retrying headed under xvfb-run.');
          await stopChrome();
          fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
        } else {
          console.log('Launching Chrome headed under xvfb-run ...');
        }
        chromeChild = launchChrome(chrome.path, { headless: false, xvfb: true });
        state = await waitForConnected(client, CONNECT_TIMEOUT_MS);
      }
    }

    if (!state || state.connected !== true) {
      fatal('extension connects to hub', `browser_state never reported connected. last=${JSON.stringify(state)}`);
      console.error('\n--- Chrome output (tail) ---\n' + tail(chromeOutput, 30, 'chrome'));
      console.error('\n--- MCP server stderr (tail) ---\n' + tail(serverStderr, 20, 'server'));
    } else {
      record('extension connects to hub', true, `connected after handshake`);
      await runChecks(client, state);
    }
  } catch (err) {
    fatal('smoke harness', err.stack || err.message);
    console.error('\n--- Chrome output (tail) ---\n' + tail(chromeOutput, 30, 'chrome'));
    console.error('\n--- MCP server stderr (tail) ---\n' + tail(serverStderr, 20, 'server'));
  } finally {
    await stopChrome();
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
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } else {
      console.log(`\n--keep: left ${PROFILE_DIR} and ${DATA_DIR} in place.`);
    }
    ok = summarize();
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});

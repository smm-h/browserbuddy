import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_ROOT } from './helpers.js';

const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const TRANSPORT_SRC = path.join(REPO_ROOT, 'extension', 'transport-native.js');
const BACKGROUND_SRC = path.join(REPO_ROOT, 'extension', 'background.js');

/**
 * extension/transport-native.js is a plain script with no imports, so it runs
 * in a vm context with a stand-in for the browser API. That makes the transport
 * itself testable.
 *
 * The top-level `const` is lexical, not a property of the context's global, so
 * the loader publishes it explicitly.
 */
function loadTransport(api) {
  const code = `${fs.readFileSync(TRANSPORT_SRC, 'utf8')}\nglobalThis.BBNativeTransport = BBNativeTransport;\n`;
  const context = vm.createContext({ browser: api, console });
  vm.runInContext(code, context);
  return context.BBNativeTransport;
}

/** A listener registration point the background can attach to and we ignore. */
function noopEvent() {
  return { addListener() {} };
}

/** Every extension API background.js touches while loading and while dispatching. */
function fakeBrowserApi(port) {
  return {
    runtime: {
      connectNative: () => port,
      lastError: null,
      onMessage: noopEvent(),
      onStartup: noopEvent(),
      onInstalled: noopEvent()
    },
    tabs: {
      onCreated: noopEvent(),
      onRemoved: noopEvent(),
      onActivated: noopEvent(),
      query: () => Promise.resolve([{ id: 1, active: true }]),
      get: () => Promise.resolve({ id: 1, url: null, title: null }),
      sendMessage: () => Promise.resolve({ ok: true, result: {} })
    },
    webNavigation: { onCommitted: noopEvent(), onCompleted: noopEvent() },
    downloads: { onCreated: noopEvent() },
    windows: { onFocusChanged: noopEvent(), WINDOW_ID_NONE: -1 },
    alarms: { create() {}, onAlarm: noopEvent() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } }
  };
}

/**
 * Loads transport-native.js and background.js into one vm context, exactly as
 * the browser loads them into one global scope, and lets the boot sequence
 * (restoreBuffer().then(connect)) settle. Returns the context, whose top-level
 * function declarations are global properties.
 *
 * Timers are stubbed out: the keepalive interval background.js starts on
 * connect would otherwise pin the host process's event loop open forever.
 */
async function loadBackground(port) {
  const code = [
    fs.readFileSync(TRANSPORT_SRC, 'utf8'),
    fs.readFileSync(BACKGROUND_SRC, 'utf8'),
    'globalThis.handleRpc = handleRpc;',
    'globalThis.dispatchRpc = dispatchRpc;'
  ].join('\n');
  const context = vm.createContext({
    browser: fakeBrowserApi(port),
    console,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  vm.runInContext(code, context);
  await new Promise((resolve) => setImmediate(resolve));
  return context;
}

/**
 * Drives one rpc frame through the real handleRpc and returns its rpc_result.
 * The frame is round-tripped through JSON because objects built inside the vm
 * context carry that context's prototypes, which deepStrictEqual rejects --
 * and JSON is exactly what the real pipe would carry anyway.
 */
async function callRpc(context, port, msg) {
  const before = port.sent.length;
  context.handleRpc(msg);
  await new Promise((resolve) => setImmediate(resolve));
  const frame = port.sent.slice(before).find((m) => m.kind === 'rpc_result');
  return frame === undefined ? undefined : JSON.parse(JSON.stringify(frame));
}

function fakePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    sent: [],
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage(msg) {
      this.sent.push(msg);
    },
    disconnect() {},
    emitMessage(msg) {
      for (const fn of listeners.message) fn(msg);
    },
    emitDisconnect() {
      for (const fn of listeners.disconnect) fn();
    }
  };
}

function recorder() {
  const calls = { open: 0, messages: [], spawnFailures: [], closes: [] };
  return {
    calls,
    handlers: {
      onOpen: () => {
        calls.open += 1;
      },
      onMessage: (m) => calls.messages.push(m),
      onSpawnFailure: (m) => calls.spawnFailures.push(m),
      onClose: (d) => calls.closes.push(d)
    }
  };
}

describe('native transport disconnect diagnostics', () => {
  let port;

  beforeEach(() => {
    port = fakePort();
  });

  test('connectNative throwing is a spawn failure with the install instructions', () => {
    const transport = loadTransport({
      runtime: {
        connectNative: () => {
          throw new Error('Access to the specified native messaging host is forbidden.');
        }
      }
    });
    const rec = recorder();
    assert.equal(transport.connect(rec.handlers), false);
    assert.equal(rec.calls.spawnFailures.length, 1);
    assert.match(rec.calls.spawnFailures[0], /could not start its native messaging host/);
    assert.match(rec.calls.spawnFailures[0], /browserbuddy install-host --browser <chrome\|firefox>/);
    assert.equal(rec.calls.closes.length, 0);
  });

  test('a port that dies before the host ever speaks is a spawn failure', () => {
    const transport = loadTransport({
      runtime: {
        connectNative: () => port,
        lastError: { message: 'Specified native messaging host not found.' }
      }
    });
    const rec = recorder();
    assert.equal(transport.connect(rec.handlers), true);
    port.emitDisconnect();

    assert.equal(rec.calls.spawnFailures.length, 1);
    assert.match(rec.calls.spawnFailures[0], /Specified native messaging host not found/);
    assert.match(rec.calls.spawnFailures[0], /Install the host manifest/);
    assert.deepEqual(rec.calls.closes, ['Specified native messaging host not found.']);
    assert.equal(transport.isOpen(), false);
  });

  test('a disconnect after the host has spoken is neutral, not an install error', () => {
    // The routine case: browser shutdown, background teardown, host crash.
    // Shouting "install the manifest" here would train the user to ignore it.
    const transport = loadTransport({
      runtime: { connectNative: () => port, lastError: null }
    });
    const rec = recorder();
    transport.connect(rec.handlers);
    port.emitMessage({ kind: 'hello_ack', serverVersion: '0.1.0' });
    port.emitDisconnect();

    assert.deepEqual(rec.calls.messages, [{ kind: 'hello_ack', serverVersion: '0.1.0' }]);
    assert.equal(rec.calls.spawnFailures.length, 0, 'a clean disconnect is not a spawn failure');
    assert.equal(rec.calls.closes.length, 1);
    assert.match(rec.calls.closes[0], /host exited or the pipe was closed/);
  });

  test('send after a disconnect reports the close instead of throwing', () => {
    const transport = loadTransport({ runtime: { connectNative: () => port, lastError: null } });
    const rec = recorder();
    transport.connect(rec.handlers);
    assert.equal(transport.send({ kind: 'ping' }), true);
    port.emitDisconnect();
    assert.equal(transport.send({ kind: 'ping' }), false);
    assert.deepEqual(port.sent, [{ kind: 'ping' }]);
  });
});

describe('background rpc dispatch', () => {
  let port;
  let context;

  beforeEach(async () => {
    port = fakePort();
    context = await loadBackground(port);
  });

  test('the extension announces itself once the pipe is up', () => {
    const hellos = port.sent.filter((m) => m.kind === 'hello').map((m) => JSON.parse(JSON.stringify(m)));
    assert.deepEqual(hellos, [
      { kind: 'hello', role: 'extension', version: '0.1.0', transport: 'native-messaging' }
    ]);
  });

  test('an unimplemented method is a hard error naming the method', async () => {
    const result = await callRpc(context, port, { kind: 'rpc', id: 42, method: 'frobnicate', params: {} });
    assert.deepEqual(result, {
      kind: 'rpc_result',
      id: 42,
      ok: false,
      error: 'Unknown RPC method: frobnicate'
    });
  });

  test('an inherited Object key is an unknown method, not a relay to the content script', async () => {
    // A lookup table built as an object literal would answer true for these and
    // send them to the page, producing a confusing content-script error.
    for (const method of ['toString', 'constructor', 'hasOwnProperty']) {
      const result = await callRpc(context, port, { kind: 'rpc', id: 1, method, params: {} });
      assert.equal(result.ok, false, `${method} must not be dispatched`);
      assert.equal(result.error, `Unknown RPC method: ${method}`);
    }
  });

  test('an implemented method still dispatches', async () => {
    const result = await callRpc(context, port, { kind: 'rpc', id: 9, method: 'getPageState', params: {} });
    assert.equal(result.ok, true);
  });
});

describe('background badge state', () => {
  const background = fs.readFileSync(BACKGROUND_SRC, 'utf8');

  test('a spawn failure survives the onClose that follows it', () => {
    // onClose lands microseconds after onSpawnFailure; clearing the badge there
    // would erase the only visible sign that the host manifest is missing.
    assert.match(background, /if \(lastTransportError !== null\) setBadgeError\(\);/);
    assert.match(background, /else setBadgeDisconnected\(detail\);/);
  });

  test('a clean disconnect gets a neutral tooltip, not the error badge', () => {
    assert.match(background, /function setBadgeDisconnected\(detail\)/);
    assert.match(background, /native host disconnected/);
  });

  test('the transport handler names match the transport contract', () => {
    const transport = fs.readFileSync(TRANSPORT_SRC, 'utf8');
    for (const name of ['onOpen', 'onMessage', 'onSpawnFailure', 'onClose']) {
      assert.ok(transport.includes(`handlers.${name}`), `transport-native.js must call handlers.${name}`);
      assert.ok(background.includes(`${name}:`), `background.js must provide ${name}`);
    }
  });
});

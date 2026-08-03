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
 * itself testable -- background.js is not (it binds extension APIs at the top
 * level), so the pieces that live there are asserted at the source.
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

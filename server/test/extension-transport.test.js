import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_ROOT } from './helpers.js';

const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const TRANSPORT_SRC = path.join(REPO_ROOT, 'extension', 'transport-native.js');
const BACKGROUND_SRC = path.join(REPO_ROOT, 'extension', 'background.js');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8')
);

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

/**
 * Every extension API background.js touches while loading and while dispatching.
 *
 * `hooks.listeners` (a plain object) turns the browser events into recording
 * registration points keyed by their API path, so a test can fire them the way
 * the browser would. `hooks.tabsGet` replaces tabs.get, which is what lets a
 * test hold the title fetch open while its clock runs.
 */
function fakeBrowserApi(port, hooks = {}) {
  const listeners = hooks.listeners;
  function event(name) {
    if (!listeners) return noopEvent();
    listeners[name] = [];
    return { addListener: (fn) => listeners[name].push(fn) };
  }
  return {
    runtime: {
      connectNative: () => port,
      getManifest: () => MANIFEST,
      lastError: null,
      onMessage: event('runtime.onMessage'),
      onStartup: noopEvent(),
      onInstalled: noopEvent()
    },
    tabs: {
      onCreated: event('tabs.onCreated'),
      onRemoved: event('tabs.onRemoved'),
      onActivated: event('tabs.onActivated'),
      query: () => Promise.resolve([{ id: 1, active: true }]),
      get: hooks.tabsGet || (() => Promise.resolve({ id: 1, url: null, title: null })),
      update: (tabId) => Promise.resolve({ id: tabId, windowId: 10 }),
      sendMessage: () => Promise.resolve({ ok: true, result: {} })
    },
    webNavigation: {
      onCommitted: event('webNavigation.onCommitted'),
      onCompleted: event('webNavigation.onCompleted')
    },
    downloads: { onCreated: event('downloads.onCreated') },
    windows: {
      onFocusChanged: event('windows.onFocusChanged'),
      update: () => Promise.resolve({}),
      WINDOW_ID_NONE: -1
    },
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
async function loadBackground(port, hooks = {}) {
  const code = [
    fs.readFileSync(TRANSPORT_SRC, 'utf8'),
    fs.readFileSync(BACKGROUND_SRC, 'utf8'),
    'globalThis.handleRpc = handleRpc;',
    'globalThis.dispatchRpc = dispatchRpc;'
  ].join('\n');
  const context = vm.createContext({
    browser: fakeBrowserApi(port, hooks),
    console,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    // Attribution is entirely a function of the clock, so tests that exercise
    // it need to own the clock. Date.now is all background.js reads.
    ...(hooks.clock ? { Date: { now: () => hooks.clock.now } } : {})
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
      { kind: 'hello', role: 'extension', version: MANIFEST.version, transport: 'native-messaging' }
    ]);
    assert.equal(typeof MANIFEST.version, 'string', 'the handshake version comes from the manifest');
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

describe('background actor attribution', () => {
  /** Fires one browser event into every listener background.js registered. */
  function fire(listeners, name, ...args) {
    const fns = listeners[name];
    assert.ok(fns && fns.length > 0, `background.js registered no listener for ${name}`);
    for (const fn of fns) fn(...args);
  }

  /** Lets the promise chains inside the background settle. */
  function settle() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function events(port) {
    return port.sent.filter((m) => m.kind === 'event').map((m) => m.event);
  }

  function eventsOfType(port, type) {
    return events(port).filter((e) => e.type === type);
  }

  test('page_loaded stays the agent\'s when the title fetch outlives the agent window', async () => {
    // The actor must be decided when webNavigation.onCompleted fires, not when
    // the tabs.get() that only fetches the title finally answers: an async hop
    // before the decision moves attribution later in time than the event.
    const clock = { now: 1000 };
    const listeners = {};
    let resolveGet = null;
    const port = fakePort();
    const context = await loadBackground(port, {
      clock,
      listeners,
      tabsGet: () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        })
    });

    await context.dispatchRpc('navigate', { tabId: 7, url: 'https://slow.example/' });
    clock.now = 2400; // still inside the 1500 ms window opened at 1000

    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 7,
      url: 'https://slow.example/'
    });
    clock.now = 9000; // the window expires while the title fetch is in flight
    resolveGet({ id: 7, url: 'https://slow.example/', title: 'Slow' });
    await settle();

    const loaded = eventsOfType(port, 'page_loaded');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].actor, 'agent');
  });

  test('tab_activated stays the agent\'s when the title fetch outlives the window', async () => {
    const clock = { now: 1000 };
    const listeners = {};
    let resolveGet = null;
    const port = fakePort();
    const context = await loadBackground(port, {
      clock,
      listeners,
      tabsGet: () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        })
    });

    await context.dispatchRpc('activateTab', { tabId: 7 });
    clock.now = 2400;

    fire(listeners, 'tabs.onActivated', { tabId: 7, windowId: 10 });
    clock.now = 9000;
    resolveGet({ id: 7, url: 'https://a.example/', title: 'A' });
    await settle();

    const activated = eventsOfType(port, 'tab_activated');
    assert.equal(activated.length, 1);
    assert.equal(activated[0].actor, 'agent');
  });

  test('a slow load inherits the actor of the navigation that started it', async () => {
    // A cross-origin load can take many seconds. The commit is inside the agent
    // window and the completion is not, but both belong to one agent-caused
    // navigation, so page_loaded must not flip to the user.
    const clock = { now: 1000 };
    const listeners = {};
    const port = fakePort();
    const context = await loadBackground(port, { clock, listeners });

    await context.dispatchRpc('navigate', { tabId: 7, url: 'https://slow.example/' });

    clock.now = 1100;
    fire(listeners, 'webNavigation.onCommitted', {
      frameId: 0,
      tabId: 7,
      url: 'https://slow.example/',
      transitionType: 'link'
    });

    clock.now = 9000; // far outside the window opened by the RPC
    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 7,
      url: 'https://slow.example/'
    });
    await settle();

    assert.equal(eventsOfType(port, 'navigation')[0].actor, 'agent');
    assert.equal(eventsOfType(port, 'page_loaded')[0].actor, 'agent');
  });

  test('a redirect chain keeps every commit of one agent navigation on the agent', async () => {
    const clock = { now: 1000 };
    const listeners = {};
    const port = fakePort();
    const context = await loadBackground(port, { clock, listeners });

    await context.dispatchRpc('navigate', { tabId: 7, url: 'https://hop1.example/' });

    clock.now = 2000;
    fire(listeners, 'webNavigation.onCommitted', {
      frameId: 0,
      tabId: 7,
      url: 'https://hop1.example/',
      transitionType: 'link'
    });
    clock.now = 3200; // past the original window, inside the one the commit renewed
    fire(listeners, 'webNavigation.onCommitted', {
      frameId: 0,
      tabId: 7,
      url: 'https://hop2.example/',
      transitionType: 'link'
    });
    clock.now = 20000;
    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 7,
      url: 'https://hop2.example/'
    });
    await settle();

    for (const e of eventsOfType(port, 'navigation')) assert.equal(e.actor, 'agent');
    assert.equal(eventsOfType(port, 'page_loaded')[0].actor, 'agent');
  });

  test('a user navigation after an agent load completes is the user\'s', async () => {
    // The boundary the chaining must not swallow: carrying an agent load through
    // to its completion must not carry the next, genuinely human navigation too.
    const clock = { now: 1000 };
    const listeners = {};
    const port = fakePort();
    const context = await loadBackground(port, { clock, listeners });

    await context.dispatchRpc('navigate', { tabId: 7, url: 'https://slow.example/' });
    clock.now = 1100;
    fire(listeners, 'webNavigation.onCommitted', {
      frameId: 0,
      tabId: 7,
      url: 'https://slow.example/',
      transitionType: 'link'
    });
    clock.now = 9000;
    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 7,
      url: 'https://slow.example/'
    });
    await settle();

    clock.now = 30000; // the human clicks a link long after the agent's load ended
    fire(listeners, 'webNavigation.onCommitted', {
      frameId: 0,
      tabId: 7,
      url: 'https://human.example/',
      transitionType: 'link'
    });
    clock.now = 45000;
    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 7,
      url: 'https://human.example/'
    });
    await settle();

    const navs = eventsOfType(port, 'navigation');
    const loads = eventsOfType(port, 'page_loaded');
    assert.equal(navs.length, 2);
    assert.equal(loads.length, 2);
    assert.equal(navs[1].actor, 'user', 'the human navigation is not the agent\'s');
    assert.equal(loads[1].actor, 'user', 'the human load is not the agent\'s');
  });

  test('a user load with no preceding commit is still the user\'s', async () => {
    const clock = { now: 1000 };
    const listeners = {};
    const port = fakePort();
    await loadBackground(port, { clock, listeners });

    fire(listeners, 'webNavigation.onCompleted', {
      frameId: 0,
      tabId: 3,
      url: 'https://human.example/'
    });
    await settle();

    assert.equal(eventsOfType(port, 'page_loaded')[0].actor, 'user');
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

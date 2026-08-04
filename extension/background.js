'use strict';

// BrowserBuddy MV3 background script. Runs as a service worker on Chrome and
// as an event page on Firefox (the manifest declares both entry points; each
// browser picks its own).
// Responsibilities:
//   1. Maintain a WebSocket to the local hub (ws://127.0.0.1:8590/ws).
//   2. Observe browser-level activity and stream it as events.
//   3. Execute RPCs from the hub, either directly (extension APIs) or by
//      relaying to the content script in the target tab's top frame.
//
// MV3 note: every extension-API listener in this file is registered
// synchronously at the top level. Listeners registered inside async callbacks
// are lost when the background context is torn down and restarted.

// transport-native.js shares this global scope. Chrome's service worker pulls
// it in here; Firefox's event page already loaded it from background.scripts,
// where importScripts does not exist.
if (typeof importScripts === 'function') {
  importScripts('transport-native.js');
}

// Which wire this build talks. Chosen at load time, never at runtime: there is
// no "try native, fall back to WebSocket" cascade -- a transport that cannot
// connect reports a hard error and retries itself, nothing else.
//   'native'    -- ext.runtime.connectNative(): the browser spawns the host
//                  process, which serves MCP over loopback HTTP. Default.
//   'websocket' -- the 0.1.0 wire, kept working for the legacy smoke harness,
//                  which rewrites this constant when it stages the extension.
const TRANSPORT = 'native';

// Firefox's promise-based API surface is `browser` (its `chrome` namespace is
// callback-based); Chrome's `chrome` is promise-based in MV3. Binding one name
// gives the rest of the file the same promise-returning API on both browsers.
// The binding must not be called `chrome`: redeclaring that name at the top
// level of a Chrome service worker kills the whole script.
const ext = typeof browser !== 'undefined' ? browser : chrome;

const WS_URL = 'ws://127.0.0.1:8590/ws';
// The manifest is the extension's own single source of version truth: there is
// no build step that could stamp a literal here, so reading it back keeps the
// handshake honest no matter what manifest.json says.
const VERSION = ext.runtime.getManifest().version;
const BACKOFF_MS = [1000, 2000, 5000, 10000];
const PING_INTERVAL_MS = 20000;
const MAX_BUFFER = 500;
const AGENT_TAG_WINDOW_MS = 1500;
const BUFFER_KEY = 'bbBuffer';

// Ceiling on a single RPC result travelling extension -> host. The browser
// itself allows far more in this direction, but an unbounded result is still a
// bad frame to emit: it would stall the pipe for seconds and pin memory on
// both sides. Over the limit the RPC answers ok:false with the measured size,
// which fails one call instead of tearing the pipe (and the host) down.
const MAX_RPC_RESULT_BYTES = 64 * 1024 * 1024;

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** Throws the standard "too large" RPC error. `bytes` is the measured size. */
function assertResultSize(what, bytes) {
  if (bytes > MAX_RPC_RESULT_BYTES) {
    throw new Error(
      what +
        ' result too large (' +
        bytes +
        ' bytes, limit ' +
        Math.round(MAX_RPC_RESULT_BYTES / (1024 * 1024)) +
        'MB). Return a smaller value: narrow the expression, or read the page ' +
        'in pieces instead of serialising it all at once.'
    );
  }
}

let ws = null;
let backoffIndex = 0;
let reconnectTimer = null;
let pingTimer = null;
let persistTimer = null;

/** Events collected while disconnected, oldest first. */
let buffer = [];

/** tabId -> epoch ms until which background events for that tab are the agent's. */
const agentTabs = new Map();

/**
 * tabId -> actor of the navigation that most recently committed in that tab,
 * captured at commit time and consumed by that navigation's page_loaded.
 *
 * A cross-origin load can take many seconds, far longer than the 1500 ms agent
 * window. The commit and the completion are two halves of one navigation, so
 * the completion inherits the commit's actor instead of re-deciding on a clock
 * that has moved on. Each new commit replaces the entry, which is what keeps a
 * later human navigation out of the agent's chain.
 */
const pendingLoadActors = new Map();

/** Epoch ms until which a downloads.onCreated is attributed to the agent. */
let agentDownloadUntil = 0;

/**
 * Epoch ms until which a tabs.onCreated is attributed to the agent. tabs.create
 * fires onCreated before its promise resolves, so the tab cannot be marked by id
 * in time; this window covers the gap.
 */
let agentCreatingTabUntil = 0;

/**
 * Epoch ms until which a windows.onFocusChanged is attributed to the agent.
 * Window focus carries no tab id, so a global window is the only handle; it is
 * set immediately before any ext.windows.update({focused:true}) call.
 */
let agentFocusUntil = 0;

/** Last transport failure, surfaced through the badge tooltip and the console. */
let lastTransportError = null;

// ---------------------------------------------------------------------------
// Connection (transport-neutral entry points)
// ---------------------------------------------------------------------------

function isOpen() {
  return TRANSPORT === 'native' ? BBNativeTransport.isOpen() : wsIsOpen();
}

function send(obj) {
  return TRANSPORT === 'native' ? nativeSend(obj) : wsSend(obj);
}

function connect() {
  if (TRANSPORT === 'native') nativeConnect();
  else wsConnect();
}

// ---------------------------------------------------------------------------
// Native-messaging transport
// ---------------------------------------------------------------------------

function nativeConnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (BBNativeTransport.isOpen()) return;

  const started = BBNativeTransport.connect({
    onOpen: function () {
      backoffIndex = 0;
      lastTransportError = null;
      setBadge(true);
      send({ kind: 'hello', role: 'extension', version: VERSION, transport: 'native-messaging' });
      flushBuffer();
      startPing();
    },
    onMessage: handleHubMessage,
    onClose: function (detail) {
      stopPing();
      // A spawn failure must stay visible: onClose follows onSpawnFailure by
      // microseconds, and clearing the badge here would erase the only sign
      // the user gets that the host manifest is missing.
      if (lastTransportError !== null) setBadgeError();
      else setBadgeDisconnected(detail);
      scheduleReconnect();
    },
    onSpawnFailure: function (message) {
      lastTransportError = message;
      // Loud and actionable: a missing host manifest is the usual cause and
      // there is no other wire to quietly succeed on.
      console.error('[browserbuddy] ' + message);
      setBadgeError();
    }
  });
  if (!started) scheduleReconnect();
}

function nativeSend(obj) {
  return BBNativeTransport.send(obj);
}

function setBadgeError() {
  try {
    ext.action.setBadgeText({ text: '!' });
    ext.action.setBadgeBackgroundColor({ color: '#b42318' });
    ext.action.setTitle({ title: 'BrowserBuddy: ' + (lastTransportError || 'transport error') });
  } catch (e) {
    // The action API can be unavailable very early in worker startup.
  }
}

/**
 * The neutral state: the host was up and the pipe closed (browser shutdown,
 * background teardown, host crash). Nothing for the user to fix, so no error
 * badge -- just an honest tooltip while the reconnect ladder runs.
 */
function setBadgeDisconnected(detail) {
  try {
    ext.action.setBadgeText({ text: '' });
    ext.action.setTitle({
      title: 'BrowserBuddy: native host disconnected (' + (detail || 'pipe closed') + '); reconnecting.'
    });
  } catch (e) {
    // The action API can be unavailable very early in worker startup.
  }
}

// ---------------------------------------------------------------------------
// WebSocket transport (0.1.0 wire; only reached when TRANSPORT is 'websocket')
// ---------------------------------------------------------------------------

function wsIsOpen() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function setBadge(connected) {
  try {
    ext.action.setBadgeText({ text: connected ? '●' : '' });
    if (connected) {
      ext.action.setBadgeBackgroundColor({ color: '#1a7f37' });
      // Clears any error or disconnected tooltip left by a previous attempt.
      ext.action.setTitle({ title: 'BrowserBuddy: connected' });
    }
  } catch (e) {
    // The action API can be unavailable very early in worker startup.
  }
}

function wsConnect() {
  if (ws !== null && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = function () {
    backoffIndex = 0;
    setBadge(true);
    send({ kind: 'hello', role: 'extension', version: VERSION });
    flushBuffer();
    startPing();
  };

  socket.onmessage = function (evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    handleHubMessage(msg);
  };

  socket.onclose = function () {
    if (ws === socket) {
      ws = null;
      stopPing();
      setBadge(false);
      scheduleReconnect();
    }
  };

  socket.onerror = function () {
    // onclose always follows onerror; reconnect scheduling happens there.
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delayMs = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
  backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(function () {
    if (isOpen()) {
      send({ kind: 'ping' });
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function wsSend(obj) {
  if (!wsIsOpen()) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event pipeline
// ---------------------------------------------------------------------------

function sendEvent(event) {
  if (isOpen() && buffer.length === 0) {
    if (send({ kind: 'event', event: event })) return;
  }
  bufferEvent(event);
  if (isOpen()) flushBuffer();
}

function bufferEvent(event) {
  buffer.push(event);
  while (buffer.length > MAX_BUFFER) buffer.shift();
  persistBufferSoon();
}

function flushBuffer() {
  while (buffer.length > 0) {
    if (!send({ kind: 'event', event: buffer[0] })) {
      persistBufferSoon();
      return;
    }
    buffer.shift();
  }
  // Write through now: a teardown inside the coalescing window would otherwise
  // restore a mirror that still holds the events just sent, duplicating them.
  persistBufferNow();
}

function writeBufferToSession() {
  const payload = {};
  payload[BUFFER_KEY] = buffer.slice();
  try {
    const p = ext.storage.session.set(payload);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) {
    // Storage quota or context teardown; the in-memory buffer still holds it.
  }
}

// Coalesce writes so a burst of events does not hammer storage.session.
function persistBufferSoon() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(function () {
    persistTimer = null;
    writeBufferToSession();
  }, 500);
}

// Write immediately, cancelling any pending coalesced write.
function persistBufferNow() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeBufferToSession();
}

function restoreBuffer() {
  return ext.storage.session
    .get(BUFFER_KEY)
    .then(function (got) {
      const saved = got && got[BUFFER_KEY];
      if (Array.isArray(saved) && saved.length > 0) {
        buffer = saved.concat(buffer).slice(-MAX_BUFFER);
      }
    })
    .catch(function () {});
}

function markAgentTab(tabId) {
  if (typeof tabId === 'number' && tabId >= 0) {
    agentTabs.set(tabId, Date.now() + AGENT_TAG_WINDOW_MS);
  }
}

/**
 * The actor for a background-emitted event about this tab. The protocol defines
 * three actor values -- 'user', 'agent' and 'replay' -- but 'replay' is reserved
 * for future deterministic playback of a demonstration and nothing emits it,
 * here or anywhere else, so this decides between the two live ones.
 */
function actorForTab(tabId) {
  if (typeof tabId !== 'number') return 'user';
  const until = agentTabs.get(tabId);
  if (until === undefined) return 'user';
  if (Date.now() > until) {
    agentTabs.delete(tabId);
    return 'user';
  }
  return 'agent';
}

/**
 * `actorOverride` exists for handlers that must fetch something (a tab title)
 * before they can emit: the actor has to be decided when the browser event
 * fires, never after an async hop, or a window that expires mid-fetch turns the
 * agent's own effect into the user's.
 */
function emitTabEvent(type, tabId, url, data, actorOverride) {
  sendEvent({
    ts: Date.now(),
    actor: actorOverride || actorForTab(tabId),
    type: type,
    tabId: typeof tabId === 'number' ? tabId : null,
    url: url || null,
    data: data || {}
  });
}

function emitGlobalEvent(type, actor, url, data) {
  sendEvent({
    ts: Date.now(),
    actor: actor,
    type: type,
    tabId: null,
    url: url || null,
    data: data || {}
  });
}

// ---------------------------------------------------------------------------
// Hub messages / RPC
// ---------------------------------------------------------------------------

function handleHubMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'rpc') {
    handleRpc(msg);
  }
  // hello_ack and pong need no action.
}

function handleRpc(msg) {
  const id = msg.id;
  Promise.resolve()
    .then(function () {
      return dispatchRpc(msg.method, msg.params || {});
    })
    .then(function (result) {
      send({ kind: 'rpc_result', id: id, ok: true, result: result === undefined ? {} : result });
    })
    .catch(function (err) {
      send({ kind: 'rpc_result', id: id, ok: false, error: errorMessage(err) });
    });
}

function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) return err.message;
  return String(err);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** The active tab of the last-focused normal window, unless params names one. */
function resolveTabId(params) {
  if (params && typeof params.tabId === 'number') {
    return Promise.resolve(params.tabId);
  }
  return ext.tabs
    .query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
    .then(function (tabs) {
      if (!tabs || tabs.length === 0 || typeof tabs[0].id !== 'number') {
        throw new Error('No active tab in the last-focused window');
      }
      return tabs[0].id;
    });
}

// Sets, not object literals: a plain object would answer true for inherited
// keys, so an rpc named "toString" or "constructor" would be relayed to the
// content script instead of failing as the unknown method it is.
const CONTENT_METHODS = new Set(['readPage', 'click', 'fill', 'scroll', 'setClipboard', 'getPageState']);

// Content-relayed RPCs that can affect the page (and so trigger navigation), so
// the tab must be marked before relaying. Only consulted by relayToContent();
// every background-handled method marks the tab in its own handler.
const CONTENT_TAB_AFFECTING = new Set(['click', 'fill', 'scroll']);

function dispatchRpc(method, params) {
  if (CONTENT_METHODS.has(method)) {
    return relayToContent(method, params);
  }
  switch (method) {
    case 'listTabs':
      return rpcListTabs();
    case 'newTab':
      return rpcNewTab(params);
    case 'closeTab':
      return rpcCloseTab(params);
    case 'activateTab':
      return rpcActivateTab(params);
    case 'navigate':
      return rpcNavigate(params);
    case 'goBack':
      return rpcHistory(params, 'goBack');
    case 'goForward':
      return rpcHistory(params, 'goForward');
    case 'reload':
      return rpcReload(params);
    case 'screenshot':
      return rpcScreenshot(params);
    case 'zoom':
      return rpcZoom(params);
    case 'download':
      return rpcDownload(params);
    case 'runJs':
      return rpcRunJs(params);
    default:
      // Hard error naming the method exactly: a host that is newer than this
      // extension must learn that the method is missing, not get silence.
      throw new Error('Unknown RPC method: ' + method);
  }
}

function relayToContent(method, params) {
  return resolveTabId(params).then(function (tabId) {
    if (CONTENT_TAB_AFFECTING.has(method)) markAgentTab(tabId);
    return ext.tabs
      .sendMessage(tabId, { bb: 'rpc', method: method, params: params }, { frameId: 0 })
      .catch(function (err) {
        throw new Error(
          'Cannot reach the BrowserBuddy content script in tab ' +
            tabId +
            '. This page does not allow content scripts (browser-internal pages such as ' +
            'chrome:// or about:, extension stores, PDF/file viewers) or it has not finished ' +
            'loading. Underlying error: ' +
            errorMessage(err)
        );
      })
      .then(function (resp) {
        if (!resp || typeof resp !== 'object') {
          throw new Error('No response from the content script in tab ' + tabId);
        }
        if (resp.ok) return resp.result === undefined ? {} : resp.result;
        throw new Error(resp.error || 'Content script error');
      });
  });
}

function rpcListTabs() {
  return ext.tabs.query({}).then(function (tabs) {
    return {
      tabs: tabs.map(function (t) {
        return {
          tabId: t.id,
          url: t.url || null,
          title: t.title || null,
          active: !!t.active,
          windowId: t.windowId
        };
      })
    };
  });
}

function rpcNewTab(params) {
  const opts = {};
  if (params && typeof params.url === 'string') opts.url = params.url;
  // Must be set before create(): onCreated fires before the promise resolves.
  agentCreatingTabUntil = Date.now() + AGENT_TAG_WINDOW_MS;
  return ext.tabs.create(opts).then(function (tab) {
    markAgentTab(tab.id);
    return { tabId: tab.id };
  });
}

function rpcCloseTab(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs.remove(tabId).then(function () {
      return {};
    });
  });
}

function rpcActivateTab(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs.update(tabId, { active: true }).then(function (tab) {
      // The focus change is the agent's doing; windows.onFocusChanged has no
      // tab id to key on, so a global window covers it.
      agentFocusUntil = Date.now() + AGENT_TAG_WINDOW_MS;
      return ext.windows.update(tab.windowId, { focused: true }).then(function () {
        return {};
      });
    });
  });
}

function rpcNavigate(params) {
  if (!params || typeof params.url !== 'string' || params.url.length === 0) {
    throw new Error('navigate requires a url');
  }
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs.update(tabId, { url: params.url }).then(function () {
      return { tabId: tabId };
    });
  });
}

function rpcHistory(params, which) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs[which](tabId).then(function () {
      return {};
    });
  });
}

function rpcReload(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs.reload(tabId).then(function () {
      return {};
    });
  });
}

function rpcScreenshot(params) {
  return resolveTabId(params)
    .then(function (tabId) {
      return ext.tabs.get(tabId);
    })
    .then(function (tab) {
      if (tab.active) return tab;
      // The activation is the agent's doing, not the user's.
      markAgentTab(tab.id);
      return ext.tabs
        .update(tab.id, { active: true })
        .then(function () {
          return delay(350);
        })
        .then(function () {
          return tab;
        });
    })
    .then(function (tab) {
      return ext.tabs
        .captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 })
        .catch(function (err) {
          const msg = errorMessage(err);
          if (msg.indexOf('activeTab') !== -1) {
            // Firefox MV3 never treats granted host permissions as the
            // "<all_urls>" capture permission, so gesture-less capture is
            // impossible there. Explain the one supported path instead.
            throw new Error(
              'Screenshot failed: ' +
                msg +
                '. Firefox only allows tab capture after a user gesture grants activeTab: ' +
                'click the BrowserBuddy toolbar button on that tab, then retry. ' +
                'The grant lasts until the tab navigates.'
            );
          }
          throw err;
        });
    })
    .then(function (dataUrl) {
      const prefix = 'data:image/jpeg;base64,';
      if (typeof dataUrl !== 'string' || dataUrl.indexOf(prefix) !== 0) {
        throw new Error('captureVisibleTab returned an unexpected data URL format');
      }
      const base64 = dataUrl.slice(prefix.length);
      // base64 is ASCII, so its length is its byte length.
      assertResultSize('screenshot', base64.length);
      return { format: 'jpeg', base64: base64 };
    });
}

function rpcZoom(params) {
  if (!params || typeof params.factor !== 'number') {
    throw new Error('zoom requires a numeric factor');
  }
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return ext.tabs.setZoom(tabId, params.factor).then(function () {
      return {};
    });
  });
}

function rpcDownload(params) {
  if (!params || typeof params.url !== 'string' || params.url.length === 0) {
    throw new Error('download requires a url');
  }
  const opts = { url: params.url };
  if (typeof params.filename === 'string' && params.filename.length > 0) {
    opts.filename = params.filename;
  }
  agentDownloadUntil = Date.now() + AGENT_TAG_WINDOW_MS;
  return ext.downloads.download(opts).then(function (downloadId) {
    return { downloadId: downloadId };
  });
}

/**
 * Ask the tab's content script to treat the next AGENT_TAG_WINDOW_MS as agent
 * activity. Never rejects: a tab with no content script (chrome://, the Web
 * Store) simply has no in-page attribution to raise, and the caller proceeds.
 */
function raiseContentAgentWindow(tabId) {
  let p;
  try {
    p = ext.tabs.sendMessage(
      tabId,
      { bb: 'agentWindow', ms: AGENT_TAG_WINDOW_MS },
      { frameId: 0 }
    );
  } catch (e) {
    return Promise.resolve();
  }
  if (!p || typeof p.catch !== 'function') return Promise.resolve();
  return p.catch(function () {});
}

function rpcRunJs(params) {
  if (!params || typeof params.code !== 'string') {
    throw new Error('runJs requires code');
  }
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    // Raise the content script's agent window too, so DOM events the injected
    // code causes are attributed to the agent instead of the user.
    return raiseContentAgentWindow(tabId)
      .then(function () {
        return ext.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          world: 'MAIN',
          func: function (c) {
            return (0, eval)(c);
          },
          args: [params.code]
        });
      })
      .catch(function (err) {
        throw new Error(
          'runJs failed in tab ' +
            tabId +
            ': ' +
            errorMessage(err) +
            ' (a page Content-Security-Policy that forbids eval will cause this)'
        );
      })
      .then(function (frames) {
        if (!frames || frames.length === 0) {
          throw new Error('runJs produced no result frame for tab ' + tabId);
        }
        const value = frames[0].result === undefined ? null : frames[0].result;
        // Measure what will actually go on the wire, before it goes there.
        let serialized;
        try {
          serialized = JSON.stringify(value);
        } catch (e) {
          throw new Error('runJs produced a value that cannot be serialised: ' + errorMessage(e));
        }
        assertResultSize('runJs', byteLength(serialized === undefined ? 'null' : serialized));
        return { result: value };
      });
  });
}

// ---------------------------------------------------------------------------
// Browser observation (all listeners registered synchronously)
// ---------------------------------------------------------------------------

ext.tabs.onCreated.addListener(function (tab) {
  // A tab created inside the newTab RPC window belongs to the agent; mark it
  // before emitting so this event and the tab's later events both say "agent".
  if (Date.now() < agentCreatingTabUntil) markAgentTab(tab.id);
  emitTabEvent('tab_created', tab.id, tab.pendingUrl || tab.url || null, {});
});

ext.tabs.onRemoved.addListener(function (tabId) {
  emitTabEvent('tab_closed', tabId, null, {});
  agentTabs.delete(tabId);
  pendingLoadActors.delete(tabId);
});

ext.tabs.onActivated.addListener(function (info) {
  // Decided now, not after the title fetch below resolves.
  const actor = actorForTab(info.tabId);
  ext.tabs
    .get(info.tabId)
    .then(function (tab) {
      emitTabEvent('tab_activated', info.tabId, tab.url || null, { title: tab.title || null }, actor);
    })
    .catch(function () {
      emitTabEvent('tab_activated', info.tabId, null, { title: null }, actor);
    });
});

ext.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId !== 0) return;
  const actor = actorForTab(details.tabId);
  // The commit decides the whole load: onCompleted reads this instead of asking
  // the clock again once the load (which may take seconds) finally finishes.
  pendingLoadActors.set(details.tabId, actor);
  // Renew the tab's agent window so the rest of this navigation -- further
  // commits of a redirect chain, and any other tab event it causes -- is still
  // inside a window when it arrives.
  if (actor === 'agent') markAgentTab(details.tabId);
  emitTabEvent(
    'navigation',
    details.tabId,
    details.url || null,
    { transitionType: details.transitionType || null },
    actor
  );
});

ext.webNavigation.onCompleted.addListener(function (details) {
  if (details.frameId !== 0) return;
  // The actor of the commit that started this load, or -- for a load with no
  // observed commit -- the tab's actor now, before the title fetch's async hop.
  let actor = pendingLoadActors.get(details.tabId);
  if (actor === undefined) actor = actorForTab(details.tabId);
  else pendingLoadActors.delete(details.tabId);
  ext.tabs
    .get(details.tabId)
    .then(function (tab) {
      emitTabEvent(
        'page_loaded',
        details.tabId,
        details.url || null,
        { title: tab.title || null },
        actor
      );
    })
    .catch(function () {
      emitTabEvent('page_loaded', details.tabId, details.url || null, { title: null }, actor);
    });
});

ext.downloads.onCreated.addListener(function (item) {
  const raw = item.filename || '';
  const filename = raw ? raw.split(/[\\/]/).pop() : null;
  const actor = Date.now() <= agentDownloadUntil ? 'agent' : 'user';
  emitGlobalEvent('download_started', actor, item.url || null, { filename: filename });
});

ext.windows.onFocusChanged.addListener(function (windowId) {
  const actor = Date.now() <= agentFocusUntil ? 'agent' : 'user';
  emitGlobalEvent('window_focus', actor, null, {
    focused: windowId !== ext.windows.WINDOW_ID_NONE
  });
});

// Events forwarded from content scripts.
ext.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.bb !== 'event' || !msg.event) return;
  const event = msg.event;
  event.tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  if (!event.url && sender && sender.tab) event.url = sender.tab.url || null;
  if (!event.ts) event.ts = Date.now();
  if (!event.actor) event.actor = 'user';
  if (!event.data) event.data = {};
  sendEvent(event);
  // No response is sent; the content script does not wait for one.
});

// Keeps the worker awake and retries the socket if the backoff timer was lost
// to a service-worker teardown.
ext.alarms.create('bb-keepalive', { periodInMinutes: 0.5 });
ext.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== 'bb-keepalive') return;
  connect();
});

ext.runtime.onStartup.addListener(function () {
  connect();
});

ext.runtime.onInstalled.addListener(function () {
  connect();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setBadge(false);
restoreBuffer().then(connect);

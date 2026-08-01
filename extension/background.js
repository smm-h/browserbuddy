'use strict';

// BrowserBuddy MV3 service worker.
// Responsibilities:
//   1. Maintain a WebSocket to the local hub (ws://127.0.0.1:8590/ws).
//   2. Observe browser-level activity and stream it as events.
//   3. Execute RPCs from the hub, either directly (chrome.* APIs) or by
//      relaying to the content script in the target tab's top frame.
//
// MV3 note: every chrome.* listener in this file is registered synchronously at
// the top level. Listeners registered inside async callbacks are lost when the
// service worker is torn down and restarted.

const WS_URL = 'ws://127.0.0.1:8590/ws';
const VERSION = '0.1.0';
const BACKOFF_MS = [1000, 2000, 5000, 10000];
const PING_INTERVAL_MS = 20000;
const MAX_BUFFER = 500;
const AGENT_TAG_WINDOW_MS = 1500;
const BUFFER_KEY = 'bbBuffer';

let ws = null;
let backoffIndex = 0;
let reconnectTimer = null;
let pingTimer = null;
let persistTimer = null;

/** Events collected while disconnected, oldest first. */
let buffer = [];

/** tabId -> epoch ms until which background events for that tab are the agent's. */
const agentTabs = new Map();

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
 * set immediately before any chrome.windows.update({focused:true}) call.
 */
let agentFocusUntil = 0;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function isOpen() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function setBadge(connected) {
  try {
    chrome.action.setBadgeText({ text: connected ? '●' : '' });
    if (connected) {
      chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
    }
  } catch (e) {
    // The action API can be unavailable very early in worker startup.
  }
}

function connect() {
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

function send(obj) {
  if (!isOpen()) return false;
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
    const p = chrome.storage.session.set(payload);
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
  return chrome.storage.session
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

function emitTabEvent(type, tabId, url, data) {
  sendEvent({
    ts: Date.now(),
    actor: actorForTab(tabId),
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
  return chrome.tabs
    .query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
    .then(function (tabs) {
      if (!tabs || tabs.length === 0 || typeof tabs[0].id !== 'number') {
        throw new Error('No active tab in the last-focused window');
      }
      return tabs[0].id;
    });
}

const CONTENT_METHODS = {
  readPage: true,
  click: true,
  fill: true,
  scroll: true,
  setClipboard: true,
  getPageState: true
};

// Content-relayed RPCs that can affect the page (and so trigger navigation), so
// the tab must be marked before relaying. Only consulted by relayToContent();
// every background-handled method marks the tab in its own handler.
const CONTENT_TAB_AFFECTING = {
  click: true,
  fill: true,
  scroll: true
};

function dispatchRpc(method, params) {
  if (CONTENT_METHODS[method]) {
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
      throw new Error('Unknown RPC method: ' + method);
  }
}

function relayToContent(method, params) {
  return resolveTabId(params).then(function (tabId) {
    if (CONTENT_TAB_AFFECTING[method]) markAgentTab(tabId);
    return chrome.tabs
      .sendMessage(tabId, { bb: 'rpc', method: method, params: params }, { frameId: 0 })
      .catch(function (err) {
        throw new Error(
          'Cannot reach the BrowserBuddy content script in tab ' +
            tabId +
            '. This page does not allow content scripts (chrome://, the Chrome Web Store, ' +
            'PDF//file viewers) or it has not finished loading. Underlying error: ' +
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
  return chrome.tabs.query({}).then(function (tabs) {
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
  return chrome.tabs.create(opts).then(function (tab) {
    markAgentTab(tab.id);
    return { tabId: tab.id };
  });
}

function rpcCloseTab(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return chrome.tabs.remove(tabId).then(function () {
      return {};
    });
  });
}

function rpcActivateTab(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return chrome.tabs.update(tabId, { active: true }).then(function (tab) {
      // The focus change is the agent's doing; windows.onFocusChanged has no
      // tab id to key on, so a global window covers it.
      agentFocusUntil = Date.now() + AGENT_TAG_WINDOW_MS;
      return chrome.windows.update(tab.windowId, { focused: true }).then(function () {
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
    return chrome.tabs.update(tabId, { url: params.url }).then(function () {
      return { tabId: tabId };
    });
  });
}

function rpcHistory(params, which) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return chrome.tabs[which](tabId).then(function () {
      return {};
    });
  });
}

function rpcReload(params) {
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return chrome.tabs.reload(tabId).then(function () {
      return {};
    });
  });
}

function rpcScreenshot(params) {
  return resolveTabId(params)
    .then(function (tabId) {
      return chrome.tabs.get(tabId);
    })
    .then(function (tab) {
      if (tab.active) return tab;
      // The activation is the agent's doing, not the user's.
      markAgentTab(tab.id);
      return chrome.tabs
        .update(tab.id, { active: true })
        .then(function () {
          return delay(350);
        })
        .then(function () {
          return tab;
        });
    })
    .then(function (tab) {
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    })
    .then(function (dataUrl) {
      const prefix = 'data:image/jpeg;base64,';
      if (typeof dataUrl !== 'string' || dataUrl.indexOf(prefix) !== 0) {
        throw new Error('captureVisibleTab returned an unexpected data URL format');
      }
      return { format: 'jpeg', base64: dataUrl.slice(prefix.length) };
    });
}

function rpcZoom(params) {
  if (!params || typeof params.factor !== 'number') {
    throw new Error('zoom requires a numeric factor');
  }
  return resolveTabId(params).then(function (tabId) {
    markAgentTab(tabId);
    return chrome.tabs.setZoom(tabId, params.factor).then(function () {
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
  return chrome.downloads.download(opts).then(function (downloadId) {
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
    p = chrome.tabs.sendMessage(
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
        return chrome.scripting.executeScript({
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
        return { result: frames[0].result === undefined ? null : frames[0].result };
      });
  });
}

// ---------------------------------------------------------------------------
// Browser observation (all listeners registered synchronously)
// ---------------------------------------------------------------------------

chrome.tabs.onCreated.addListener(function (tab) {
  // A tab created inside the newTab RPC window belongs to the agent; mark it
  // before emitting so this event and the tab's later events both say "agent".
  if (Date.now() < agentCreatingTabUntil) markAgentTab(tab.id);
  emitTabEvent('tab_created', tab.id, tab.pendingUrl || tab.url || null, {});
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  emitTabEvent('tab_closed', tabId, null, {});
  agentTabs.delete(tabId);
});

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs
    .get(info.tabId)
    .then(function (tab) {
      emitTabEvent('tab_activated', info.tabId, tab.url || null, { title: tab.title || null });
    })
    .catch(function () {
      emitTabEvent('tab_activated', info.tabId, null, { title: null });
    });
});

chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId !== 0) return;
  emitTabEvent('navigation', details.tabId, details.url || null, {
    transitionType: details.transitionType || null
  });
});

chrome.webNavigation.onCompleted.addListener(function (details) {
  if (details.frameId !== 0) return;
  chrome.tabs
    .get(details.tabId)
    .then(function (tab) {
      emitTabEvent('page_loaded', details.tabId, details.url || null, { title: tab.title || null });
    })
    .catch(function () {
      emitTabEvent('page_loaded', details.tabId, details.url || null, { title: null });
    });
});

chrome.downloads.onCreated.addListener(function (item) {
  const raw = item.filename || '';
  const filename = raw ? raw.split(/[\\/]/).pop() : null;
  const actor = Date.now() <= agentDownloadUntil ? 'agent' : 'user';
  emitGlobalEvent('download_started', actor, item.url || null, { filename: filename });
});

chrome.windows.onFocusChanged.addListener(function (windowId) {
  const actor = Date.now() <= agentFocusUntil ? 'agent' : 'user';
  emitGlobalEvent('window_focus', actor, null, {
    focused: windowId !== chrome.windows.WINDOW_ID_NONE
  });
});

// Events forwarded from content scripts.
chrome.runtime.onMessage.addListener(function (msg, sender) {
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
chrome.alarms.create('bb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== 'bb-keepalive') return;
  connect();
});

chrome.runtime.onStartup.addListener(function () {
  connect();
});

chrome.runtime.onInstalled.addListener(function () {
  connect();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setBadge(false);
restoreBuffer().then(connect);

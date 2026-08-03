import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeExtension } from './fake-extension.js';
import { makeTmpDir, removeTmpDir, SERVER_ROOT } from './helpers.js';

const PORT = 18700;

const EXPECTED_TOOLS = [
  'browser_tabs',
  'browser_open_tab',
  'browser_close_tab',
  'browser_focus_tab',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_read',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_scroll',
  'browser_zoom',
  'browser_set_clipboard',
  'browser_download',
  'browser_eval',
  'browser_page_state',
  'browser_state',
  'browser_observe',
  'browser_wait_for_user',
  'demo_record_start',
  'demo_record_stop',
  'demo_list',
  'demo_get'
];

const CANNED_TABS = [
  { tabId: 1, url: 'https://a.test/', title: 'Alpha', active: true, windowId: 1 },
  { tabId: 2, url: 'https://b.test/', title: 'Beta', active: false, windowId: 1 }
];

const CANNED_PAGE_STATE = {
  url: 'https://a.test/',
  title: 'Alpha',
  readyState: 'complete',
  scrollY: 120,
  activeElementSelector: '#q'
};

/** Every .js under src/, recursively. */
function srcFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else out.push(full);
  }
  return out;
}

describe('MCP server integration', () => {
  let dataDir;
  let client;
  let transport;
  let ext;
  let sentEvents = 0;

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const json = (result) => JSON.parse(result.content[0].text);

  const sendEvent = (event) => {
    sentEvents += 1;
    ext.sendEvent({ ts: Date.now(), actor: 'user', tabId: 1, url: 'https://a.test/', data: {}, ...event });
  };

  /** Events travel over the WS channel, so wait for the hub to have ingested them. */
  const drain = async () => {
    for (let i = 0; i < 100; i += 1) {
      if (json(await call('browser_state')).latestSeq >= sentEvents) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for events to be ingested');
  };

  before(async () => {
    dataDir = makeTmpDir('mcp');
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SERVER_ROOT, 'src', 'index.js'), 'serve', '--port', String(PORT), '--data-dir', dataDir],
      stderr: 'ignore'
    });
    client = new Client({ name: 'browserbuddy-test', version: '0.1.0' });
    await client.connect(transport);
  });

  after(async () => {
    if (ext) await ext.close();
    await client.close();
    removeTmpDir(dataDir);
  });

  test('exposes exactly the specified tools, each with a description', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    assert.equal(tools.length, 25);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 10, `${tool.name} needs a description`);
    }
  });

  test('browser_click requires selector or text', async () => {
    const result = await call('browser_click', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires either "selector" or "text"/);
  });

  test('acting tools fail with the not-connected message while the extension is absent', async () => {
    const result = await call('browser_tabs', {});
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      'BrowserBuddy extension is not connected. Make sure Chrome or Firefox is running with the ' +
        'BrowserBuddy extension loaded (Chrome: chrome://extensions → Developer mode → Load unpacked; ' +
        'Firefox: about:debugging → This Firefox → Load Temporary Add-on → the extension/ ' +
        `directory). It connects automatically to ws://127.0.0.1:${PORT}/ws.`
    );
  });

  test('browser_state reports a disconnected extension without erroring', async () => {
    const state = json(await call('browser_state'));
    assert.deepEqual(state, {
      connected: false,
      activeTab: null,
      recording: null,
      eventCount: 0,
      latestSeq: 0
    });
  });

  test('the extension connects to the hub', async () => {
    ext = await FakeExtension.connect(PORT, {
      rpcHandlers: {
        listTabs: () => ({ tabs: CANNED_TABS }),
        navigate: ({ url }) => ({ tabId: url === 'https://c.test/' ? 3 : 1 }),
        screenshot: () => ({ format: 'jpeg', base64: 'ZmFrZS1qcGVn' }),
        click: ({ selector, text }) => ({ clicked: { selector: selector ?? 'button', tag: 'BUTTON', text: text ?? 'OK' } }),
        scroll: ({ direction, amount }) => ({ y: direction === 'down' ? 800 * amount : 0 }),
        getPageState: (params) => ({ ...CANNED_PAGE_STATE, requestedTabId: params.tabId ?? null })
      }
    });
    const state = json(await call('browser_state'));
    assert.equal(state.connected, true);
    assert.deepEqual(state.activeTab, CANNED_TABS[0]);
  });

  test('browser_tabs forwards to the extension and returns its tab list', async () => {
    assert.deepEqual(json(await call('browser_tabs')), { tabs: CANNED_TABS });
  });

  test('acting tools pass arguments through and apply defaults', async () => {
    assert.deepEqual(json(await call('browser_navigate', { url: 'https://c.test/' })), { tabId: 3 });
    assert.deepEqual(json(await call('browser_click', { text: 'Sign in' })), {
      clicked: { selector: 'button', tag: 'BUTTON', text: 'Sign in' }
    });
    assert.deepEqual(json(await call('browser_scroll', { direction: 'down' })), { y: 800 });
    assert.deepEqual(json(await call('browser_scroll', { direction: 'down', amount: 2 })), { y: 1600 });
  });

  test('browser_screenshot returns an image content block', async () => {
    const result = await call('browser_screenshot', {});
    assert.deepEqual(result.content, [{ type: 'image', data: 'ZmFrZS1qcGVn', mimeType: 'image/jpeg' }]);
  });

  test('browser_page_state passes the tabId through to getPageState', async () => {
    assert.deepEqual(json(await call('browser_page_state', { tabId: 2 })), {
      ...CANNED_PAGE_STATE,
      requestedTabId: 2
    });
    assert.deepEqual(json(await call('browser_page_state')), { ...CANNED_PAGE_STATE, requestedTabId: null });
  });

  test('browser_state reports a listTabs failure instead of erroring the tool', async () => {
    const original = ext.rpcHandlers.listTabs;
    ext.rpcHandlers.listTabs = () => {
      throw new Error('tab enumeration exploded');
    };
    try {
      const state = json(await call('browser_state'));
      assert.equal(state.connected, true);
      assert.equal(state.activeTab, null);
      assert.match(state.activeTabError, /tab enumeration exploded/);
    } finally {
      ext.rpcHandlers.listTabs = original;
    }
  });

  // stdout is never ours: under `serve` it carries the MCP stdio protocol, and
  // under the native-messaging host it carries the browser's framed messages.
  // Exactly one file may name it -- the host entry point, which hands fd 1 to
  // the native-messaging channel and then points process.stdout at stderr so a
  // stray write cannot desynchronise the frame stream.
  const STDOUT_OWNER = 'native-host-bin.js';

  test('no file in src/ uses console.log', () => {
    const offenders = [];
    for (const file of srcFiles(path.join(SERVER_ROOT, 'src'))) {
      if (fs.readFileSync(file, 'utf8').includes('console.log(')) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test('only the native-messaging host entry point touches stdout', () => {
    const offenders = [];
    for (const file of srcFiles(path.join(SERVER_ROOT, 'src'))) {
      if (path.basename(file) === STDOUT_OWNER) continue;
      if (fs.readFileSync(file, 'utf8').includes('process.stdout')) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test('the host entry point redirects process.stdout to stderr before serving', () => {
    const text = fs.readFileSync(path.join(SERVER_ROOT, 'src', STDOUT_OWNER), 'utf8');
    assert.match(text, /process\.stdout\.write\s*=\s*\(/, 'process.stdout.write must be reassigned');
    assert.match(text, /process\.stderr\.write\(chunk/, 'the reassignment must route to stderr');
    assert.ok(
      text.indexOf('process.stdout.write =') < text.indexOf('startNativeHost('),
      'the redirect must happen before the host starts serving'
    );
  });

  test('extension errors surface as tool errors', async () => {
    const result = await call('browser_reload', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no handler for "reload"/);
  });

  test('browser_observe returns ingested events with seqs', async () => {
    sendEvent({ type: 'navigation', url: 'https://a.test/', data: { transitionType: 'typed' } });
    sendEvent({ type: 'click', data: { selector: '#go', text: 'Go', tag: 'BUTTON' } });
    sendEvent({ type: 'scroll', actor: 'agent', data: { y: 100, maxY: 900, pct: 11 } });
    await drain();

    const observed = json(await call('browser_observe', {}));
    assert.equal(observed.latestSeq, 3);
    assert.deepEqual(observed.events.map((e) => [e.seq, e.type]), [[1, 'navigation'], [2, 'click']]);
    assert.equal(observed.events[1].selector, '#go');
    assert.equal(observed.events[1].text, 'Go');

    const all = json(await call('browser_observe', { actor: 'all' }));
    assert.equal(all.events.length, 3);
    const since = json(await call('browser_observe', { sinceSeq: 1, types: ['click'] }));
    assert.deepEqual(since.events.map((e) => e.seq), [2]);
  });

  test('canonical event fields are not shadowed by keys inside data', async () => {
    sendEvent({ type: 'click', url: 'https://a.test/', data: { url: 'https://spoof.test/', type: 'spoofed', selector: '#s' } });
    await drain();
    const [event] = json(await call('browser_observe', { limit: 1 })).events;
    assert.equal(event.type, 'click');
    assert.equal(event.url, 'https://a.test/');
    assert.equal(event.selector, '#s');
  });

  test('browser_observe and browser_wait_for_user reject non-positive and fractional bounds', async () => {
    for (const args of [{ limit: -1 }, { limit: 0 }, { limit: 1.5 }]) {
      assert.equal((await call('browser_observe', args)).isError, true, `browser_observe accepted ${JSON.stringify(args)}`);
    }
    for (const args of [{ timeoutSec: -1 }, { timeoutSec: 0 }, { timeoutSec: 1.5 }]) {
      assert.equal((await call('browser_wait_for_user', args)).isError, true, `browser_wait_for_user accepted ${JSON.stringify(args)}`);
    }
  });

  test('records a demonstration, cleans the steps, and stores it', async () => {
    assert.deepEqual(json(await call('demo_record_start', { name: 'Search The Web', description: 'runs a search' })), {
      recording: true,
      name: 'Search The Web'
    });
    assert.deepEqual(json(await call('browser_state')).recording, {
      name: 'Search The Web',
      description: 'runs a search',
      stepsSoFar: 0
    });

    sendEvent({ type: 'navigation', url: 'https://search.test/', data: { transitionType: 'typed' } });
    sendEvent({ type: 'page_loaded', url: 'https://search.test/', data: { title: 'Search' } });
    sendEvent({ type: 'input', url: 'https://search.test/', data: { selector: '#q', value: 'cat', inputType: 'text', redacted: false } });
    sendEvent({ type: 'input', url: 'https://search.test/', data: { selector: '#q', value: 'cats', inputType: 'text', redacted: false } });
    sendEvent({ type: 'scroll', url: 'https://search.test/', data: { y: 10, maxY: 100, pct: 10 } });
    sendEvent({ type: 'click', actor: 'agent', url: 'https://search.test/', data: { selector: '#agent', text: 'nope' } });
    sendEvent({ type: 'form_submit', url: 'https://search.test/', data: { selector: 'form' } });
    await drain();

    const stopped = json(await call('demo_record_stop'));
    assert.equal(stopped.name, 'Search The Web');
    assert.equal(stopped.stepCount, 3);
    assert.deepEqual(stopped.steps, [
      { type: 'navigation', url: 'https://search.test/' },
      { type: 'input', url: 'https://search.test/', selector: '#q', value: 'cats', redacted: false },
      { type: 'form_submit', url: 'https://search.test/', selector: 'form' }
    ]);

    const listed = json(await call('demo_list')).demos;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Search The Web');
    assert.equal(listed[0].stepCount, 3);

    const fetched = json(await call('demo_get', { name: 'search-the-web' }));
    assert.equal(fetched.slug, 'search-the-web');
    assert.equal(fetched.rawEventCount, 5);
    assert.deepEqual(fetched.steps, stopped.steps);

    const stopAgain = await call('demo_record_stop');
    assert.equal(stopAgain.isError, true);
    assert.match(stopAgain.content[0].text, /Not currently recording/);
  });

  test('browser_wait_for_user times out when nothing happens', async () => {
    assert.deepEqual(json(await call('browser_wait_for_user', { timeoutSec: 1 })), { timedOut: true });
  });

  test('browser_wait_for_user resolves with the next matching user event', async () => {
    const pending = call('browser_wait_for_user', { types: ['download_started'], timeoutSec: 5 });
    setTimeout(() => {
      sendEvent({ type: 'click', data: { selector: '#x', text: 'X' } });
      sendEvent({ type: 'download_started', data: { filename: 'report.pdf' } });
    }, 50);
    const { event } = json(await pending);
    assert.equal(event.type, 'download_started');
    assert.equal(event.filename, 'report.pdf');
    await drain();
  });
});

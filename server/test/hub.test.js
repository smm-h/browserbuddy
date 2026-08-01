import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Hub, notConnectedMessage } from '../src/hub.js';
import { FakeExtension } from './fake-extension.js';

const BASE_PORT = 18500;
let portOffset = 0;

/** Fails fast instead of letting a hang run out the test runner's clock. */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    })
  ]);
}

describe('Hub', () => {
  let hub;
  let port;
  const sockets = [];

  beforeEach(() => {
    port = BASE_PORT + portOffset++;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
    if (hub) await hub.close();
    hub = null;
  });

  const startHub = async (options = {}) => {
    hub = new Hub({ port, ...options });
    await hub.start();
    return hub;
  };

  const connectExt = async (options) => {
    const ext = await FakeExtension.connect(port, options);
    sockets.push(ext);
    return ext;
  };

  test('hello is acknowledged with the server version', async () => {
    await startHub();
    const ext = await connectExt({ hello: false });
    const ack = ext.waitFor((m) => m.kind === 'hello_ack');
    ext.send({ kind: 'hello', role: 'extension', version: '0.1.0' });
    assert.deepEqual(await ack, { kind: 'hello_ack', serverVersion: '0.1.0' });
    assert.equal(hub.isConnected(), true);
  });

  test('ping is answered with pong', async () => {
    await startHub();
    const ext = await connectExt();
    const pong = ext.waitFor((m) => m.kind === 'pong');
    ext.send({ kind: 'ping' });
    assert.deepEqual(await pong, { kind: 'pong' });
  });

  test('incoming events are seq-stamped, timestamped, and emitted', async () => {
    await startHub();
    const ext = await connectExt();
    const seen = [];
    hub.on('event', (e) => seen.push(e));

    const before = Date.now();
    ext.sendEvent({ ts: 1, actor: 'user', type: 'click', tabId: 3, url: 'https://a.test/', data: { selector: '#a' } });
    ext.sendEvent({ ts: 2, actor: 'user', type: 'scroll', tabId: 3, url: 'https://a.test/', data: { y: 10 } });
    while (seen.length < 2) await once(hub, 'event');

    assert.deepEqual(seen.map((e) => e.seq), [1, 2]);
    assert.equal(seen[0].type, 'click');
    assert.ok(seen[0].receivedAt >= before);
  });

  test('rpc roundtrips through the extension', async () => {
    await startHub();
    await connectExt({
      rpcHandlers: {
        listTabs: () => ({ tabs: [{ tabId: 1, url: 'https://a.test/', title: 'A', active: true, windowId: 1 }] }),
        closeTab: (params) => {
          assert.deepEqual(params, { tabId: 9 });
          return {};
        },
        boom: () => {
          throw new Error('extension side failed');
        }
      }
    });

    const tabs = await hub.rpc('listTabs', {});
    assert.equal(tabs.tabs[0].tabId, 1);
    assert.deepEqual(await hub.rpc('closeTab', { tabId: 9 }), {});
    await assert.rejects(() => hub.rpc('boom', {}), /extension side failed/);
  });

  test('rpc ids increment', async () => {
    await startHub();
    const ext = await connectExt({ rpcHandlers: { reload: () => ({}) } });
    await hub.rpc('reload', {});
    await hub.rpc('reload', {});
    const ids = ext.received.filter((m) => m.kind === 'rpc').map((m) => m.id);
    assert.deepEqual(ids, [1, 2]);
  });

  test('rpc rejects with the not-connected message when no extension is attached', async () => {
    await startHub();
    await assert.rejects(
      () => hub.rpc('listTabs', {}),
      (err) => {
        assert.equal(err.message, notConnectedMessage(port));
        assert.equal(
          err.message,
          'BrowserBuddy extension is not connected. Make sure Chrome or Firefox is running with the ' +
            'BrowserBuddy extension loaded (Chrome: chrome://extensions → Developer mode → Load unpacked; ' +
            'Firefox: about:debugging → This Firefox → Load Temporary Add-on → the extension/ ' +
            `directory). It connects automatically to ws://127.0.0.1:${port}/ws.`
        );
        return true;
      }
    );
  });

  test('rpc rejects after the configured timeout', async () => {
    await startHub({ rpcTimeoutMs: 60 });
    const ext = await connectExt();
    ext.autoRespond = false;
    await assert.rejects(() => hub.rpc('readPage', {}), /Timed out after 60ms .* "readPage"/);
  });

  test('a second hello replaces the first connection', async () => {
    await startHub();
    const first = await connectExt({ rpcHandlers: { reload: () => ({ who: 'first' }) } });
    const second = await connectExt({ rpcHandlers: { reload: () => ({ who: 'second' }) } });

    await first.waitForClose();
    assert.equal(hub.isConnected(), true);
    assert.deepEqual(await hub.rpc('reload', {}), { who: 'second' });
  });

  test('malformed JSON and unknown kinds are ignored without crashing', async () => {
    await startHub();
    const ext = await connectExt();
    ext.send('{not json');
    ext.send({ kind: 'who_knows' });
    ext.send({ kind: 'event' });
    const pong = ext.waitFor((m) => m.kind === 'pong');
    ext.send({ kind: 'ping' });
    await pong;
    assert.equal(hub.isConnected(), true);
  });

  test('disconnecting clears the connection', async () => {
    await startHub();
    const ext = await connectExt();
    assert.equal(hub.isConnected(), true);
    await ext.close();
    while (hub.isConnected()) await new Promise((r) => setTimeout(r, 5));
    assert.equal(hub.isConnected(), false);
  });

  test('frames from a socket that never said hello are ignored', async () => {
    await startHub();
    const ext = await connectExt();
    const stray = await connectExt({ hello: false });
    const seen = [];
    hub.on('event', (e) => seen.push(e));
    ext.autoRespond = false;

    const pending = hub.rpc('readPage', {});
    await ext.waitFor((m) => m.kind === 'rpc' && m.method === 'readPage');

    stray.sendEvent({ ts: 1, actor: 'user', type: 'click', tabId: 99, url: 'https://evil.test/', data: {} });
    stray.send({ kind: 'rpc_result', id: 1, ok: true, result: { hijacked: true } });
    stray.send({ kind: 'ping' });
    await new Promise((r) => setTimeout(r, 60));

    assert.deepEqual(seen, []);
    assert.equal(stray.received.some((m) => m.kind === 'pong'), false);
    assert.equal(hub.pending.size, 1);

    ext.send({ kind: 'rpc_result', id: 1, ok: true, result: { real: true } });
    assert.deepEqual(await pending, { real: true });
  });

  test('rpc honours a per-call timeout override', async () => {
    await startHub({ rpcTimeoutMs: 20000 });
    const ext = await connectExt();
    ext.autoRespond = false;
    await assert.rejects(() => hub.rpc('readPage', {}, 60), /Timed out after 60ms .* "readPage"/);
  });

  test('close() resolves even when a socket other than the extension is still open', async () => {
    await startHub();
    await connectExt();
    await connectExt({ hello: false });
    await withTimeout(hub.close(), 2000, 'hub.close() never resolved with a stray socket open');
  });

  test('pending rpcs reject promptly when the extension socket drops', async () => {
    await startHub();
    const ext = await connectExt();
    ext.autoRespond = false;
    const settled = hub.rpc('readPage', {}).then(() => null, (err) => err);
    await new Promise((r) => setTimeout(r, 20));
    await ext.close();
    const err = await withTimeout(settled, 2000, 'pending rpc never settled after the socket dropped');
    assert.match(err?.message ?? 'resolved instead of rejecting', /Extension disconnected while the call was in flight\./);
  });

  test('close() rejects in-flight rpcs instead of leaving them hanging', async () => {
    await startHub();
    const ext = await connectExt();
    ext.autoRespond = false;
    const settled = hub.rpc('readPage', {}).then(() => null, (err) => err);
    await new Promise((r) => setTimeout(r, 20));
    await hub.close();
    const err = await withTimeout(settled, 2000, 'pending rpc never settled after close()');
    assert.match(err?.message ?? 'resolved instead of rejecting', /Server shutting down\./);
  });

  test('starting on a busy port rejects with EADDRINUSE', async () => {
    await startHub();
    const second = new Hub({ port });
    await assert.rejects(() => second.start(), (err) => err.code === 'EADDRINUSE');
  });
});

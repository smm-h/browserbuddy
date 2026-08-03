import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeTmpDir, removeTmpDir, SERVER_ROOT } from './helpers.js';
import { FakeNativeBrowser } from './fake-native-extension.js';
import {
  encodeMessage,
  MessageDecoder,
  MAX_OUTBOUND_MESSAGE_BYTES,
  MAX_INBOUND_MESSAGE_BYTES
} from '../src/native-messaging.js';
import { chromeExtensionIdFromKey, chromeHostManifest, firefoxHostManifest, HOST_NAME } from '../src/host-manifest.js';
import {
  readEndpointFile,
  writeEndpointFile,
  endpointPath,
  endpointStatePath,
  readEndpointState
} from '../src/endpoint-file.js';

const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/** The MCP SDK ships dual builds; resolve the ESM client explicitly. */
async function loadMcpClient() {
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  const cjsEntry = req.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkRoot = cjsEntry.split(`${path.sep}dist${path.sep}`)[0];
  const clientMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/index.js')).href);
  const httpMod = await import(pathToFileURL(path.join(sdkRoot, 'dist/esm/client/streamableHttp.js')).href);
  return { Client: clientMod.Client, StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport };
}

describe('native-messaging framing', () => {
  test('encode/decode round-trips a message', () => {
    const decoder = new MessageDecoder();
    const out = decoder.push(encodeMessage({ kind: 'hello', version: '0.1.0' }));
    assert.deepEqual(out, [{ kind: 'hello', version: '0.1.0' }]);
  });

  test('the 4-byte header is little-endian', () => {
    const framed = encodeMessage({ a: 1 });
    assert.equal(framed.readUInt32LE(0), framed.length - 4);
    assert.deepEqual(JSON.parse(framed.subarray(4).toString('utf8')), { a: 1 });
  });

  test('messages split across chunks are reassembled', () => {
    const framed = encodeMessage({ kind: 'event', event: { type: 'click' } });
    const decoder = new MessageDecoder();
    assert.deepEqual(decoder.push(framed.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(framed.subarray(2, 7)), []);
    assert.deepEqual(decoder.push(framed.subarray(7)), [{ kind: 'event', event: { type: 'click' } }]);
  });

  test('several messages in one chunk all decode, in order', () => {
    const decoder = new MessageDecoder();
    const chunk = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 }), encodeMessage({ n: 3 })]);
    assert.deepEqual(decoder.push(chunk), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('an oversize outgoing message is a hard error, not a truncation', () => {
    assert.throws(
      () => encodeMessage({ big: 'x'.repeat(MAX_OUTBOUND_MESSAGE_BYTES) }),
      /native-messaging limit for this direction/
    );
  });

  test('an oversize outgoing rpc names the method it was carrying', () => {
    assert.throws(
      () => encodeMessage({ kind: 'rpc', id: 1, method: 'runJs', params: { code: 'x'.repeat(MAX_OUTBOUND_MESSAGE_BYTES) } }),
      /rpc "runJs" is \d+ bytes/
    );
  });

  test('the inbound decoder accepts a frame far above the outbound cap', () => {
    // Results (eval values, screenshot base64) travel extension -> host, where
    // the browser allows up to 4 GB. Rejecting them in the decoder would close
    // the channel and kill the host over one large result.
    const big = { kind: 'rpc_result', id: 1, ok: true, result: { base64: 'A'.repeat(3 * 1024 * 1024) } };
    const framed = encodeMessage(big, { maxBytes: MAX_INBOUND_MESSAGE_BYTES });
    assert.ok(framed.length > MAX_OUTBOUND_MESSAGE_BYTES);
    assert.deepEqual(new MessageDecoder().push(framed), [big]);
  });

  test('an oversize length header is a hard error, not a resync attempt', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_INBOUND_MESSAGE_BYTES + 1, 0);
    assert.throws(() => new MessageDecoder().push(header), /stream is corrupt/);
  });
});

describe('extension-side result bounding', () => {
  // The extension is not loadable in node (it binds browser globals at the top
  // level), so the guard is asserted at the source. It is what keeps an
  // unreasonable result a single ok:false RPC instead of an oversize frame.
  const background = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'background.js'), 'utf8');

  test('background.js caps a single rpc result at 64MB', () => {
    assert.match(background, /const MAX_RPC_RESULT_BYTES = 64 \* 1024 \* 1024;/);
    assert.match(background, /result too large \(/);
  });

  test('both large-result RPCs are measured before they are sent', () => {
    assert.match(background, /assertResultSize\('screenshot',/);
    assert.match(background, /assertResultSize\('runJs',/);
  });
});

describe('endpoint file staleness', () => {
  let dir;

  beforeEach(() => {
    dir = makeTmpDir('endpoint-file');
  });

  afterEach(() => removeTmpDir(dir));

  test('no file at all reads as no live endpoint', () => {
    assert.equal(readEndpointFile(dir), null);
  });

  test('a descriptor whose pid is alive reads back', () => {
    writeEndpointFile(dir, { url: 'http://127.0.0.1:1234/mcp', token: 'tok' });
    const got = readEndpointFile(dir);
    assert.equal(got.url, 'http://127.0.0.1:1234/mcp');
    assert.equal(got.pid, process.pid);
  });

  test('a descriptor whose pid is dead is treated as absent', () => {
    // A host that was killed leaves its descriptor behind; a client dialling it
    // would hit a port that may since belong to something else.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0);
    writeEndpointFile(dir, { url: 'http://127.0.0.1:1234/mcp', token: 'tok', pid: dead.pid });
    assert.equal(readEndpointFile(dir), null);
  });

  test('a descriptor with no pid is a hard error, not a guess', () => {
    fs.writeFileSync(endpointPath(dir), JSON.stringify({ url: 'http://x/mcp', token: 't' }));
    assert.throws(() => readEndpointFile(dir), /no integer "pid"/);
  });
});

describe('host manifest generation', () => {
  test('the chrome extension id is derived from the manifest key', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
    assert.ok(manifest.key, 'extension/manifest.json must pin "key" so the Chrome id is stable');
    const id = chromeExtensionIdFromKey(manifest.key);
    assert.match(id, /^[a-p]{32}$/);
    // Deterministic: the same key always yields the same id, which is the
    // entire point of pinning it in allowed_origins.
    assert.equal(id, chromeExtensionIdFromKey(manifest.key));
  });

  test('the chrome host manifest names the extension origin', () => {
    const m = chromeHostManifest({ hostPath: '/tmp/launcher.sh', extensionId: 'a'.repeat(32) });
    assert.equal(m.name, HOST_NAME);
    assert.equal(m.type, 'stdio');
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  });

  test('the firefox host manifest uses allowed_extensions with the gecko id', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
    const m = firefoxHostManifest({ hostPath: '/tmp/launcher.sh' });
    assert.deepEqual(m.allowed_extensions, [manifest.browser_specific_settings.gecko.id]);
    assert.equal(m.allowed_origins, undefined);
  });
});

describe('native host end to end', () => {
  let dataDir;
  let browser;
  let sdk;

  before(async () => {
    sdk = await loadMcpClient();
  });

  beforeEach(() => {
    dataDir = makeTmpDir('native-host');
  });

  afterEach(async () => {
    if (browser) {
      browser.kill();
      browser = null;
    }
    removeTmpDir(dataDir);
  });

  async function bootHost(rpcHandlers = {}) {
    browser = FakeNativeBrowser.spawnHost({ dataDir, rpcHandlers });
    await browser.hello();
    // The endpoint file appears once the HTTP server is listening.
    await browser.waitForStderr((line) => line.includes('native host serving MCP at'));
    return readEndpointFile(dataDir);
  }

  async function connectClient(endpoint, { token = endpoint.token } = {}) {
    const transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const client = new sdk.Client({ name: 'native-host-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport };
  }

  test('the host writes an endpoint file with a loopback url and a token', async () => {
    const endpoint = await bootHost();
    assert.equal(endpoint.transport, 'streamable-http');
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(endpoint.token.length >= 32);
    assert.equal(endpoint.mcpServers.browserbuddy.headers.Authorization, `Bearer ${endpoint.token}`);
    // Owner-only: the file is the token.
    assert.equal(fs.statSync(endpointPath(dataDir)).mode & 0o777, 0o600);
  });

  test('the port is ephemeral, not a fixed 8590', async () => {
    const endpoint = await bootHost();
    const port = Number(new URL(endpoint.url).port);
    assert.ok(port > 0 && port !== 8590, `expected an ephemeral port, got ${port}`);
  });

  test('a respawned host reuses the same token and port', async () => {
    // Every service-worker teardown respawns the host. If the token or the
    // port changed, the MCP client's configured endpoint would silently die.
    const first = await bootHost();
    const firstPort = Number(new URL(first.url).port);
    assert.equal(fs.statSync(endpointStatePath(dataDir)).mode & 0o777, 0o600);

    browser.closePipe();
    assert.equal(await browser.waitForExit(), 0);
    assert.equal(fs.existsSync(endpointPath(dataDir)), false, 'the descriptor goes away with the host');
    assert.ok(fs.existsSync(endpointStatePath(dataDir)), 'the identity outlives the host');

    const second = await bootHost();
    assert.equal(second.token, first.token, 'the bearer token must survive a respawn');
    assert.equal(Number(new URL(second.url).port), firstPort, 'the port must be reclaimed when it is free');
    assert.equal(second.url, first.url);
  });

  test('a taken port yields a new url, a loud message, and the same token', async () => {
    const first = await bootHost();
    const firstPort = Number(new URL(first.url).port);
    browser.closePipe();
    await browser.waitForExit();

    const squatter = net.createServer();
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(firstPort, '127.0.0.1', resolve);
    });
    try {
      const second = await bootHost();
      assert.equal(second.token, first.token, 'only the url may change, never the token');
      assert.notEqual(Number(new URL(second.url).port), firstPort);
      assert.ok(
        browser.stderr.some((l) => l.includes(`previous MCP port ${firstPort} is held`)),
        `expected a loud message about the taken port, saw:\n${browser.stderr.join('\n')}`
      );
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  test('the persisted identity records the port actually bound', async () => {
    const endpoint = await bootHost();
    const state = readEndpointState(dataDir);
    assert.equal(state.token, endpoint.token);
    assert.equal(state.port, Number(new URL(endpoint.url).port));
  });

  test('an MCP tool call round-trips over HTTP and the native pipe', async () => {
    const endpoint = await bootHost({
      listTabs: () => ({ tabs: [{ tabId: 7, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 }] })
    });
    const { client, transport } = await connectClient(endpoint);
    try {
      const res = await client.callTool({ name: 'browser_tabs', arguments: {} });
      const payload = JSON.parse(res.content.find((c) => c.type === 'text').text);
      assert.equal(payload.tabs[0].tabId, 7);
      // The request really traversed the pipe: the browser side saw the rpc.
      assert.ok(browser.received.some((m) => m.kind === 'rpc' && m.method === 'listTabs'));
    } finally {
      await transport.close();
    }
  });

  test('events sent over the pipe reach browser_observe', async () => {
    const endpoint = await bootHost();
    browser.sendEvent({ ts: Date.now(), actor: 'user', type: 'click', tabId: 3, url: 'https://a.test/', data: { selector: '#go' } });
    const { client, transport } = await connectClient(endpoint);
    try {
      // The event travels the pipe asynchronously; poll rather than sleep.
      let observed = { events: [] };
      for (let i = 0; i < 40 && observed.events.length === 0; i++) {
        const res = await client.callTool({ name: 'browser_observe', arguments: {} });
        observed = JSON.parse(res.content.find((c) => c.type === 'text').text);
        if (observed.events.length === 0) await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(observed.events.length, 1);
      assert.equal(observed.events[0].selector, '#go');
    } finally {
      await transport.close();
    }
  });

  test('a request without the bearer token is refused', async () => {
    const endpoint = await bootHost();
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(res.status, 401);
  });

  test('a request with the wrong bearer token is refused', async () => {
    const endpoint = await bootHost();
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${'z'.repeat(endpoint.token.length)}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(res.status, 401);
  });

  test('closing the native pipe stops the host and removes the endpoint file', async () => {
    const endpoint = await bootHost();
    const url = endpoint.url;
    browser.closePipe();
    const code = await browser.waitForExit();
    assert.equal(code, 0);
    assert.equal(fs.existsSync(endpointPath(dataDir)), false);
    // The port is really gone, not merely unreferenced.
    await assert.rejects(fetch(url, { method: 'POST' }));
  });

  test('tools fail loudly before the extension handshake, with no fallback', async () => {
    browser = FakeNativeBrowser.spawnHost({ dataDir });
    await browser.waitForStderr((line) => line.includes('native host serving MCP at'));
    const endpoint = readEndpointFile(dataDir);
    const { client, transport } = await connectClient(endpoint);
    try {
      const res = await client.callTool({ name: 'browser_tabs', arguments: {} });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /native-messaging pipe/);
    } finally {
      await transport.close();
    }
  });

  test('a result far above 1 MB round-trips without killing the host', async () => {
    const big = 'y'.repeat(2 * 1024 * 1024);
    const endpoint = await bootHost({
      runJs: () => ({ result: big }),
      listTabs: () => ({ tabs: [] })
    });
    const { client, transport } = await connectClient(endpoint);
    try {
      const res = await client.callTool({ name: 'browser_eval', arguments: { code: '1' } });
      const payload = JSON.parse(res.content.find((c) => c.type === 'text').text);
      assert.equal(payload.result.length, big.length);
      // The pipe and the endpoint survived: the next call still works.
      const after = await client.callTool({ name: 'browser_tabs', arguments: {} });
      assert.equal(after.isError, undefined);
      assert.equal(browser.child.exitCode, null, 'the host must still be running');
    } finally {
      await transport.close();
    }
  });

  test('an over-limit result fails one call and leaves the endpoint alive', async () => {
    // What the extension does when its own 64MB guard trips: one ok:false RPC,
    // no oversize frame, no pipe teardown.
    const endpoint = await bootHost({
      runJs: () => {
        throw new Error('runJs result too large (70000000 bytes, limit 64MB).');
      },
      listTabs: () => ({ tabs: [] })
    });
    const { client, transport } = await connectClient(endpoint);
    try {
      const res = await client.callTool({ name: 'browser_eval', arguments: { code: '1' } });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /result too large \(70000000 bytes, limit 64MB\)/);
      const after = await client.callTool({ name: 'browser_tabs', arguments: {} });
      assert.equal(after.isError, undefined);
      assert.equal(browser.child.exitCode, null, 'the host must still be running');
    } finally {
      await transport.close();
    }
  });

  test('the host never writes anything but framed native messages to stdout', async () => {
    const endpoint = await bootHost({ listTabs: () => ({ tabs: [] }) });
    const { client, transport } = await connectClient(endpoint);
    try {
      await client.callTool({ name: 'browser_tabs', arguments: {} });
    } finally {
      await transport.close();
    }
    // Every byte the fake browser read off stdout decoded as a framed message;
    // a stray write would have thrown in the decoder or left a partial frame.
    assert.equal(browser.decoder.buffer.length, 0);
    assert.ok(browser.received.length > 0);
    assert.ok(browser.stderr.some((l) => l.includes('[browserbuddy]')), 'diagnostics must go to stderr');
  });
});

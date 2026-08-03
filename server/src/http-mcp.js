import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const MCP_PATH = '/mcp';

/** Bodies above this are refused outright: MCP requests are small. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Constant-time bearer comparison. The token is the only thing between a
 * process running as this OS user and full control of the browser, so a
 * length-leaking === is not good enough.
 */
function tokenMatches(expected, presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function jsonRpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * Serves MCP over Streamable HTTP on loopback, protected by a bearer token.
 *
 * The trust boundary is the OS user: anything running as this user can read
 * the endpoint file and therefore the token. That is intended -- the token
 * exists to stop *other* local users and stray localhost web pages (which
 * cannot set an Authorization header cross-origin without a preflight we
 * refuse) from driving the browser.
 *
 * One MCP session per initialize: each gets its own McpServer instance built
 * by createServer(), all sharing the same hub/store/demos singletons.
 */
export async function startHttpMcp({ createServer, token = generateToken(), host = '127.0.0.1', port = 0 }) {
  const sessions = new Map();

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[browserbuddy] http-mcp request failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, err.message));
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, jsonRpcError(-32601, `Unknown path ${url.pathname}; MCP is served at ${MCP_PATH}.`));
      return;
    }
    // No CORS headers are emitted at all: a browser page must not be able to
    // reach this endpoint, so every cross-origin preflight fails by omission.
    if (req.method === 'OPTIONS') {
      res.writeHead(405, { allow: 'GET, POST, DELETE' });
      res.end();
      return;
    }

    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (!tokenMatches(token, presented)) {
      res.setHeader('www-authenticate', 'Bearer realm="browserbuddy"');
      sendJson(res, 401, jsonRpcError(-32001, 'Missing or invalid bearer token for the BrowserBuddy MCP endpoint.'));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessions.has(sessionId)) {
      await sessions.get(sessionId).handleRequest(req, res);
      return;
    }
    if (typeof sessionId === 'string') {
      sendJson(res, 404, jsonRpcError(-32001, `Unknown MCP session ${sessionId}.`));
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 400, jsonRpcError(-32000, 'A GET or DELETE without an mcp-session-id has no session to act on.'));
      return;
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, 'Request body is not valid JSON.'));
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, jsonRpcError(-32000, 'The first request on a new MCP session must be "initialize".'));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport)
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const mcpServer = createServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      httpServer.on('error', (err) => console.error(`[browserbuddy] http-mcp server error: ${err.message}`));
      resolve();
    });
  });

  const boundPort = httpServer.address().port;
  return {
    token,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}${MCP_PATH}`,
    sessionCount: () => sessions.size,
    async close() {
      for (const transport of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* already gone */
        }
      }
      sessions.clear();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

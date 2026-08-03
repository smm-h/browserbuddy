import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { PendingRpcs } from './rpc-peer.js';

export const SERVER_VERSION = '0.1.0';
const DEFAULT_RPC_TIMEOUT_MS = 20000;

export function notConnectedMessage(port) {
  return (
    'BrowserBuddy extension is not connected. Make sure Chrome or Firefox is running with the ' +
    'BrowserBuddy extension loaded (Chrome: chrome://extensions → Developer mode → Load unpacked; ' +
    'Firefox: about:debugging → This Firefox → Load Temporary Add-on → the extension/ ' +
    `directory). It connects automatically to ws://127.0.0.1:${port}/ws.`
  );
}

/**
 * WebSocket hub the browser extension connects to. Emits "event" for every
 * seq-stamped incoming event and exposes rpc() for calls into the browser.
 */
export class Hub extends EventEmitter {
  constructor({ port = 8590, host = '127.0.0.1', path = '/ws', rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.path = path;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.wss = null;
    this.socket = null;
    this.nextSeq = 1;
    this.pending = new PendingRpcs();
  }

  start() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.port, path: this.path });
      const onError = (err) => reject(err);
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        wss.on('error', (err) => console.error('[browserbuddy] websocket server error:', err.message));
        this.wss = wss;
        wss.on('connection', (ws) => this.#onConnection(ws));
        resolve(this);
      });
    });
  }

  isConnected() {
    return Boolean(this.socket) && this.socket.readyState === this.socket.OPEN;
  }

  rpc(method, params = {}, timeoutMs = this.rpcTimeoutMs) {
    if (!this.isConnected()) {
      return Promise.reject(new Error(notConnectedMessage(this.port)));
    }
    const { id, promise } = this.pending.create(method, timeoutMs);
    this.socket.send(JSON.stringify({ kind: 'rpc', id, method, params }));
    return promise;
  }

  async close() {
    this.pending.rejectAll('Server shutting down.');
    this.socket = null;
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      // Every upgraded socket must be terminated, not just the extension's:
      // wss.close() waits on any connection it still knows about.
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
  }

  #onConnection(ws) {
    ws.on('message', (raw) => this.#onMessage(ws, raw));
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.pending.rejectAll('Extension disconnected while the call was in flight.');
      }
    });
    ws.on('error', (err) => console.error('[browserbuddy] extension socket error:', err.message));
  }

  #onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error('[browserbuddy] ignoring malformed JSON from extension socket');
      return;
    }
    if (!msg || typeof msg !== 'object') {
      console.error('[browserbuddy] ignoring non-object message from extension socket');
      return;
    }

    // Only the socket that most recently completed hello may drive the hub;
    // a stray localhost client must not inject events or settle someone's rpc.
    if (msg.kind !== 'hello' && ws !== this.socket) {
      console.error(`[browserbuddy] ignoring "${String(msg.kind)}" frame from a socket that has not completed hello`);
      return;
    }

    switch (msg.kind) {
      case 'hello':
        if (this.socket && this.socket !== ws) {
          console.error('[browserbuddy] new extension connection replaces the previous one');
          this.socket.close();
        }
        this.socket = ws;
        ws.send(JSON.stringify({ kind: 'hello_ack', serverVersion: SERVER_VERSION }));
        console.error(`[browserbuddy] extension connected (version ${msg.version ?? 'unknown'})`);
        break;

      case 'ping':
        ws.send(JSON.stringify({ kind: 'pong' }));
        break;

      case 'event': {
        const event = msg.event;
        if (!event || typeof event !== 'object') {
          console.error('[browserbuddy] ignoring event message with no event payload');
          return;
        }
        event.seq = this.nextSeq++;
        event.receivedAt = Date.now();
        this.emit('event', event);
        break;
      }

      case 'rpc_result': {
        const settled = this.pending.settle(msg.id, Boolean(msg.ok), msg.ok ? msg.result ?? {} : msg.error);
        if (!settled) console.error(`[browserbuddy] rpc_result for unknown id ${msg.id}`);
        break;
      }

      default:
        console.error(`[browserbuddy] ignoring message with unknown kind: ${String(msg.kind)}`);
    }
  }
}

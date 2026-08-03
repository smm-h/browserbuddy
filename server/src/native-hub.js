import { EventEmitter } from 'node:events';
import { PendingRpcs } from './rpc-peer.js';
import { SERVER_VERSION } from './hub.js';

const DEFAULT_RPC_TIMEOUT_MS = 20000;

export function notConnectedMessage() {
  return (
    'The BrowserBuddy extension has not completed its handshake over the native-messaging pipe. ' +
    'The browser spawned this host, so the pipe exists, but no "hello" arrived: reload the extension ' +
    '(chrome://extensions -> reload) and check the extension service worker console for errors.'
  );
}

/**
 * The Hub interface (isConnected/rpc/"event") backed by a native-messaging
 * pipe instead of a WebSocket. The browser owns both ends of that pipe: it
 * spawned this process and connected our stdio to the extension's Port, so
 * there is exactly one peer and no listening socket on our side.
 *
 * Message shapes are identical to the WebSocket hub's (docs/PROTOCOL.md), so
 * mcp.js consumes either transport unchanged.
 */
export class NativeHub extends EventEmitter {
  constructor({ channel, rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS, startSeq = 1 }) {
    super();
    this.channel = channel;
    this.rpcTimeoutMs = rpcTimeoutMs;
    // See Hub: the store owns the persisted counter, the hub only stamps.
    this.nextSeq = startSeq;
    this.pending = new PendingRpcs();
    this.helloed = false;
    this.extensionVersion = null;

    channel.on('message', (msg) => this.#onMessage(msg));
    channel.on('close', () => {
      this.helloed = false;
      this.pending.rejectAll('The browser closed the native-messaging pipe while the call was in flight.');
      this.emit('close');
    });
    channel.on('error', (err) => console.error(`[browserbuddy] native-messaging error: ${err.message}`));
  }

  isConnected() {
    return this.channel.isOpen() && this.helloed;
  }

  rpc(method, params = {}, timeoutMs = this.rpcTimeoutMs) {
    if (!this.isConnected()) return Promise.reject(new Error(notConnectedMessage()));
    const { id, promise } = this.pending.create(method, timeoutMs);
    try {
      this.channel.send({ kind: 'rpc', id, method, params });
    } catch (err) {
      this.pending.discard(id);
      return Promise.reject(err);
    }
    return promise;
  }

  async close() {
    this.pending.rejectAll('Host shutting down.');
    this.channel.close();
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      console.error('[browserbuddy] ignoring non-object native message');
      return;
    }
    switch (msg.kind) {
      case 'hello':
        this.helloed = true;
        this.extensionVersion = msg.version ?? null;
        this.channel.send({ kind: 'hello_ack', serverVersion: SERVER_VERSION, transport: 'native-messaging' });
        console.error(`[browserbuddy] extension handshake over native messaging (version ${msg.version ?? 'unknown'})`);
        this.emit('hello', msg);
        break;

      case 'ping':
        this.channel.send({ kind: 'pong' });
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
        console.error(`[browserbuddy] ignoring native message with unknown kind: ${String(msg.kind)}`);
    }
  }
}

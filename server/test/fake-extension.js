import WebSocket from 'ws';

/**
 * Stand-in for the browser extension: speaks the hub protocol over a real
 * WebSocket so tests exercise the wire format rather than internals.
 */
export class FakeExtension {
  constructor(ws) {
    this.ws = ws;
    this.received = [];
    this.waiters = [];
    this.rpcHandlers = {};
    this.autoRespond = true;
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.received.push(msg);
      for (const waiter of this.waiters.slice()) {
        if (waiter.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
      if (msg.kind === 'rpc' && this.autoRespond) this.#handleRpc(msg);
    });
  }

  static connect(port, { rpcHandlers = {}, hello = true, version = '0.1.0' } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('error', reject);
      ws.once('open', async () => {
        const ext = new FakeExtension(ws);
        ext.rpcHandlers = rpcHandlers;
        if (hello) {
          const ack = ext.waitFor((m) => m.kind === 'hello_ack');
          ws.send(JSON.stringify({ kind: 'hello', role: 'extension', version }));
          await ack;
        }
        resolve(ext);
      });
    });
  }

  send(msg) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  sendEvent(event) {
    this.send({ kind: 'event', event });
  }

  waitFor(predicate, timeoutMs = 3000) {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('FakeExtension: timed out waiting for a matching message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 3000) {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FakeExtension: socket did not close')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }

  async #handleRpc(msg) {
    const handler = this.rpcHandlers[msg.method];
    if (!handler) {
      this.send({ kind: 'rpc_result', id: msg.id, ok: false, error: `FakeExtension has no handler for "${msg.method}"` });
      return;
    }
    try {
      const result = await handler(msg.params ?? {});
      this.send({ kind: 'rpc_result', id: msg.id, ok: true, result: result ?? {} });
    } catch (err) {
      this.send({ kind: 'rpc_result', id: msg.id, ok: false, error: err.message });
    }
  }
}

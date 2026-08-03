import { spawn } from 'node:child_process';
import path from 'node:path';
import { MessageDecoder, encodeMessage } from '../src/native-messaging.js';
import { SERVER_ROOT } from './helpers.js';

const HOST_BIN = path.join(SERVER_ROOT, 'src', 'native-host-bin.js');

/**
 * Stand-in for the browser: spawns the real native-messaging host as a child
 * process and speaks the framed wire protocol over its stdio, exactly as
 * Chrome and Firefox do. Tests therefore exercise the framing and the process
 * lifetime, not just the in-process classes.
 */
export class FakeNativeBrowser {
  constructor(child) {
    this.child = child;
    this.decoder = new MessageDecoder();
    this.received = [];
    this.waiters = [];
    this.stderr = [];
    this.rpcHandlers = {};
    this.autoRespond = true;

    child.stdout.on('data', (chunk) => {
      for (const msg of this.decoder.push(chunk)) this.#onMessage(msg);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.stderr.push(line.trim());
    });
  }

  static spawnHost({ dataDir, rpcHandlers = {}, env = {} } = {}) {
    const child = spawn(process.execPath, [HOST_BIN, '--data-dir', dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    });
    const browser = new FakeNativeBrowser(child);
    browser.rpcHandlers = rpcHandlers;
    return browser;
  }

  send(msg) {
    this.child.stdin.write(encodeMessage(msg));
  }

  hello(version = '0.1.0') {
    const ack = this.waitFor((m) => m.kind === 'hello_ack');
    this.send({ kind: 'hello', role: 'extension', version, transport: 'native-messaging' });
    return ack;
  }

  sendEvent(event) {
    this.send({ kind: 'event', event });
  }

  waitFor(predicate, timeoutMs = 5000) {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`FakeNativeBrowser: timed out waiting for a message. stderr:\n${this.stderr.join('\n')}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Waits for a stderr line matching the predicate (the host's only log channel). */
  waitForStderr(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this.stderr.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() > deadline) {
          return reject(new Error(`FakeNativeBrowser: no matching stderr line. Saw:\n${this.stderr.join('\n')}`));
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** Closes the pipe the way the browser does when the extension goes away. */
  closePipe() {
    this.child.stdin.end();
  }

  waitForExit(timeoutMs = 5000) {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FakeNativeBrowser: host did not exit')), timeoutMs);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  #onMessage(msg) {
    this.received.push(msg);
    for (const waiter of this.waiters.slice()) {
      if (waiter.predicate(msg)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
    if (msg.kind === 'rpc' && this.autoRespond) this.#handleRpc(msg);
  }

  async #handleRpc(msg) {
    const handler = this.rpcHandlers[msg.method];
    if (!handler) {
      this.send({ kind: 'rpc_result', id: msg.id, ok: false, error: `FakeNativeBrowser has no handler for "${msg.method}"` });
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

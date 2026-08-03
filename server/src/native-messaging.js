import { EventEmitter } from 'node:events';

/**
 * Chrome/Firefox native-messaging wire framing: every message is a 32-bit
 * little-endian byte length followed by that many bytes of UTF-8 JSON.
 *
 * The two directions have different limits, and conflating them is a defect:
 *
 *  - host -> browser is capped by the browser at 1 MB. Everything we send is a
 *    command (`rpc`, `hello_ack`, `pong`), all of them tiny, so the cap is
 *    enforced on our writer with a little headroom: an oversize command is a
 *    hard error naming the method, never a truncation and never a frame the
 *    browser would answer by killing the pipe.
 *  - browser -> host may be up to 4 GB. Results travel this way, and a
 *    `browser_eval` value or a `browser_screenshot` base64 blob legitimately
 *    exceeds 1 MB. Applying the outbound cap to the decoder would throw inside
 *    the decoder, close the channel and take the whole host (and its MCP
 *    endpoint) down over one large result. The inbound bound is therefore
 *    generous and exists only to catch a desynchronised stream.
 *
 * The extension additionally bounds each individual result before it emits it
 * (see MAX_RPC_RESULT_BYTES in extension/background.js), so an unreasonable
 * payload fails as one `ok:false` RPC instead of as an oversize frame.
 */
export const MAX_OUTBOUND_MESSAGE_BYTES = 1024 * 1024 - 1024;

/** Inbound bound: a length header above this means the stream is corrupt. */
export const MAX_INBOUND_MESSAGE_BYTES = 128 * 1024 * 1024;

const HEADER_BYTES = 4;

/**
 * Encodes one native message. Throws when the payload exceeds `maxBytes`
 * (the host->browser cap by default; the browser->host direction passes the
 * inbound bound instead).
 */
export function encodeMessage(value, { maxBytes = MAX_OUTBOUND_MESSAGE_BYTES } = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > maxBytes) {
    const what = value && value.kind === 'rpc' && value.method ? `rpc "${value.method}"` : 'Native message';
    throw new Error(
      `${what} is ${body.length} bytes, over the ${maxBytes}-byte native-messaging limit for this direction. ` +
        'The browser would drop the connection; shrink the payload instead.'
    );
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder for the native-messaging byte stream. Feed it chunks;
 * it yields whole messages as they complete.
 */
export class MessageDecoder {
  constructor({ maxMessageBytes = MAX_INBOUND_MESSAGE_BYTES } = {}) {
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
  }

  /** Returns every message completed by this chunk, in order. */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const out = [];
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) return out;
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageBytes) {
        // A length this large means the stream is desynchronised or the peer is
        // not speaking native messaging. There is no honest way to resync.
        throw new Error(
          `Native message header claims ${length} bytes, over the ${this.maxMessageBytes}-byte limit. ` +
            'The native-messaging stream is corrupt.'
        );
      }
      if (this.buffer.length < HEADER_BYTES + length) return out;
      const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8');
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      out.push(JSON.parse(body));
    }
  }
}

/**
 * A duplex native-messaging channel over a pair of streams (stdin/stdout when
 * the browser spawned us).
 *
 * Emits "message" per decoded message, "close" when the browser closes the
 * pipe, and "error" for framing/parse failures.
 */
export class NativeMessagingChannel extends EventEmitter {
  constructor({ input, output }) {
    super();
    this.input = input;
    this.output = output;
    this.open = true;
    this.decoder = new MessageDecoder();

    input.on('data', (chunk) => this.#onData(chunk));
    input.on('end', () => this.#onClose());
    input.on('close', () => this.#onClose());
    input.on('error', () => this.#onClose());
    output.on('error', () => this.#onClose());
  }

  isOpen() {
    return this.open;
  }

  /** Writes one framed message. Returns false when the pipe is already closed. */
  send(value) {
    if (!this.open) return false;
    this.output.write(encodeMessage(value));
    return true;
  }

  close() {
    this.#onClose();
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.emit('error', err);
      this.#onClose();
      return;
    }
    for (const message of messages) this.emit('message', message);
  }

  #onClose() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

import { EventEmitter } from 'node:events';

/**
 * Chrome/Firefox native-messaging wire framing: every message is a 32-bit
 * little-endian byte length followed by that many bytes of UTF-8 JSON.
 *
 * The browser refuses to deliver a message larger than 1 MB to the host, and
 * refuses to accept one larger than 1 MB back (Chrome's host->browser limit is
 * documented as 1 MB too; Firefox's is the same). Both directions are checked
 * here so an oversize payload fails loudly on our side with a message naming
 * the size, instead of the browser silently killing the pipe.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const HEADER_BYTES = 4;

/** Encodes one native message. Throws when the payload exceeds the 1 MB cap. */
export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new Error(
      `Native message is ${body.length} bytes, over the ${MAX_MESSAGE_BYTES}-byte native-messaging limit. ` +
        'The browser would drop the connection; split or shrink the payload instead.'
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
  constructor({ maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
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

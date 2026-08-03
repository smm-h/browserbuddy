/**
 * Correlation table for in-flight RPCs to the extension. Shared by every
 * transport (WebSocket hub, native-messaging host) so request ids, timeouts
 * and the "settle everything on disconnect" rule have exactly one
 * implementation.
 */
export class PendingRpcs {
  constructor() {
    this.nextId = 1;
    this.entries = new Map();
  }

  /** Number of RPCs still awaiting an answer. */
  get size() {
    return this.entries.size;
  }

  /**
   * Allocates an id, arms the timeout, and returns { id, promise }. The caller
   * sends the request itself so the wire format stays with the transport.
   */
  create(method, timeoutMs) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the extension to complete "${method}".`));
      }, timeoutMs);
      this.entries.set(id, { resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Settles the rpc with the given id. Returns false when the id is unknown. */
  settle(id, ok, valueOrMessage) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(valueOrMessage);
    else entry.reject(new Error(valueOrMessage || 'Extension reported an unspecified error.'));
    return true;
  }

  /** Rejects every in-flight rpc so no caller is left hanging. */
  rejectAll(message) {
    for (const [id, entry] of this.entries) {
      clearTimeout(entry.timer);
      this.entries.delete(id);
      entry.reject(new Error(message));
    }
  }

  /** Discards an entry whose send failed before it could ever be answered. */
  discard(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
  }
}

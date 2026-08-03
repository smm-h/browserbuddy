import fs from 'node:fs';
import path from 'node:path';

const RING_CAPACITY = 1000;

/**
 * The canonical set of event types this host knows about, and the only place
 * the list exists. docs/PROTOCOL.md §4.3 is its normative counterpart.
 *
 * An event whose type is not in here is NOT dropped: it is stored with an
 * `unknown: true` marker (see append). A newer extension emitting a type an
 * older host has never heard of must be observable, not silently lost.
 */
export const KNOWN_EVENT_TYPES = new Set([
  // Background script (browser-level).
  'tab_created',
  'tab_closed',
  'tab_activated',
  'navigation',
  'page_loaded',
  'download_started',
  'window_focus',
  // Content script (page-level).
  'click',
  'input',
  'form_submit',
  'key_command',
  'scroll',
  'copy',
  'paste'
]);

/**
 * In-memory ring buffer of the most recent events plus an append-only JSONL
 * log on disk (one file per UTC day).
 */
export class EventStore {
  constructor({ dataDir, capacity = RING_CAPACITY } = {}) {
    if (!dataDir) throw new Error('EventStore requires a dataDir');
    this.dataDir = dataDir;
    this.eventsDir = path.join(dataDir, 'events');
    this.capacity = capacity;
    this.buffer = [];
    this.highestSeq = 0;
    this.waiters = new Set();
    this.ensuredDayFile = null;
    this.warnedUnknownTypes = new Set();
  }

  append(event) {
    // Record-with-a-marker, never drop: absence must be observable.
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      event.unknown = true;
      if (!this.warnedUnknownTypes.has(event.type)) {
        this.warnedUnknownTypes.add(event.type);
        console.error(
          `[browserbuddy] event type "${String(event.type)}" is not known to this host; ` +
            'storing it intact with unknown:true. The extension is probably newer than the host.'
        );
      }
    }
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    if (typeof event.seq === 'number' && event.seq > this.highestSeq) {
      this.highestSeq = event.seq;
    }
    this.#writeLine(event);
    this.#notifyWaiters(event);
    return event;
  }

  query({ sinceSeq, types, actor, limit } = {}) {
    let matches = this.buffer;
    if (typeof sinceSeq === 'number') {
      matches = matches.filter((e) => e.seq > sinceSeq);
    }
    if (Array.isArray(types) && types.length > 0) {
      const wanted = new Set(types);
      matches = matches.filter((e) => wanted.has(e.type));
    }
    if (actor && actor !== 'all') {
      matches = matches.filter((e) => e.actor === actor);
    }
    if (typeof limit === 'number' && limit >= 0 && matches.length > limit) {
      // Keep the most recent n matches.
      matches = matches.slice(matches.length - limit);
    }
    return matches.slice();
  }

  /**
   * Resolves with the first event arriving AFTER this call that matches the
   * filter, or null when timeoutMs elapses first.
   */
  waitFor({ types, tabId, actor = 'user' } = {}, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const waiter = {
        types: Array.isArray(types) && types.length > 0 ? new Set(types) : null,
        tabId: typeof tabId === 'number' ? tabId : null,
        actor: actor && actor !== 'all' ? actor : null,
        resolve,
        timer: null
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  eventCount() {
    return this.buffer.length;
  }

  latestSeq() {
    return this.highestSeq;
  }

  #notifyWaiters(event) {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.actor && event.actor !== waiter.actor) continue;
      if (waiter.types && !waiter.types.has(event.type)) continue;
      if (waiter.tabId !== null && event.tabId !== waiter.tabId) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }

  #writeLine(event) {
    const stamp = typeof event.receivedAt === 'number' ? event.receivedAt : Date.now();
    const day = new Date(stamp).toISOString().slice(0, 10);
    const file = path.join(this.eventsDir, `${day}.jsonl`);
    try {
      // Only re-create the directory when the day file rolls over.
      if (this.ensuredDayFile !== file) {
        fs.mkdirSync(this.eventsDir, { recursive: true });
        this.ensuredDayFile = file;
      }
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch (err) {
      console.error(`[browserbuddy] fatal: cannot append to the event log ${file}: ${err.message}`);
      process.exit(1);
    }
  }
}

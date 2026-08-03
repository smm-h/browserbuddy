import fs from 'node:fs';
import path from 'node:path';

const RING_CAPACITY = 1000;

/** Holds the highest seq ever assigned, so a restart resumes instead of restarting. */
const SEQ_FILENAME = 'seq.json';

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

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
 * Every value an event's `actor` may take, and the only place the set is
 * enumerated. docs/PROTOCOL.md §6 is its normative counterpart.
 *
 * `replay` is **reserved** for deterministic playback of a recorded
 * demonstration and nothing emits it yet: a replayed step is neither the user
 * acting nor the agent acting, and collapsing it into either would corrupt
 * `browser_wait_for_user` (the replayer would wake itself) and poison the next
 * recording. The name is claimed now so nothing else can take it and so
 * `browser_observe {actor: "replay"}` is already a valid, empty query.
 *
 * Note this is the set of values an *event* carries; the observation tools
 * additionally accept the pseudo-value `all`, which is a filter, not an actor.
 */
export const ACTOR_VALUES = Object.freeze(['user', 'agent', 'replay']);

/**
 * In-memory ring buffer of the most recent events plus an append-only JSONL
 * log on disk (one file per UTC day).
 *
 * Both survive a restart. The browser tears its background context down
 * routinely and every teardown respawns the host, while the MCP endpoint stays
 * the same -- so a client's `sinceSeq` must keep meaning what it meant, and
 * "everything since I last looked" must still return the events themselves.
 * On construction the store therefore resumes its counter past the highest seq
 * it ever assigned and refills the ring from the JSONL log.
 */
export class EventStore {
  constructor({ dataDir, capacity = RING_CAPACITY } = {}) {
    if (!dataDir) throw new Error('EventStore requires a dataDir');
    this.dataDir = dataDir;
    this.eventsDir = path.join(dataDir, 'events');
    this.seqFile = path.join(dataDir, SEQ_FILENAME);
    this.capacity = capacity;
    this.buffer = [];
    this.highestSeq = 0;
    this.waiters = new Set();
    this.ensuredDayFile = null;
    this.ensuredDataDir = false;
    this.warnedUnknownTypes = new Set();
    this.#restore();
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
      this.#writeSeq();
    }
    this.#writeLine(event);
    this.#notifyWaiters(event);
    return event;
  }

  /** `actor` is one of ACTOR_VALUES, or `all`/undefined to disable the filter. */
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
   * filter, or null when timeoutMs elapses first. `actor` takes the same values
   * as query()'s; it defaults to `user` because the only caller,
   * browser_wait_for_user, must never wake on the agent's own actions.
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

  /**
   * Rebuilds the counter and the ring from disk. Every failure mode here is a
   * recoverable startup condition, reported on stderr -- a corrupt seq file or
   * a half-written last line must not stop the host from starting. What it must
   * never do is quietly restart the counter at 1 while events exist: that would
   * hand out seq values a client has already seen.
   */
  #restore() {
    const persistedSeq = this.#readSeq();
    const { events, maxSeq } = this.#readRecentEvents();
    this.buffer = events;
    this.highestSeq = Math.max(persistedSeq, maxSeq);
    if (persistedSeq === 0 && maxSeq > 0) {
      console.error(
        `[browserbuddy] ${SEQ_FILENAME} was missing or unusable; resuming the event sequence from ` +
          `${maxSeq}, the highest seq found in the event log.`
      );
    }
    if (this.buffer.length > 0) {
      console.error(
        `[browserbuddy] reloaded ${this.buffer.length} event(s) from the log; ` +
          `the sequence continues at ${this.highestSeq + 1}.`
      );
    }
  }

  /** The persisted highest-assigned seq, or 0 when there is nothing usable. */
  #readSeq() {
    let raw;
    try {
      raw = fs.readFileSync(this.seqFile, 'utf8');
    } catch (err) {
      // A fresh data directory is the normal case, not a problem worth naming.
      if (err.code !== 'ENOENT') {
        console.error(`[browserbuddy] cannot read ${this.seqFile}: ${err.message}`);
      }
      return 0;
    }
    try {
      const parsed = JSON.parse(raw);
      const seq = parsed?.seq;
      if (!Number.isInteger(seq) || seq < 0) throw new Error(`"seq" is not a non-negative integer: ${String(seq)}`);
      return seq;
    } catch (err) {
      console.error(`[browserbuddy] ${this.seqFile} is corrupt (${err.message}); falling back to the event log.`);
      return 0;
    }
  }

  #writeSeq() {
    try {
      if (!this.ensuredDataDir) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        this.ensuredDataDir = true;
      }
      // Temp file plus rename: a reader (or the next launch) never sees a
      // half-written counter, which is the one way this file could lie.
      const tmp = `${this.seqFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ seq: this.highestSeq })}\n`);
      fs.renameSync(tmp, this.seqFile);
    } catch (err) {
      console.error(
        `[browserbuddy] fatal: cannot persist the event sequence to ${this.seqFile}: ${err.message}. ` +
          'Continuing would hand out seq values a client has already seen after the next restart.'
      );
      process.exit(1);
    }
  }

  /**
   * The newest `capacity` events across day files, oldest first, plus the
   * highest seq seen while reading. Files are read newest-first and reading
   * stops as soon as the ring is full, so a long history costs one file read.
   */
  #readRecentEvents() {
    let days;
    try {
      days = fs
        .readdirSync(this.eventsDir)
        .filter((name) => DAY_FILE_RE.test(name))
        .sort()
        .reverse();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[browserbuddy] cannot list ${this.eventsDir}: ${err.message}`);
      }
      return { events: [], maxSeq: 0 };
    }

    const chunks = [];
    let collected = 0;
    let maxSeq = 0;
    for (const day of days) {
      const file = path.join(this.eventsDir, day);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        console.error(`[browserbuddy] cannot read ${file}: ${err.message}; skipping it.`);
        continue;
      }
      const parsed = [];
      let damaged = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // A truncated last line is what a killed process leaves behind.
          damaged += 1;
          continue;
        }
        if (!event || typeof event !== 'object') {
          damaged += 1;
          continue;
        }
        if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
        parsed.push(event);
      }
      if (damaged > 0) {
        console.error(`[browserbuddy] skipped ${damaged} unreadable line(s) in ${file}.`);
      }
      // Whole-file scan for maxSeq above, newest slice for the ring here.
      const take = parsed.slice(Math.max(0, parsed.length - (this.capacity - collected)));
      chunks.push(take);
      collected += take.length;
      if (collected >= this.capacity) break;
    }

    chunks.reverse();
    const events = chunks.flat();
    // Ascending seq is what query()/sinceSeq assume; the log is already in
    // arrival order, but a day boundary or a truncated line must not skew it.
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { events, maxSeq };
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

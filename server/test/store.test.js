import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventStore, KNOWN_EVENT_TYPES } from '../src/store.js';
import { makeTmpDir, removeTmpDir, makeEvent } from './helpers.js';

describe('EventStore', () => {
  let dir;
  let store;
  let seq;

  beforeEach(() => {
    dir = makeTmpDir('store');
    store = new EventStore({ dataDir: dir });
    seq = 0;
  });

  afterEach(() => {
    removeTmpDir(dir);
  });

  const push = (overrides = {}) => store.append(makeEvent({ seq: ++seq, ...overrides }));

  test('ring buffer caps at 1000 events, keeping the most recent', () => {
    for (let i = 0; i < 1200; i += 1) push({ type: 'scroll' });
    assert.equal(store.eventCount(), 1000);
    assert.equal(store.latestSeq(), 1200);
    const all = store.query({});
    assert.equal(all.length, 1000);
    assert.equal(all[0].seq, 201);
    assert.equal(all[all.length - 1].seq, 1200);
  });

  test('query filters by sinceSeq', () => {
    for (let i = 0; i < 5; i += 1) push();
    const got = store.query({ sinceSeq: 3 });
    assert.deepEqual(got.map((e) => e.seq), [4, 5]);
  });

  test('query filters by types', () => {
    push({ type: 'click' });
    push({ type: 'navigation' });
    push({ type: 'input' });
    push({ type: 'navigation' });
    const got = store.query({ types: ['navigation'] });
    assert.deepEqual(got.map((e) => e.seq), [2, 4]);
  });

  test('query filters by actor, and "all"/undefined disable the filter', () => {
    push({ actor: 'user' });
    push({ actor: 'agent' });
    push({ actor: 'user' });
    assert.deepEqual(store.query({ actor: 'user' }).map((e) => e.seq), [1, 3]);
    assert.deepEqual(store.query({ actor: 'agent' }).map((e) => e.seq), [2]);
    assert.equal(store.query({ actor: 'all' }).length, 3);
    assert.equal(store.query({}).length, 3);
  });

  test('limit keeps the most recent matches', () => {
    for (let i = 0; i < 10; i += 1) push();
    const got = store.query({ limit: 3 });
    assert.deepEqual(got.map((e) => e.seq), [8, 9, 10]);
  });

  test('limit applies after the other filters', () => {
    for (let i = 0; i < 6; i += 1) push({ type: i % 2 === 0 ? 'click' : 'scroll' });
    const got = store.query({ types: ['click'], limit: 2 });
    assert.deepEqual(got.map((e) => e.seq), [3, 5]);
  });

  test('every appended event is written as one JSONL line for its receivedAt day', () => {
    const receivedAt = Date.parse('2026-03-09T10:00:00.000Z');
    push({ receivedAt, type: 'click' });
    push({ receivedAt, type: 'navigation' });
    const file = path.join(dir, 'events', '2026-03-09.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'click');
    assert.equal(JSON.parse(lines[1]).seq, 2);
  });

  test('waitFor resolves only on events arriving after the call', async () => {
    push({ type: 'click' });
    const pending = store.waitFor({ types: ['click'] }, 2000);
    const later = makeEvent({ seq: 99, type: 'click' });
    setTimeout(() => store.append(later), 10);
    const got = await pending;
    assert.equal(got.seq, 99);
  });

  test('waitFor ignores non-matching events and honours actor/tabId filters', async () => {
    const pending = store.waitFor({ types: ['navigation'], tabId: 7, actor: 'user' }, 2000);
    setTimeout(() => {
      store.append(makeEvent({ seq: 1, type: 'click', tabId: 7 }));
      store.append(makeEvent({ seq: 2, type: 'navigation', tabId: 8 }));
      store.append(makeEvent({ seq: 3, type: 'navigation', tabId: 7, actor: 'agent' }));
      store.append(makeEvent({ seq: 4, type: 'navigation', tabId: 7 }));
    }, 10);
    const got = await pending;
    assert.equal(got.seq, 4);
  });

  test('waitFor resolves null on timeout', async () => {
    const got = await store.waitFor({ types: ['click'] }, 50);
    assert.equal(got, null);
  });

  describe('restart continuity', () => {
    /** A new store on the same data dir is exactly what a host respawn builds. */
    const restart = () => new EventStore({ dataDir: dir });

    const writeDay = (day, events) => {
      fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'events', `${day}.jsonl`),
        events.map((e) => `${JSON.stringify(e)}\n`).join('')
      );
    };

    test('seq continues where the previous run stopped', () => {
      for (let i = 0; i < 5; i += 1) push();
      assert.equal(store.latestSeq(), 5);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'seq.json'), 'utf8')).seq, 5);

      const reborn = restart();
      assert.equal(reborn.latestSeq(), 5, 'the counter resumes, it does not reset');
      const next = reborn.append(makeEvent({ seq: reborn.latestSeq() + 1, type: 'click' }));
      assert.equal(next.seq, 6);
    });

    test('the ring is repopulated with the previous run"s events', () => {
      push({ type: 'navigation', url: 'https://a.test/' });
      push({ type: 'click', data: { selector: '#go' } });

      const reborn = restart();
      assert.equal(reborn.eventCount(), 2);
      assert.deepEqual(reborn.query({}).map((e) => [e.seq, e.type]), [[1, 'navigation'], [2, 'click']]);
      // "Everything since I last looked" must still answer with real events.
      assert.deepEqual(reborn.query({ sinceSeq: 1 }).map((e) => e.seq), [2]);
    });

    test('reload spans day files newest-first and keeps ascending seq order', () => {
      const day = (d, seqs) =>
        writeDay(
          d,
          seqs.map((seq) => makeEvent({ seq, receivedAt: Date.parse(`${d}T12:00:00.000Z`) }))
        );
      day('2026-03-07', [1, 2]);
      day('2026-03-08', [3, 4]);
      day('2026-03-09', [5, 6]);

      const reborn = restart();
      assert.deepEqual(reborn.query({}).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
      assert.equal(reborn.latestSeq(), 6);
    });

    test('reload stops at the ring capacity, keeping the newest events', () => {
      const small = new EventStore({ dataDir: dir, capacity: 3 });
      for (let i = 1; i <= 5; i += 1) small.append(makeEvent({ seq: i }));

      const reborn = new EventStore({ dataDir: dir, capacity: 3 });
      assert.deepEqual(reborn.query({}).map((e) => e.seq), [3, 4, 5]);
      assert.equal(reborn.latestSeq(), 5);
    });

    test('a corrupt seq.json falls back to the highest seq in the log', () => {
      for (let i = 0; i < 4; i += 1) push();
      fs.writeFileSync(path.join(dir, 'seq.json'), '{"seq": not-json');

      const reborn = restart();
      assert.equal(reborn.latestSeq(), 4, 'the log is the fallback, not a reset to 0');
      assert.equal(reborn.eventCount(), 4);
    });

    test('a missing seq.json still does not restart the sequence at 1', () => {
      for (let i = 0; i < 3; i += 1) push();
      fs.rmSync(path.join(dir, 'seq.json'));

      const reborn = restart();
      assert.equal(reborn.latestSeq(), 3);
    });

    test('a truncated last JSONL line is skipped, not fatal', () => {
      push();
      push();
      const file = path.join(dir, 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, '{"seq":3,"type":"cli');

      const reborn = restart();
      assert.deepEqual(reborn.query({}).map((e) => e.seq), [1, 2]);
      assert.equal(reborn.latestSeq(), 2);
    });

    test('a seq.json ahead of the log wins', () => {
      // The log can be pruned or rotated away; the counter must never go back.
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'seq.json'), JSON.stringify({ seq: 900 }));
      writeDay('2026-03-09', [makeEvent({ seq: 4 })]);

      const reborn = restart();
      assert.equal(reborn.latestSeq(), 900);
    });

    test('a fresh data dir starts at seq 0 with an empty ring', () => {
      const freshDir = makeTmpDir('store-fresh');
      try {
        const fresh = new EventStore({ dataDir: freshDir });
        assert.equal(fresh.latestSeq(), 0);
        assert.equal(fresh.eventCount(), 0);
      } finally {
        removeTmpDir(freshDir);
      }
    });
  });

  describe('unknown event types', () => {
    test('an unrecognised type is stored intact and marked unknown', () => {
      const event = push({ type: 'quantum_entangled', data: { payload: 'keep me' } });
      assert.equal(event.unknown, true);
      const [stored] = store.query({});
      assert.equal(stored.type, 'quantum_entangled');
      assert.equal(stored.data.payload, 'keep me', 'the payload must survive intact');
      assert.equal(stored.unknown, true);
    });

    test('the marker is written to the JSONL log too', () => {
      const receivedAt = Date.parse('2026-03-09T10:00:00.000Z');
      push({ receivedAt, type: 'not_a_real_type' });
      const line = fs.readFileSync(path.join(dir, 'events', '2026-03-09.jsonl'), 'utf8').trim();
      assert.equal(JSON.parse(line).unknown, true);
    });

    test('known types are not marked', () => {
      for (const type of KNOWN_EVENT_TYPES) {
        const event = push({ type });
        assert.equal(event.unknown, undefined, `${type} must not be marked unknown`);
      }
    });

    test('every type the extension can emit is known', () => {
      // The protocol's event table and this set are the same list; drift here
      // would mark real events as unknown.
      const protocolTypes = [
        'tab_created',
        'tab_closed',
        'tab_activated',
        'navigation',
        'page_loaded',
        'click',
        'input',
        'form_submit',
        'key_command',
        'scroll',
        'copy',
        'paste',
        'download_started',
        'window_focus'
      ];
      assert.deepEqual([...KNOWN_EVENT_TYPES].sort(), protocolTypes.sort());
    });
  });
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventStore } from '../src/store.js';
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
});

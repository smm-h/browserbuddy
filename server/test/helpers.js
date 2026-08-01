import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TMP_ROOT = path.join(TEST_ROOT, '.tmp');
export const SERVER_ROOT = path.resolve(TEST_ROOT, '..');

let counter = 0;

export function makeTmpDir(label) {
  counter += 1;
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Builds an event as the extension would send it, pre-stamped with seq/receivedAt. */
export function makeEvent(overrides = {}) {
  const now = Date.now();
  return {
    ts: now,
    actor: 'user',
    type: 'click',
    tabId: 1,
    url: 'https://example.com/',
    data: {},
    seq: 1,
    receivedAt: now,
    ...overrides
  };
}

/** Ports are partitioned per test file to avoid collisions between parallel runs. */
export function portFor(base, offset = 0) {
  return base + offset;
}

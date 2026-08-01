import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCli, DEFAULT_DATA_DIR, VERSION } from '../src/cli.js';
import { SERVER_ROOT } from './helpers.js';

const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * These drive strictcli in-process. Nothing here runs `serve` itself: that
 * handler binds a port and never returns, and it is covered end to end by
 * mcp.test.js, which spawns the real bin.
 */
describe('CLI', () => {
  test('--help lists the serve command and exits 0', async () => {
    const r = await createCli().test(['--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /serve/);
    assert.equal(r.stderr, '');
  });

  test('serve --help documents both flags without leaking an absolute path', async () => {
    const r = await createCli().test(['serve', '--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /--port/);
    assert.match(r.stdout, /default: 8590/);
    assert.match(r.stdout, /--data-dir/);
    assert.match(r.stdout, /server\/data/);
    // The help string is baked into .strictcli/schema.json and the generated
    // docs, so it must never interpolate the machine-specific resolved path.
    assert.ok(
      !r.stdout.includes(DEFAULT_DATA_DIR),
      'serve --help must not embed the absolute default data dir'
    );
  });

  test('the default data dir is server/data', () => {
    assert.equal(DEFAULT_DATA_DIR, path.join(SERVER_ROOT, 'data'));
  });

  test('unknown flags are rejected', async () => {
    const r = await createCli().test(['serve', '--bogus']);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown flag '--bogus'/);
    assert.equal(r.stdout, '');
  });

  test('unknown commands are rejected', async () => {
    const r = await createCli().test(['start']);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown command/i);
  });

  test('--port rejects a non-integer value', async () => {
    const r = await createCli().test(['serve', '--port', 'eightfivenine']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, '');
  });

  test('--port rejects a value outside the TCP range', async () => {
    const r = await createCli().test(['serve', '--port', '70000']);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /invalid --port value/);
    assert.equal(r.stdout, '');
  });

  test('--version reports the package version', async () => {
    const r = await createCli().test(['--version']);
    assert.equal(r.exitCode, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, VERSION);
    assert.match(r.stdout, new RegExp(VERSION.replace(/\./g, '\\.')));
  });
});

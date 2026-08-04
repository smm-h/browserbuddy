import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCli, DEFAULT_DATA_DIR, VERSION } from '../src/cli.js';
import { chromeExtensionIdFromKey, HOST_NAME } from '../src/host-manifest.js';
import { writeEndpointFile } from '../src/endpoint-file.js';
import { claudeAddArgv, CLIENT_NAME } from '../src/client-config.js';
import { makeTmpDir, removeTmpDir, SERVER_ROOT } from './helpers.js';

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

  test('install-host requires --browser and rejects anything but chrome/firefox', async () => {
    const missing = await createCli().test(['install-host']);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /--browser/);

    const wrong = await createCli().test(['install-host', '--browser', 'safari']);
    assert.equal(wrong.exitCode, 1);
    assert.match(wrong.stderr, /chrome/);
  });

  test('install-host writes a chrome manifest and launcher into the named profile', async () => {
    // The install writes to Linux-specific locations and hard-errors elsewhere,
    // so this test asserts the Linux behaviour on Linux and the refusal
    // everywhere else -- never a silent install into the wrong place.
    const tmp = makeTmpDir('install-host');
    try {
      const profile = path.join(tmp, 'profile');
      const dataDir = path.join(tmp, 'data');
      const r = await createCli().test([
        'install-host',
        '--browser',
        'chrome',
        '--user-data-dir',
        profile,
        '--data-dir',
        dataDir
      ]);
      if (process.platform !== 'linux') {
        assert.equal(r.exitCode, 1);
        assert.match(r.stderr, /Linux-only/);
        return;
      }
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, '', 'the CLI never writes to stdout');

      const manifestPath = path.join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const extManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
      assert.equal(manifest.name, HOST_NAME);
      assert.deepEqual(manifest.allowed_origins, [
        `chrome-extension://${chromeExtensionIdFromKey(extManifest.key)}/`
      ]);
      assert.ok(path.isAbsolute(manifest.path), 'the manifest path must be absolute');
      assert.equal(fs.statSync(manifest.path).mode & 0o111, 0o111, 'the launcher must be executable');

      const launcher = fs.readFileSync(manifest.path, 'utf8');
      assert.ok(
        launcher.includes(path.join(SERVER_ROOT, 'src', 'native-host-bin.js')),
        'the launcher must exec the installed host script by absolute path'
      );
      assert.ok(launcher.includes(dataDir), 'the launcher must bake in --data-dir');
    } finally {
      removeTmpDir(tmp);
    }
  });

  test('install-host refuses the wrong browser\'s profile flag', async () => {
    const r = await createCli().test(['install-host', '--browser', 'firefox', '--user-data-dir', '/tmp/x']);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--user-data-dir applies to Chrome only/);
  });

  test('install-host writes a firefox manifest keyed on HOME', async () => {
    if (process.platform !== 'linux') return;
    const tmp = makeTmpDir('install-host-ff');
    try {
      const r = await createCli().test(['install-host', '--browser', 'firefox', '--home', tmp, '--data-dir', path.join(tmp, 'data')]);
      assert.equal(r.exitCode, 0);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tmp, '.mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`), 'utf8')
      );
      const extManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.allowed_extensions, [extManifest.browser_specific_settings.gecko.id]);
      assert.equal(manifest.allowed_origins, undefined);
      assert.ok(path.isAbsolute(manifest.path));
    } finally {
      removeTmpDir(tmp);
    }
  });

  test('client-config --help documents both flags and the --apply default', async () => {
    const r = await createCli().test(['client-config', '--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /--data-dir/);
    assert.match(r.stdout, /--apply/);
    // Registering must never be the default: it rewrites the user's config.
    assert.match(r.stdout, /default: false/);
    assert.match(r.stdout, /server\/data/);
    assert.ok(
      !r.stdout.includes(DEFAULT_DATA_DIR),
      'client-config --help must not embed the absolute default data dir'
    );
  });

  test('client-config prints the claude registration for a live endpoint', async () => {
    const tmp = makeTmpDir('client-config-live');
    try {
      const url = 'http://127.0.0.1:45671/mcp';
      const token = 'test-token-0123456789abcdef';
      // process.pid is alive by definition, so the descriptor reads as live.
      writeEndpointFile(tmp, { url, token, pid: process.pid });

      const r = await createCli().test(['client-config', '--data-dir', tmp]);
      assert.equal(r.exitCode, 0);
      assert.equal(r.stderr, '');
      assert.match(r.stdout, /claude mcp add --transport http browserbuddy /);
      assert.ok(r.stdout.includes(url), 'the printed command must carry the live url');
      assert.ok(r.stdout.includes(`Authorization: Bearer ${token}`), 'the printed command must carry the token');
      // The manual block must be valid JSON a user can paste, not prose.
      const block = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
      const parsed = JSON.parse(block);
      assert.equal(parsed.mcpServers[CLIENT_NAME].url, url);
      assert.equal(parsed.mcpServers[CLIENT_NAME].headers.Authorization, `Bearer ${token}`);
    } finally {
      removeTmpDir(tmp);
    }
  });

  test('client-config hard-errors with the whole procedure when no endpoint exists', async () => {
    const tmp = makeTmpDir('client-config-missing');
    try {
      const r = await createCli().test(['client-config', '--data-dir', tmp]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.stdout, '', 'a failure must print nothing pasteable');
      assert.match(r.stderr, /no live MCP endpoint/);
      assert.ok(r.stderr.includes(tmp), 'the error must name the directory it searched');
      assert.match(r.stderr, /install-host --browser chrome/);
      assert.match(r.stderr, /spawned by the BROWSER/);
      assert.match(r.stderr, /client-config/);
    } finally {
      removeTmpDir(tmp);
    }
  });

  test('client-config treats a descriptor from a dead host as no endpoint', async () => {
    const tmp = makeTmpDir('client-config-stale');
    try {
      // A pid that has certainly exited: the child is reaped before spawnSync
      // returns. Recycling it within the test window would be a lottery win.
      const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
      assert.ok(Number.isInteger(deadPid), 'need a real pid to stale out');
      writeEndpointFile(tmp, { url: 'http://127.0.0.1:45672/mcp', token: 'stale-token', pid: deadPid });

      const r = await createCli().test(['client-config', '--data-dir', tmp]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /no live MCP endpoint/);
      assert.match(r.stderr, /no longer running/);
    } finally {
      removeTmpDir(tmp);
    }
  });

  test('the applied argv is exactly the claude mcp add HTTP form', () => {
    // --apply runs this vector directly (no shell), so it is asserted verbatim
    // rather than by matching the printed string.
    assert.deepEqual(claudeAddArgv({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }), [
      'mcp',
      'add',
      '--transport',
      'http',
      'browserbuddy',
      'http://127.0.0.1:1/mcp',
      '--header',
      'Authorization: Bearer tok'
    ]);
  });

  test('--version reports the package version', async () => {
    const r = await createCli().test(['--version']);
    assert.equal(r.exitCode, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, VERSION);
    assert.match(r.stdout, new RegExp(VERSION.replace(/\./g, '\\.')));
  });
});

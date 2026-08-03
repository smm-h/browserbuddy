import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCli, DEFAULT_DATA_DIR, VERSION } from '../src/cli.js';
import { chromeExtensionIdFromKey, HOST_NAME } from '../src/host-manifest.js';
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

  test('--version reports the package version', async () => {
    const r = await createCli().test(['--version']);
    assert.equal(r.exitCode, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, VERSION);
    assert.match(r.stdout, new RegExp(VERSION.replace(/\./g, '\\.')));
  });
});

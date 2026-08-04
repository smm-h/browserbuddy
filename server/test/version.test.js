import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { VERSION } from '../src/version.js';
import { SERVER_ROOT, makeTmpDir, removeTmpDir } from './helpers.js';

const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-manifest-version.mjs');

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), 'utf8'));
}

/** Every .js under server/src/, the same walk the stdout tripwire uses. */
function srcFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The release tool bumps package.json, pypi/pyproject.toml and selfdoc.json --
 * nothing else. Every other version string in the project must therefore be
 * derived from one of those, or it starts lying at the first release.
 */
describe('version single-sourcing', () => {
  test('the shared helper reports package.json\'s version', () => {
    assert.equal(VERSION, readJson(REPO_ROOT, 'package.json').version);
  });

  test('no file under server/src/ hardcodes a semver literal', () => {
    const offenders = [];
    for (const file of srcFiles(path.join(SERVER_ROOT, 'src'))) {
      if (/['"]\d+\.\d+\.\d+['"]/.test(fs.readFileSync(file, 'utf8'))) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test('the CLI reports the package version', () => {
    const stdout = execFileSync(process.execPath, [path.join(SERVER_ROOT, 'src', 'index.js'), '--version'], {
      encoding: 'utf8'
    });
    assert.match(stdout, new RegExp(VERSION.replace(/\./g, '\\.')));
  });

  test('the extension derives its handshake version from its own manifest', () => {
    const background = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'background.js'), 'utf8');
    assert.match(background, /const VERSION = ext\.runtime\.getManifest\(\)\.version;/);
  });
});

/**
 * extension/manifest.json is the one version literal nothing can derive: the
 * extension has no build step. The guardrail therefore has to be a check, and
 * these tests pin both of its outcomes -- a passing check is worthless if the
 * failing case does not actually fail.
 */
describe('check-manifest-version.mjs', () => {
  /** A miniature repo (package.json + extension/manifest.json + the script). */
  function fixture(pkgVersion, manifestVersion) {
    const dir = makeTmpDir('manifest-version');
    fs.mkdirSync(path.join(dir, 'extension'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: pkgVersion }));
    fs.writeFileSync(
      path.join(dir, 'extension', 'manifest.json'),
      JSON.stringify({ version: manifestVersion })
    );
    fs.copyFileSync(CHECK_SCRIPT, path.join(dir, 'scripts', 'check-manifest-version.mjs'));
    return dir;
  }

  function run(dir) {
    try {
      const stderr = execFileSync(
        process.execPath,
        [path.join(dir, 'scripts', 'check-manifest-version.mjs')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return { code: 0, stdout: stderr, stderr: '' };
    } catch (err) {
      return { code: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  }

  test('passes when the two versions agree', () => {
    const dir = fixture('1.2.3', '1.2.3');
    try {
      assert.equal(run(dir).code, 0);
    } finally {
      removeTmpDir(dir);
    }
  });

  test('fails, naming both versions, when they drift', () => {
    const dir = fixture('0.2.0', '0.1.0');
    try {
      const result = run(dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /package\.json is 0\.2\.0 but extension\/manifest\.json is 0\.1\.0/);
    } finally {
      removeTmpDir(dir);
    }
  });

  test('the real tree passes: manifest and package versions are in lockstep', () => {
    assert.equal(readJson(REPO_ROOT, 'extension', 'manifest.json').version, VERSION);
  });
});

/**
 * The stamper is what makes the two versions agree during a release. It rewrites
 * the manifest textually, so what needs pinning is that it changes the version
 * line and nothing else -- a stamper that reformatted the file, or that matched
 * some other version-like string, would land in a release commit unreviewed.
 */
describe('stamp-manifest-version.mjs', () => {
  const STAMP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'stamp-manifest-version.mjs');

  /** A miniature repo holding the real manifest and a copy of the stamper. */
  function fixture() {
    const dir = makeTmpDir('stamp-manifest-version');
    fs.mkdirSync(path.join(dir, 'extension'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(
      path.join(REPO_ROOT, 'extension', 'manifest.json'),
      path.join(dir, 'extension', 'manifest.json')
    );
    fs.copyFileSync(STAMP_SCRIPT, path.join(dir, 'scripts', 'stamp-manifest-version.mjs'));
    return dir;
  }

  /** spawnSync, not execFileSync: the stamper reports on stderr even when it succeeds. */
  function run(dir, ...args) {
    const result = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', 'stamp-manifest-version.mjs'), ...args],
      { encoding: 'utf8' }
    );
    return { code: result.status, stderr: result.stderr };
  }

  function manifestOf(dir) {
    return fs.readFileSync(path.join(dir, 'extension', 'manifest.json'), 'utf8');
  }

  test('changes the version line and leaves every other line untouched', () => {
    const dir = fixture();
    try {
      const before = manifestOf(dir).split('\n');
      assert.equal(run(dir, '9.9.9').code, 0);
      const after = manifestOf(dir).split('\n');

      assert.equal(after.length, before.length);
      const changed = before
        .map((line, i) => (line === after[i] ? null : i))
        .filter((i) => i !== null);
      assert.equal(changed.length, 1);
      assert.match(after[changed[0]], /"version": "9\.9\.9"/);
      assert.equal(JSON.parse(after.join('\n')).version, '9.9.9');
    } finally {
      removeTmpDir(dir);
    }
  });

  test('leaves the Firefox strict_min_version alone', () => {
    const dir = fixture();
    try {
      const before = JSON.parse(manifestOf(dir));
      run(dir, '9.9.9');
      const after = JSON.parse(manifestOf(dir));
      assert.equal(
        after.browser_specific_settings.gecko.strict_min_version,
        before.browser_specific_settings.gecko.strict_min_version
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  test('refuses an argument that is not a version', () => {
    const dir = fixture();
    try {
      const before = manifestOf(dir);
      const result = run(dir, 'latest');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not a version string/);
      assert.equal(manifestOf(dir), before);
    } finally {
      removeTmpDir(dir);
    }
  });

  test('refuses to run with no argument at all', () => {
    const dir = fixture();
    try {
      const before = manifestOf(dir);
      const result = run(dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /usage/);
      assert.equal(manifestOf(dir), before);
    } finally {
      removeTmpDir(dir);
    }
  });

  test('is a no-op when the manifest already carries the version', () => {
    const dir = fixture();
    try {
      const before = manifestOf(dir);
      const result = run(dir, VERSION);
      assert.equal(result.code, 0);
      assert.match(result.stderr, /already at/);
      assert.equal(manifestOf(dir), before);
    } finally {
      removeTmpDir(dir);
    }
  });
});

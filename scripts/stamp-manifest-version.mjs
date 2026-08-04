#!/usr/bin/env node
// Writes a version into extension/manifest.json's "version" field.
//
// The counterpart to check-manifest-version.mjs: that script proves the
// manifest and package.json agree, this one is how they come to agree. The
// extension has no build step, so its manifest version is the one literal the
// release tool's version bump does not reach -- rlsbl's pre-release hook runs
// this with the version it is about to write to package.json, and folds the
// result into the release commit, so the two are equal in every commit.
//
// The rewrite is textual on purpose. Round-tripping through JSON.stringify
// would reformat unrelated parts of the file (single-line arrays expand, and a
// manifest is a file humans read); replacing only the version value keeps the
// diff to the one line that changed. Both the input and the result are parsed,
// and the result is compared field-by-field against the input, so a rewrite
// that touched anything but the version is a hard error rather than a surprise
// in the release commit.

import { readFileSync, writeFileSync } from 'node:fs';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const manifestPath = new URL('../extension/manifest.json', import.meta.url);
const version = process.argv[2];

function fail(message) {
  console.error(`stamp-manifest-version: ${message}`);
  process.exit(1);
}

if (!version) {
  fail('usage: stamp-manifest-version.mjs <version>');
}
if (!SEMVER.test(version)) {
  fail(`"${version}" is not a version string`);
}

let before;
try {
  before = readFileSync(manifestPath, 'utf8');
} catch (err) {
  fail(`cannot read extension/manifest.json: ${err.message}`);
}

let parsedBefore;
try {
  parsedBefore = JSON.parse(before);
} catch (err) {
  fail(`extension/manifest.json is not valid JSON: ${err.message}`);
}

const current = parsedBefore.version;
if (typeof current !== 'string' || current === '') {
  fail('extension/manifest.json has no "version" string');
}

if (current === version) {
  console.error(`extension/manifest.json is already at ${version}.`);
  process.exit(0);
}

// The manifest's own version value, matched by its key so no other version-like
// string in the file (strict_min_version, a CSP port, a description) can match.
const versionField = /("version"\s*:\s*")(?:[^"\\]*)(")/;
const matches = before.match(new RegExp(versionField.source, 'g')) || [];
if (matches.length !== 1) {
  fail(`expected exactly one "version" field in extension/manifest.json, found ${matches.length}`);
}

const after = before.replace(versionField, `$1${version}$2`);

let parsedAfter;
try {
  parsedAfter = JSON.parse(after);
} catch (err) {
  fail(`rewrite produced invalid JSON: ${err.message}`);
}
if (parsedAfter.version !== version) {
  fail(`rewrite left the version at ${parsedAfter.version}`);
}
if (JSON.stringify({ ...parsedAfter, version: current }) !== JSON.stringify(parsedBefore)) {
  fail('rewrite changed something other than the version; refusing to write');
}

writeFileSync(manifestPath, after);
console.error(`extension/manifest.json: ${current} -> ${version}`);

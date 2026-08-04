#!/usr/bin/env node
// Fails when extension/manifest.json's version disagrees with package.json's.
//
// The release tool bumps package.json; the extension has no build step, so its
// manifest version is an irreducible literal that nothing bumps for us. Every
// other version string in the project is derived (server/src/version.js reads
// package.json, background.js reads the manifest), so this one comparison is
// the whole remaining surface for version drift -- and it is a preflight check
// rather than a warning, so a release cannot ship a manifest that lies.

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

function versionOf(relativePath) {
  const url = new URL(relativePath, root);
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${relativePath}: ${err.message}`);
  }
  const version = JSON.parse(text).version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${relativePath} has no "version" string`);
  }
  return version;
}

try {
  const pkg = versionOf('package.json');
  const manifest = versionOf('extension/manifest.json');
  if (pkg !== manifest) {
    console.error(
      `Version drift: package.json is ${pkg} but extension/manifest.json is ${manifest}.\n` +
        `Set "version": "${pkg}" in extension/manifest.json. The extension has no build step, ` +
        'so its manifest version is the one literal the release bump does not reach: bump it in ' +
        'the same commit that prepares the release.'
    );
    process.exit(1);
  }
  console.error(`extension/manifest.json and package.json agree on ${pkg}.`);
} catch (err) {
  console.error(`check-manifest-version: ${err.message}`);
  process.exit(1);
}

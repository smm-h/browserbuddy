#!/usr/bin/env node
/**
 * Entry point for the native-messaging host. This file is what the browser
 * executes: the host manifest's "path" points at a launcher that execs
 * `node <this file> --data-dir <dir>`.
 *
 * It deliberately does NOT use strictcli. The browser appends its own
 * arguments (Chrome: the calling extension's origin; Firefox: the manifest
 * path and the extension id), and a strict parser would reject them and kill
 * the host before it ever spoke a word.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNativeHost } from './native-host.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = path.join(SERVER_DIR, 'data');

/** Reads our own flags and ignores everything the browser appended. */
function readOption(name) {
  const i = process.argv.indexOf(name);
  return i > 1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dataDir = readOption('--data-dir') ? path.resolve(readOption('--data-dir')) : DEFAULT_DATA_DIR;
const portArg = readOption('--http-port');

// fd 1 is the native-messaging channel from here on. Give the channel its own
// handle to it, then point process.stdout at stderr: any library or stray
// console.log now lands in the browser's host log instead of injecting bytes
// into the frame stream, where they would desynchronise it irrecoverably.
const nativeOut = fs.createWriteStream(null, { fd: 1 });
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);

process.stdin.pause();

let host = null;

startNativeHost({
  input: process.stdin,
  output: nativeOut,
  dataDir,
  // No --http-port means "inherit the persisted endpoint identity", not 0:
  // passing 0 here would discard the port the client is already talking to.
  port: portArg ? Number(portArg) : undefined,
  onExit: () => process.exit(0)
})
  .then((started) => {
    host = started;
    process.stdin.resume();
  })
  .catch((err) => {
    console.error(`[browserbuddy] native host failed to start: ${err.stack || err.message}`);
    process.exit(1);
  });

// A signal must run the same shutdown the closed pipe runs. Exiting straight
// from the handler would leave mcp-endpoint.json behind, pointing every future
// client at a port that no longer exists.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!host) process.exit(0);
    host.shutdown(`received ${signal}`).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

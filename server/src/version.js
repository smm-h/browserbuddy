import { readFileSync } from 'node:fs';

/**
 * The single source of the version this process reports -- the CLI's
 * `--version`/`--help`, the MCP server's advertised implementation version, and
 * the `serverVersion` in the handshake ack all read it from here.
 *
 * It is read from package.json rather than written as a literal because the
 * release tool bumps package.json and nothing else under server/src/: a literal
 * here would silently lie from the first release onward. package.json sits two
 * levels above this file both in the repo and in the published npm tarball
 * (which ships server/src/ under the package root), so the same relative
 * resolution holds in both.
 */
export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

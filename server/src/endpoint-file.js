import fs from 'node:fs';
import path from 'node:path';

/**
 * Name of the file the native host writes so an MCP client can find the live
 * endpoint. The host is spawned by the browser, so nobody else knows the
 * ephemeral port or the per-launch token until this file exists.
 */
export const ENDPOINT_FILENAME = 'mcp-endpoint.json';

/**
 * Name of the file that carries the endpoint *identity* across host restarts.
 * The browser respawns the host on every background teardown; without this the
 * client's url and bearer token would silently change under it. The host reuses
 * the recorded token always, and the recorded port when it is still bindable.
 */
export const ENDPOINT_STATE_FILENAME = 'endpoint-state.json';

export const ENDPOINT_SCHEMA_VERSION = 1;

export function endpointPath(dataDir) {
  return path.join(dataDir, ENDPOINT_FILENAME);
}

export function endpointStatePath(dataDir) {
  return path.join(dataDir, ENDPOINT_STATE_FILENAME);
}

/**
 * Reads the persisted endpoint identity, or null when there is none. It holds
 * a bearer token, so it is written 0600 like the descriptor. A malformed file
 * is a hard error: silently minting a new token would be exactly the
 * client-invalidating churn this file exists to prevent.
 */
export function readEndpointState(dataDir) {
  let raw;
  try {
    raw = fs.readFileSync(endpointStatePath(dataDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const state = JSON.parse(raw);
  if (typeof state.token !== 'string' || !Number.isInteger(state.port)) {
    throw new Error(
      `${endpointStatePath(dataDir)} is missing a string "token" or an integer "port". ` +
        'Delete it to start a fresh endpoint identity.'
    );
  }
  return { token: state.token, port: state.port };
}

/** Records the identity the next host launch should try to reuse. */
export function writeEndpointState(dataDir, { token, port }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = endpointStatePath(dataDir);
  const payload = {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    token,
    port,
    updatedAt: new Date().toISOString()
  };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Writes the endpoint descriptor atomically with owner-only permissions. The
 * file carries a bearer token, so it must never be group- or world-readable,
 * and a reader must never observe a half-written file.
 */
export function writeEndpointFile(dataDir, { url, token, pid = process.pid, extra = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = endpointPath(dataDir);
  const payload = {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    transport: 'streamable-http',
    url,
    token,
    pid,
    startedAt: new Date().toISOString(),
    ...extra,
    // Ready to paste into an MCP client config: same url, same bearer.
    mcpServers: {
      browserbuddy: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
    }
  };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  return target;
}

/** True when a process with this pid exists and we may signal it. */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user, which for a
    // 0600 file we wrote ourselves should not happen -- still, it is alive.
    return err.code === 'EPERM';
  }
}

/**
 * Reads the endpoint descriptor, or null when there is no *live* endpoint.
 *
 * A host that was killed rather than shut down leaves its descriptor behind,
 * and a client that dialled it would get a connection refused on a port that
 * may since have been handed to something else entirely. The recorded pid is
 * therefore checked: a file whose pid is gone is stale and reads as absent,
 * exactly as PROTOCOL.md §1.1 specifies. A malformed or pid-less file is a hard
 * error -- it is not a state we ever write, so guessing about it would hide a
 * real problem.
 */
export function readEndpointFile(dataDir) {
  let raw;
  try {
    raw = fs.readFileSync(endpointPath(dataDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const descriptor = JSON.parse(raw);
  if (!Number.isInteger(descriptor.pid)) {
    throw new Error(
      `${endpointPath(dataDir)} has no integer "pid", so its liveness cannot be checked. ` +
        'Delete it and let the browser respawn the native host.'
    );
  }
  return pidIsAlive(descriptor.pid) ? descriptor : null;
}

/** Removes the descriptor. A stale file would point clients at a dead port. */
export function removeEndpointFile(dataDir) {
  try {
    fs.unlinkSync(endpointPath(dataDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

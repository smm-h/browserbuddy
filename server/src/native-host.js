import { NativeMessagingChannel } from './native-messaging.js';
import { NativeHub } from './native-hub.js';
import { EventStore } from './store.js';
import { DemoRecorder } from './demos.js';
import { createMcpServer } from './mcp.js';
import { startHttpMcp, generateToken } from './http-mcp.js';
import {
  writeEndpointFile,
  removeEndpointFile,
  endpointPath,
  readEndpointState,
  writeEndpointState
} from './endpoint-file.js';

/**
 * The native-messaging host: a normal OS process the *browser* spawns via
 * ext.runtime.connectNative(). Because it is an ordinary process it may listen
 * on a socket, which an extension may not -- so it, not the extension, is the
 * MCP server.
 *
 *   MCP client --HTTP(+bearer)--> host --native-messaging stdio--> extension --> pages
 *
 * Two hard rules live here:
 *  - fd 1 is the native-messaging channel. Nothing else may write to it. The
 *    caller (native-host-bin.js) redirects the process-level stdout stream to
 *    stderr before this runs, so a stray log line cannot corrupt the frames.
 *  - when the browser closes the pipe, the host exits. There is no reconnect:
 *    the browser owns our lifetime, and a host outliving its extension would
 *    hold a stale endpoint file and a stale port.
 *
 * The browser tears its background context down constantly, and every teardown
 * respawns us. So the endpoint has an *identity* that outlives one launch: the
 * bearer token and the port are persisted in endpoint-state.json and reused, so
 * an MCP client configured once keeps working across respawns. `token` and
 * `port` here override that identity (tests and --http-port); leave them
 * undefined to inherit it.
 */
export async function startNativeHost({ input, output, dataDir, token, port, onExit }) {
  const persisted = readEndpointState(dataDir);
  const resolvedToken = token ?? persisted?.token ?? generateToken();
  const desiredPort = port ?? persisted?.port ?? 0;

  const channel = new NativeMessagingChannel({ input, output });
  const hub = new NativeHub({ channel });
  const store = new EventStore({ dataDir });
  const demos = new DemoRecorder({ dataDir });

  hub.on('event', (event) => {
    store.append(event);
    if (demos.isRecording()) demos.capture(event);
  });

  // Node sets SO_REUSEADDR on listen(), so the previous launch's TIME_WAIT
  // sockets do not stand in the way of reclaiming the same port. A port taken
  // by a *live* listener is the one case we cannot reclaim: bind ephemeral and
  // say so, loudly, because the client's url just changed.
  const createServer = () => createMcpServer({ hub, store, demos });
  let http;
  try {
    http = await startHttpMcp({ createServer, token: resolvedToken, port: desiredPort });
  } catch (err) {
    if (desiredPort === 0 || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) throw err;
    console.error(
      `[browserbuddy] the previous MCP port ${desiredPort} is held by another process (${err.code}); ` +
        'binding an ephemeral port instead. The endpoint url changes -- re-read mcp-endpoint.json. ' +
        'The bearer token is unchanged.'
    );
    http = await startHttpMcp({ createServer, token: resolvedToken, port: 0 });
  }

  // Written before the descriptor: the identity the next respawn must reuse.
  writeEndpointState(dataDir, { token: http.token, port: http.port });

  const file = writeEndpointFile(dataDir, {
    url: http.url,
    token: http.token,
    extra: { dataDir }
  });
  console.error(`[browserbuddy] native host serving MCP at ${http.url} (endpoint file: ${file})`);

  let closing = false;
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    console.error(`[browserbuddy] native host shutting down: ${reason}`);
    await http.close();
    removeEndpointFile(dataDir);
    await hub.close();
    if (onExit) onExit(reason);
  };

  hub.on('close', () => shutdown('the browser closed the native-messaging pipe'));

  return {
    hub,
    store,
    demos,
    channel,
    url: http.url,
    token: http.token,
    port: http.port,
    endpointFile: endpointPath(dataDir),
    shutdown
  };
}

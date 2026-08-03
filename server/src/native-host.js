import { NativeMessagingChannel } from './native-messaging.js';
import { NativeHub } from './native-hub.js';
import { EventStore } from './store.js';
import { DemoRecorder } from './demos.js';
import { createMcpServer } from './mcp.js';
import { startHttpMcp, generateToken } from './http-mcp.js';
import { writeEndpointFile, removeEndpointFile, endpointPath } from './endpoint-file.js';

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
 */
export async function startNativeHost({ input, output, dataDir, token = generateToken(), port = 0, onExit }) {
  const channel = new NativeMessagingChannel({ input, output });
  const hub = new NativeHub({ channel });
  const store = new EventStore({ dataDir });
  const demos = new DemoRecorder({ dataDir });

  hub.on('event', (event) => {
    store.append(event);
    if (demos.isRecording()) demos.capture(event);
  });

  const http = await startHttpMcp({
    createServer: () => createMcpServer({ hub, store, demos }),
    token,
    port
  });

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

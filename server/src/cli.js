import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, defineCommand, flag, t } from 'strictcli';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub.js';
import { EventStore } from './store.js';
import { DemoRecorder } from './demos.js';
import { createMcpServer } from './mcp.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Event logs and demonstrations live under server/data/ regardless of cwd. */
export const DEFAULT_DATA_DIR = path.join(SERVER_DIR, 'data');

export const VERSION = '0.1.0';

/**
 * Starts the WebSocket hub and the MCP stdio server, then resolves. The process
 * stays alive on the open handles until SIGINT/SIGTERM.
 *
 * stdout belongs to the MCP stdio protocol: every diagnostic here goes to
 * stderr, and the strictcli handler must never use ctx.info (which writes to
 * stdout).
 */
export async function startServer({ port, dataDir }) {
  const store = new EventStore({ dataDir });
  const demos = new DemoRecorder({ dataDir });
  const hub = new Hub({ port });

  hub.on('event', (event) => {
    store.append(event);
    if (demos.isRecording()) demos.capture(event);
  });

  try {
    await hub.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[browserbuddy] port ${port} is already in use. Another BrowserBuddy server is probably running. ` +
          'Stop it, or start this one with --port <other port> (and edit the port constant in extension/background.js to match).'
      );
    } else {
      console.error(`[browserbuddy] failed to start the WebSocket hub: ${err.message}`);
    }
    process.exit(1);
  }
  console.error(`[browserbuddy] hub listening on ws://127.0.0.1:${port}/ws (data dir: ${dataDir})`);

  const server = createMcpServer({ hub, store, demos });
  await server.connect(new StdioServerTransport());
  console.error('[browserbuddy] MCP stdio server ready');

  const shutdown = async () => {
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Builds the CLI app. Separate from the bin entry point so tests can drive it. */
export function createCli() {
  const app = createApp({
    name: 'browserbuddy',
    version: VERSION,
    help: 'Share one browser between you and your coding agent: an MCP stdio server plus the WebSocket hub the BrowserBuddy extension connects to.'
  });

  app.command(
    defineCommand('serve', {
      help: 'Run the MCP stdio server and the WebSocket hub the browser extension connects to.',
      flags: {
        port: flag('port', t.int, {
          help: 'WebSocket hub port on 127.0.0.1. Must match WS_URL in extension/background.js.',
          default: 8590n
        }),
        data_dir: flag('data-dir', t.str, {
          help: 'Directory for event logs and recorded demonstrations. Defaults to server/data inside the installed package.',
          default: null
        })
      },
      handler: async (args) => {
        const port = Number(args.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          console.error(`[browserbuddy] invalid --port value: ${args.port}`);
          return 1;
        }
        const dataDir = args.data_dir === undefined ? DEFAULT_DATA_DIR : path.resolve(args.data_dir);
        await startServer({ port, dataDir });
        return undefined;
      }
    })
  );

  return app;
}

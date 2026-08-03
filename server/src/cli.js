import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, defineCommand, flag, t } from 'strictcli';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub.js';
import { EventStore } from './store.js';
import { DemoRecorder } from './demos.js';
import { createMcpServer } from './mcp.js';
import { installNativeHost, DEFAULT_HOST_DATA_DIR, BROWSER_CHOICES } from './install-host.js';
import { ENDPOINT_FILENAME } from './endpoint-file.js';

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
          'Stop it, or start this one with --port <other port> and point the extension at that port by ' +
          'editing WS_URL in extension/background.js. Note that the extension ships with TRANSPORT set to ' +
          "'native', where it does not use this hub at all: it spawns the native host itself " +
          '(install it with `browserbuddy install-host`).'
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
    help: 'Share one browser between you and your coding agent. install-host sets up the native-messaging host the extension spawns by default; serve runs the MCP stdio server with the WebSocket hub for builds that use the WebSocket carrier instead.'
  });

  app.command(
    defineCommand('serve', {
      help: 'Run the MCP stdio server and the WebSocket hub. Only the WebSocket carrier uses this: with the extension\'s default native transport the browser spawns the host itself (see install-host).',
      flags: {
        port: flag('port', t.int, {
          help: 'WebSocket hub port on 127.0.0.1. Must match WS_URL in extension/background.js, which only applies when that file sets TRANSPORT to websocket.',
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

  app.command(
    defineCommand('install-host', {
      help: 'Install the native-messaging host manifest so the browser can spawn the BrowserBuddy host (which serves MCP over loopback HTTP).',
      flags: {
        browser: flag('browser', t.str, {
          help: 'Which browser to install for. "chrome" covers the whole Chromium family.',
          choices: BROWSER_CHOICES
        }),
        user_data_dir: flag('user-data-dir', t.str, {
          help: 'Chrome only: the browser profile directory (--user-data-dir). Defaults to the first Chrome or Chromium profile directory that exists under your home.',
          default: null
        }),
        home: flag('home', t.str, {
          help: 'Firefox only: the HOME whose .mozilla/native-messaging-hosts receives the manifest. Defaults to your home directory.',
          default: null
        }),
        data_dir: flag('data-dir', t.str, {
          help: 'Directory the installed host will use for event logs, demonstrations and its endpoint files. Defaults to server/data inside the installed package.',
          default: null
        })
      },
      handler: async (args) => {
        const browser = args.browser;
        const userDataDir = args.user_data_dir === undefined ? null : path.resolve(args.user_data_dir);
        const home = args.home === undefined ? null : path.resolve(args.home);
        const dataDir = args.data_dir === undefined ? DEFAULT_HOST_DATA_DIR : path.resolve(args.data_dir);

        // The two profile flags are browser-specific. Accepting the wrong one
        // silently would install the manifest where that browser never looks.
        if (browser === 'chrome' && home !== null) {
          console.error('[browserbuddy] --home applies to Firefox only; for Chrome pass --user-data-dir.');
          return 1;
        }
        if (browser === 'firefox' && userDataDir !== null) {
          console.error('[browserbuddy] --user-data-dir applies to Chrome only; for Firefox pass --home.');
          return 1;
        }

        let result;
        try {
          result = installNativeHost({
            browser,
            profileDir: userDataDir,
            homeDir: home,
            dataDir
          });
        } catch (err) {
          console.error(`[browserbuddy] install-host failed: ${err.message}`);
          return 1;
        }

        // stderr, not stdout: nothing under server/src/ may write to fd 1.
        console.error(`[browserbuddy] extension id:  ${result.extensionId}`);
        console.error(`[browserbuddy] manifest:      ${result.manifestPath}`);
        console.error(`[browserbuddy] launcher:      ${result.launcherPath}`);
        console.error(`[browserbuddy] host script:   ${result.hostScript}`);
        console.error(`[browserbuddy] host data dir: ${result.dataDir}`);
        console.error(
          `[browserbuddy] endpoint file: ${path.join(result.dataDir, ENDPOINT_FILENAME)} ` +
            '(written once the browser spawns the host; point your MCP client at the url and token it contains)'
        );
        return 0;
      }
    })
  );

  return app;
}

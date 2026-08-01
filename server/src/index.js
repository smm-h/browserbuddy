#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub.js';
import { EventStore } from './store.js';
import { DemoRecorder } from './demos.js';
import { createMcpServer } from './mcp.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { port: 8590, dataDir: path.join(PACKAGE_ROOT, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        console.error(`[browserbuddy] invalid --port value: ${argv[i]}`);
        process.exit(1);
      }
      options.port = value;
    } else if (arg === '--data-dir') {
      const value = argv[++i];
      if (!value) {
        console.error('[browserbuddy] --data-dir requires a path');
        process.exit(1);
      }
      options.dataDir = path.resolve(value);
    } else {
      console.error(`[browserbuddy] unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

async function main() {
  const { port, dataDir } = parseArgs(process.argv.slice(2));

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

main().catch((err) => {
  console.error(`[browserbuddy] fatal: ${err.stack || err.message}`);
  process.exit(1);
});

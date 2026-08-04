import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defineCommand, flag, t } from 'strictcli';
import { readEndpointFile, endpointPath, ENDPOINT_FILENAME } from './endpoint-file.js';

/**
 * `browserbuddy client-config`: the bridge between a host the browser spawned
 * and an MCP client that has to be told where it is.
 *
 * On the native-messaging carrier nobody can know the endpoint in advance --
 * the browser starts the host, and the host picks the port and mints the token
 * (PROTOCOL.md 1.1). This command reads the descriptor the host published and
 * turns it into the exact registration a user can paste, or run.
 *
 * **This file is the CLI's stdout owner.** Everything else under server/src/
 * writes only to stderr, because fd 1 there belongs to a protocol -- the MCP
 * stdio channel under `serve`, the native-messaging frame stream under the
 * host. `client-config` is a plain CLI command that produces a result, and a
 * result belongs on stdout so it can be piped. It writes through `ctx.info`
 * and never touches the process-level stdout stream, so strictcli's own
 * capture sees the output and the tripwire in mcp.test.js stays exact: that
 * stream still has exactly one owner (the host entry point), and this is the
 * only file in the tree that may use `ctx.info`.
 */

/** The MCP server name registered with the client. */
export const CLIENT_NAME = 'browserbuddy';

/** The Claude Code binary. Resolved through PATH; absent means a hard error. */
export const CLAUDE_BIN = 'claude';

/**
 * The argv for `claude mcp add`, as a real argument vector (never a shell
 * string): this is what --apply executes, so nothing here goes through a shell.
 * The flag names are Claude Code's own -- `--transport http` selects the
 * Streamable-HTTP client and `--header` sets the bearer.
 */
export function claudeAddArgv({ url, token }, { name = CLIENT_NAME, scope = null } = {}) {
  return [
    'mcp',
    'add',
    '--transport',
    'http',
    ...(scope ? ['--scope', scope] : []),
    name,
    url,
    '--header',
    `Authorization: Bearer ${token}`
  ];
}

/**
 * The same registration as one copy-pasteable shell line. Only the header is
 * quoted: it is the one argument containing a space, and the token is
 * base64url, so no other argument can need quoting.
 */
export function claudeAddCommand(endpoint, options = {}) {
  const argv = claudeAddArgv(endpoint, options);
  return [CLAUDE_BIN, ...argv]
    .map((part) => (part.includes(' ') ? `"${part}"` : part))
    .join(' ');
}

/**
 * The manual-configuration block: the same url and bearer as an `mcpServers`
 * entry. The host already publishes one in the descriptor; it is reused rather
 * than rebuilt, so the two can never drift.
 */
export function mcpServersBlock(descriptor) {
  const entry = descriptor.mcpServers ?? {
    [CLIENT_NAME]: {
      type: 'http',
      url: descriptor.url,
      headers: { Authorization: `Bearer ${descriptor.token}` }
    }
  };
  return JSON.stringify({ mcpServers: entry }, null, 2);
}

/**
 * What to say when there is no live endpoint. The failure is almost never
 * "something crashed" -- it is "the browser has not spawned the host yet", and
 * the user cannot fix that by retrying this command. So the message is the
 * whole ordered procedure, and it names the directory that was searched.
 */
export function noEndpointMessage(dataDir) {
  return (
    `[browserbuddy] no live MCP endpoint in ${dataDir}\n` +
    `[browserbuddy] looked for: ${endpointPath(dataDir)} (absent, or left by a host that is no longer running)\n` +
    '[browserbuddy] the native host is spawned by the BROWSER, not by this command, so the endpoint file\n' +
    '[browserbuddy] appears only once the extension has connected. In order:\n' +
    '[browserbuddy]   1. browserbuddy install-host --browser chrome      (or --browser firefox)\n' +
    '[browserbuddy]   2. load or re-enable the BrowserBuddy extension in that browser -- it spawns the host\n' +
    '[browserbuddy]   3. browserbuddy client-config\n' +
    `[browserbuddy] if you installed the host with a different --data-dir, pass the same one here.`
  );
}

/**
 * The printed result, as lines. Every non-command line is a `#` comment, so the
 * whole block can be pasted into a shell and only the registration runs.
 */
export function renderClientConfig(descriptor, { dataDir, name = CLIENT_NAME } = {}) {
  return [
    `# BrowserBuddy MCP endpoint (host pid ${descriptor.pid}, from ${path.join(dataDir, ENDPOINT_FILENAME)})`,
    `#   url:   ${descriptor.url}`,
    `#   token: ${descriptor.token}`,
    '',
    '# Register it with Claude Code (add --scope user to share it across projects):',
    claudeAddCommand(descriptor, { name }),
    '',
    '# Or paste this into an MCP client config by hand:',
    mcpServersBlock(descriptor),
    '',
    '# Then restart Claude Code, or run /mcp in a running session, so it picks the server up.',
    '# The url and token survive host respawns, so this registration keeps working.'
  ];
}

/** Runs `claude mcp add` for real. Returns { ok, detail }; never throws on a non-zero exit. */
export function applyWithClaude(descriptor, { name = CLIENT_NAME } = {}) {
  const argv = claudeAddArgv(descriptor, { name });
  const run = spawnSync(CLAUDE_BIN, argv, { encoding: 'utf8' });
  if (run.error) {
    const why =
      run.error.code === 'ENOENT'
        ? `${CLAUDE_BIN} is not on PATH; install Claude Code, or drop --apply and run the printed command yourself`
        : run.error.message;
    return { ok: false, detail: why };
  }
  if (run.status !== 0) {
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    return {
      ok: false,
      detail:
        `${CLAUDE_BIN} mcp add exited ${run.status}${output ? `: ${output}` : ''}. ` +
        `If "${name}" is already registered, remove it first: ${CLAUDE_BIN} mcp remove ${name}`
    };
  }
  return { ok: true, detail: `${CLAUDE_BIN} mcp add registered "${name}" at ${descriptor.url}` };
}

/**
 * The strictcli command. It lives here rather than in cli.js so that the file
 * allowed to write to stdout is exactly the file that has a result to print.
 */
export function clientConfigCommand({ defaultDataDir }) {
  return defineCommand('client-config', {
    help:
      'Print the MCP client registration for the running native host: the exact `claude mcp add` command, and the equivalent config block. Reads the endpoint the host published once the browser spawned it.',
    flags: {
      data_dir: flag('data-dir', t.str, {
        help: 'Directory the host writes its endpoint files to -- the same --data-dir the host was installed with. Defaults to server/data inside the installed package.',
        default: null
      }),
      apply: flag('apply', t.bool, {
        help: 'Run `claude mcp add` instead of only printing it. Off by default: registering rewrites your Claude Code config, which should be a choice, not a side effect of asking where the endpoint is.',
        default: false
      })
    },
    handler: async (args, ctx) => {
      const dataDir = args.data_dir === undefined ? defaultDataDir : path.resolve(args.data_dir);

      let descriptor;
      try {
        descriptor = readEndpointFile(dataDir);
      } catch (err) {
        console.error(`[browserbuddy] could not read the endpoint descriptor: ${err.message}`);
        return 1;
      }
      if (!descriptor) {
        console.error(noEndpointMessage(dataDir));
        return 1;
      }
      if (typeof descriptor.url !== 'string' || typeof descriptor.token !== 'string') {
        console.error(
          `[browserbuddy] ${endpointPath(dataDir)} has no string "url" and "token"; it is not a descriptor this version wrote. Delete it and let the browser respawn the host.`
        );
        return 1;
      }

      if (args.apply) {
        const result = applyWithClaude(descriptor);
        if (!result.ok) {
          console.error(`[browserbuddy] --apply failed: ${result.detail}`);
          return 1;
        }
        console.error(`[browserbuddy] ${result.detail}`);
        console.error('[browserbuddy] restart Claude Code, or run /mcp, so it picks the server up.');
        return 0;
      }

      for (const line of renderClientConfig(descriptor, { dataDir })) ctx.info(line);
      return 0;
    }
  });
}

---
title: CLAUDE.md
description: "BrowserBuddy CLAUDE.md template -- component map, hard invariants, verification commands, and release/docs workflow for AI sessions working in the repo."
---

# BrowserBuddy

BrowserBuddy :-: var key="project.version" is a shared browser for you and your coding agent: a cross-browser MV3 WebExtension (Chrome and Firefox, one codebase) paired with a Node.js server that serves 25 MCP tools. By default **the browser starts the server**: the extension calls `connectNative`, the browser spawns `native-host-bin.js`, and that host serves Streamable-HTTP MCP on a stable loopback port behind a bearer token it publishes in `mcp-endpoint.json` — set up with `browserbuddy install-host`, attached with `browserbuddy client-config`. The older carrier (`browserbuddy serve`: MCP stdio server plus a WebSocket hub on `127.0.0.1:8590`, dialled by the extension) still works and is selected by the `TRANSPORT` constant in `background.js`. The agent acts through the tools and observes the user's own clicks, typing, navigation and downloads as a queryable event log — the same window, the same session, no debug port and no automation flags. Node 22+, no build step, no transpiler.

## Component map

- `extension/` — the WebExtension, loaded unpacked (Chrome) or as a temporary add-on (Firefox).
  - `manifest.json` — MV3 manifest; declares both background entry points (service worker for Chrome, event page for Firefox) and `strict_min_version` 128 for Firefox.
  - `background.js` — transport selection (`TRANSPORT`, `native` by default), reconnect ladder, browser-level observation (tabs, navigation, downloads), RPC dispatch, badge state. The WebSocket client is still here, dormant, reached only when `TRANSPORT` is `websocket`.
  - `transport-native.js` — the `connectNative` transport. Shares the background global scope (Chrome `importScripts`, Firefox `background.scripts`); surfaces a precise hard error naming the host and both expected manifest paths when the host cannot be spawned.
  - `content.js` — injected into pages: DOM observation, selector construction, redaction, and the page-level half of the RPC surface.
- `server/src/` — the Node process.
  - `index.js` — `browserbuddy` bin entry point; runs the CLI and reports fatal errors on stderr.
  - `cli.js` — strictcli app (`serve` with `--port`, `--data-dir`; `install-host` with `--browser`, `--user-data-dir`/`--home`, `--data-dir`; `client-config`), plus `startServer` which wires hub, store, demos and the MCP server together.
  - `client-config.js` — the `client-config` command: reads the live endpoint descriptor and renders the MCP client registration (`claude mcp add --transport http …` plus an `mcpServers` block), or hard-errors with the whole setup order. `--apply` runs the registration; printing is the default. The CLI's only stdout writer.
  - `hub.js` — WebSocket server: one extension connection at a time, RPC request/response correlation with timeouts, event fan-out.
  - `rpc-peer.js` — `PendingRpcs`, the one in-flight RPC table both transports use.
  - `native-host-bin.js` — the executable the browser spawns via `connectNative`. Deliberately not a strictcli app: the browser appends its own arguments. Hands fd 1 to the framing channel and points the process stdout stream at stderr.
  - `native-messaging.js` — the browser's wire framing: 32-bit little-endian length + UTF-8 JSON, incremental decoder, and the per-direction size caps (host → browser just under 1 MB, browser → host 128 MB).
  - `native-hub.js` — the Hub interface (`isConnected`/`rpc`/`event`) over the native pipe, so `mcp.js` is transport-blind.
  - `http-mcp.js` — Streamable-HTTP MCP on an ephemeral loopback port behind a bearer token; one MCP session per `initialize`.
  - `endpoint-file.js` — atomic, mode-0600 `mcp-endpoint.json` (the live url and token an MCP client dials, validated against the host's pid on read) and `endpoint-state.json` (the token and port the next host respawn reuses).
  - `host-manifest.js` — Chrome/Firefox native-messaging host manifests, the launcher script, and the Chrome-id-from-key derivation.
  - `install-host.js` — the one implementation of the host install (manifest + launcher, platform-default profile discovery, Linux-only guard), used by both `browserbuddy install-host` and `scripts/install-native-host.mjs`.
  - `store.js` — event store: 1000-entry ring buffer, per-UTC-day JSONL append, `query` and `waitFor` (the lockstep primitive).
  - `mcp.js` — the MCP tool surface: 18 acting, 3 observing, 4 learning tools, with zod schemas.
  - `demos.js` — demonstration recorder: captures user events while recording, cleans them into a replayable step list, persists one JSON file per demo.
- `server/test/` — `node --test` suite, including a fake extension driver (`fake-extension.js`) for hub/MCP tests and a fake browser (`fake-native-extension.js`) that spawns the real host over real pipes.
- `scripts/e2e-smoke.mjs` — live end-to-end smoke test of the WebSocket carrier against a real browser with the real extension.
- `scripts/spike-nativemsg.mjs` — live end-to-end proof of the native-messaging carrier: installs the host manifest into a throwaway Chromium profile, lets the browser spawn the host, then drives the MCP tools over HTTP.
- `scripts/install-native-host.mjs` — development CLI over `server/src/install-host.js`: writes the host manifest and launcher for a named Chromium user-data-dir or Firefox HOME. End users run `browserbuddy install-host --browser chrome|firefox` instead.
- `docs/` — `PROTOCOL.md` (normative wire contract) and `ARCHITECTURE.md` (components, data flow, rationale), both hand-maintained; `_README.md` and `_CLAUDE.md` are the selfdoc templates for the root files.
- `pypi/` — PyPI name-reservation placeholder package only. Not the product; do not grow it.

## Hard invariants

:<: callout-danger
:=:
::: These are non-negotiable. Breaking any of them is a defect, not a trade-off, and several are enforced by tests that will fail loudly.
:>:

- **stdout belongs to a protocol, and it has exactly one owner on each side.** Under `serve` fd 1 is the MCP stdio channel; under the native host it is the framing stream. So *diagnostics* always go to stderr, no file but `native-host-bin.js` may name the process stdout stream, and `client-config.js` — the one command whose output is a result rather than a diagnostic — is the only file allowed to use `ctx.info`. Three tripwire tests in `server/test/mcp.test.js` scan the source and fail if any of the three lines is crossed.
- **Hard errors, never silent fallbacks.** A missing extension connection, an occupied port, a CSP-blocked `browser_eval`, a Firefox screenshot without a gesture — all fail loudly with an actionable message. Never retry-with-a-different-strategy, never degrade silently, never pretend an action succeeded.
- **Redaction is a guarantee, not a filter.** Sensitive values (password inputs, `cc-*` autocomplete, and names/ids/labels matching the sensitive-field pattern) are replaced with `[REDACTED]` inside the page, before anything is sent. They must never reach the hub, the JSONL logs, the demo files, or the agent — including through click text, copy previews and paste previews.
- **Actor attribution is sacred.** Every event carries an `actor` of `user` or `agent`. Agent-driven actions must never be recorded as user events: it would corrupt `browser_wait_for_user` (the agent would wake itself), poison demonstrations, and lie to `browser_observe`.
- **`docs/PROTOCOL.md` is the normative wire contract.** Any change to message shapes, event types, RPC names or error semantics updates the protocol doc in the same change — the doc is the contract, the code follows it.
- **The extension binds `ext`, never `chrome`.** `const ext = typeof browser !== 'undefined' ? browser : chrome` gives one promise-based API on both browsers. Redeclaring `chrome` at the top level of a Chrome service worker kills the whole script; never shadow it.
- **No build step for the extension.** `extension/` is loaded as-is by both browsers. No bundler, no transpiler, no generated files — plain ES5-compatible-loading scripts that run directly.

## Verification

- `npm test` — the unit/integration suite (`node --test server/test/*.test.js`). Must be green before any commit.
- `node scripts/e2e-smoke.mjs` — live end-to-end run: spawns the real server, launches a real browser with `extension/` loaded, and exercises the MCP tools against live pages. `--browser firefox` runs the Firefox path (default is chromium); `--keep` and `--headed` help when debugging.
- `node scripts/e2e-smoke.mjs --port <n>` — the default port 8590 may be held by a live BrowserBuddy session; pass another port rather than killing the session.
- `node scripts/spike-nativemsg.mjs` — live end-to-end run of the native-messaging carrier on Chromium: the browser spawns the host, and the MCP tools are driven over the host's loopback HTTP endpoint. Needs no free port (the host picks an ephemeral one) and writes nothing outside `server/test/.tmp/`. `--idle-probe-sec N` measures whether the native port survives N seconds of an idle MV3 service worker.

## Releases

Releases go through rlsbl (`.rlsbl/`, JSONL changelog in `.rlsbl/changes/`). Every commit needs a changelog entry (`rlsbl changelog add`), and the release itself is `rlsbl release run`. Never `git push` by hand and never publish to npm or PyPI manually.

## Documentation

`README.md` and `CLAUDE.md` at the repo root are generated by selfdoc from `docs/_README.md` and `docs/_CLAUDE.md`. They carry an auto-generated header and are chmod 444 — never edit them directly. Edit the template in `docs/`, then run bare `selfdoc gen` (it auto-commits with the `Autogenerated: true` trailer). `docs/PROTOCOL.md` and `docs/ARCHITECTURE.md` are hand-maintained and are not generated.

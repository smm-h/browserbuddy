# BrowserBuddy

## What it is

BrowserBuddy turns your real Chrome browser into a space you share with an AI assistant. The assistant is not driving a separate throwaway browser somewhere off to the side — it is in the same window you are, with your logins, your tabs, and your session. It can do things for you, but it can also watch what you do, learn a task by watching you do it once, and work alongside you one step at a time.

Five capabilities:

- **Act for you.** Navigate, click, fill forms, scroll, zoom, screenshot, download, read page content, evaluate JavaScript.
- **Watch you.** Your navigation, clicks, typing, scrolling, copy/paste, tab switches and downloads stream to the assistant as a queryable event log.
- **Wait for you.** `browser_wait_for_user` blocks until your next action, so the assistant can pause mid-task and let you take over.
- **Work in lockstep.** The assistant does a step, waits for you to do yours, then continues — a genuine turn-taking loop rather than a one-shot script.
- **Learn from you.** Record a demonstration, perform the task once yourself, and the assistant keeps a cleaned step list it can replay later against different values.

## How it compares

Most browser tooling for assistants (chrome-devtools-mcp, Playwright MCP, and anything else built on the Chrome DevTools Protocol) drives a browser through a debug port — usually a fresh profile, always with an automation surface a site can detect: `navigator.webdriver`, the CDP infobar, an open debugging port. BrowserBuddy is a plain Chrome extension running in the browser you already use, so it inherits your real sessions and logins, opens no debug port, and sets no automation flags. The larger difference is direction: CDP tools only let an assistant *act*. BrowserBuddy also lets it *see* — what you clicked, what you typed, where you went — which is what makes lockstep collaboration and learning from demonstration possible at all.

## Setup

### 1. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` directory of this repo.

The toolbar badge shows a green `●` while the extension is connected to the hub, and is cleared when it is not.

The hub URL is a **hardcoded constant** in `extension/background.js`:

```js
const WS_URL = 'ws://127.0.0.1:8590/ws';
```

There is no options page and no configuration UI. If you run the server on another port, edit that line and reload the extension.

### 2. Install the server's dependencies

```
cd server && npm install
```

Node.js 20 or newer is required.

### 3. Register the MCP server with Claude Code

```
claude mcp add browserbuddy -- node /home/m/Projects/browserbuddy/server/src/index.js
```

The server accepts two flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port <n>` | `8590` | WebSocket hub port on `127.0.0.1`. If you change it, edit `WS_URL` in `extension/background.js` to match and reload the extension. |
| `--data-dir <path>` | `server/data` | Where event logs and demonstrations are written. |

### 4. Ordering does not matter

The server process runs only while a Claude Code session has the MCP server loaded; it exits with that session. The extension reconnects on its own on a fixed 1s/2s/5s/10s retry ladder, with a 30-second alarm as a backstop, so you can start Chrome first, Claude Code first, or restart either one mid-session. When the hub is down, no events are recorded and every acting tool fails loudly rather than pretending to work.

If port 8590 is already occupied, the server exits immediately instead of picking another port — a silently relocated hub would leave the extension connected to nothing.

## Tool catalog

25 MCP tools: 18 acting, 3 observing, 4 learning.

### Acting

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `browser_tabs` | — | List open tabs with id, url, title and which is active. |
| `browser_open_tab` | `url?` | Open a new tab, optionally at a URL. Returns the new tabId. |
| `browser_close_tab` | `tabId` | Close a tab. |
| `browser_focus_tab` | `tabId` | Make a tab the active one. |
| `browser_navigate` | `url`, `tabId?` | Navigate a tab to a URL. |
| `browser_back` | `tabId?` | Go back in history. |
| `browser_forward` | `tabId?` | Go forward in history. |
| `browser_reload` | `tabId?` | Reload the page. |
| `browser_read` | `mode: text\|outline\|links\|forms` (default `text`), `tabId?` | Read the page as plain text, a heading outline, a link list, or a form/field inventory. |
| `browser_screenshot` | `tabId?` | Capture the tab as a JPEG image (tab is activated first). |
| `browser_click` | `selector?` or `text?`, `tabId?` | Click an element by selector, or by visible text. At least one of the two is required. |
| `browser_fill` | `selector`, `value`, `submit?` (default `false`), `tabId?` | Set a field's value (React-compatible) and optionally submit the form. |
| `browser_scroll` | `direction: up\|down\|top\|bottom`, `amount?` (default `1`), `tabId?` | Scroll up or down by a number of viewport pages, or jump to the top or bottom. |
| `browser_zoom` | `factor`, `tabId?` | Set the tab's zoom factor (1 is 100%). |
| `browser_set_clipboard` | `text` | Put text on the system clipboard. |
| `browser_download` | `url`, `filename?` | Download a URL through the browser (with your cookies). |
| `browser_page_state` | `tabId?` | Cheap status read: url, title, readyState, scroll offset, focused element selector. |
| `browser_eval` | `code`, `tabId?` | Evaluate JavaScript in the page's main world and return the result. |

Every tool that takes an optional `tabId` defaults to the active tab of the last-focused window.

### Observing

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `browser_state` | — | Connection status, active tab, whether a demonstration is recording, and event counters (`eventCount`, `latestSeq`). If the tab lookup fails it reports `activeTabError` instead of failing the call. |
| `browser_observe` | `sinceSeq?`, `limit?` (integer 1–200, default `30`), `types?`, `actor?` (`user`\|`agent`\|`all`, default `user`) | Read recent events from the log, filtered by sequence number, type or actor. The most recent matches are kept. |
| `browser_wait_for_user` | `types?`, `tabId?`, `timeoutSec?` (integer 1–600, default `120`) | Block until your next matching action, then return that event, or `{timedOut: true}`. The lockstep primitive. |

### Learning

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `demo_record_start` | `name`, `description?`, `overwrite?` (default `false`) | Begin recording a demonstration under a name. |
| `demo_record_stop` | — | Stop recording, clean the captured steps, and persist them. |
| `demo_list` | — | List saved demonstrations with names, descriptions and step counts. |
| `demo_get` | `name` | Retrieve a demonstration's cleaned step list. |

Demonstration replay is deliberately **agent-mediated**: there is no `demo_replay` tool. The assistant reads the steps with `demo_get` and re-performs them with the acting tools, substituting new values and adapting to whatever the page actually looks like now.

## Ways of working

### Do it for me

You describe the outcome; the assistant works alone. "Open my orders page, find the order from last Tuesday, and tell me its tracking number." The assistant uses `browser_open_tab`, `browser_read`, `browser_click`, and reports back. You never touch the keyboard.

### Watch and narrate

You drive; the assistant observes. Ask it to follow along, and it polls `browser_observe` (or blocks on `browser_wait_for_user`) while you work — noticing which fields you filled, which link you followed, what you copied. Useful for "am I doing this right?", for having it write down what you just did, or for debugging a flow you can reproduce but not describe.

### Lockstep

Turn-taking on one task. The assistant fills the parts of a form it knows, then calls `browser_wait_for_user` and stops. You solve the CAPTCHA, pick the option only you can pick, or approve the payment. Your action wakes the assistant, it reads the new page state, and it continues from there. Anything requiring your judgement or your second factor fits this shape.

### Teach by demonstration

1. Ask the assistant to run `demo_record_start` with a name, e.g. `file-expense-report`.
2. Perform the task yourself, once, at normal speed.
3. Ask it to run `demo_record_stop`. Your clicks, typing, key presses, submits, navigations, page loads, tab changes and downloads are reduced to a clean step list — repeated typing in one field collapses to its final value, and a page load that merely echoes a navigation is dropped. Scrolling, copying and pasting are never recorded. Anything redacted is flagged rather than stored.
4. Later: "file an expense report for the 48 EUR taxi on the 3rd." The assistant calls `demo_get file-expense-report`, reads how you did it, and performs the same steps with the new values — re-finding elements live rather than blindly replaying coordinates.

## Privacy and data

**Redaction happens at the source, inside the page, before anything is sent.** A field's value is replaced with `[REDACTED]` when any of the following hold:

- the input's `type` is `password`;
- its `autocomplete` attribute starts with `cc-` (credit card fields);
- its `name`, `id` or `aria-label` matches `/pass(word)?|card|cvv|cvc|ssn|secret|token|otp|pin\b/i`.

This applies uniformly to observed input events, page reads (`browser_read` in `forms` mode) and recorded demonstration steps. Redacted values are never transmitted to the hub, never written to disk, and never visible to the assistant — it sees only that a redacted field exists and was filled. A `forms`-mode read of a redacted field carries an explicit `redacted: true` flag alongside the `[REDACTED]` value; unredacted fields carry no flag.

Redaction also covers the ways a sensitive value could leak through a different event:

- **Clicks.** A click event describes the element by its visible text; when the element has none, the fallback would be its `value`. For a sensitive element the text is `[REDACTED]` instead.
- **Copy.** The preview is `[REDACTED]` when either the copy target or the focused element is a sensitive field, since the selection lives in the focused field.
- **Paste.** The preview is `[REDACTED]` when the field being pasted into is sensitive.

What is stored, and where:

| Data | Location | Format |
| --- | --- | --- |
| Event log | `server/data/events/` | JSONL, one event per line, one file per UTC day (`YYYY-MM-DD.jsonl`), appended across server restarts |
| Recent events | in-process ring buffer (1000 entries) | memory only |
| Demonstrations | `server/data/demos/` | one JSON file per demonstration |

Everything is plain text on your local disk. Nothing is sent anywhere: the hub binds to `127.0.0.1` only, and the only data that leaves your machine is whatever the assistant itself reads into your Claude Code conversation — which is exactly the data you asked it to look at. Events flow only while the hub is running; with no Claude Code session loaded, the extension is a disconnected no-op that records nothing.

Copy and paste events from ordinary page content keep only a preview of at most 200 characters, not the full clipboard contents.

## Limitations

Accepted trade-offs in v0.1.0:

- **Synthetic clicks are `isTrusted: false`.** Extension-generated events are distinguishable from human ones. Most sites do not care; a few hardened ones (some payment and anti-fraud flows) ignore them. Those steps need you — which is what lockstep is for.
- **`browser_eval` is subject to page CSP.** A strict Content-Security-Policy can block main-world evaluation. This is reported as a hard error, not silently worked around.
- **Screenshots capture the visible tab only.** Chrome can only capture what is on screen, so `browser_screenshot` activates the target tab first. Expect your foreground tab to change.
- **No `chrome://` pages.** Content scripts cannot run on Chrome's internal pages, the Web Store, or other extensions' pages, so nothing there can be observed or acted on.
- **One browser profile at a time.** The hub accepts a single extension connection; a new `hello` closes the previous one.
- **Port 8590 must be free.** The server exits rather than falling back to another port.

## Layout

- `extension/` — Chrome MV3 extension
  - `manifest.json` — MV3 manifest, permissions, service worker registration
  - `background.js` — service worker: WebSocket client, tab-level observation, RPC dispatch, badge state
  - `content.js` — injected into pages: DOM observation, selector construction, redaction, DOM-level RPC execution
- `server/` — Node.js process, MCP stdio server and WebSocket hub in one
  - `src/index.js` — entry point
  - `data/` — runtime state (gitignored)
    - `events/` — JSONL event logs
    - `demos/` — recorded demonstrations
- `docs/`
  - `ARCHITECTURE.md` — components, data flow, and the reasoning behind the design
  - `PROTOCOL.md` — the complete extension/hub wire protocol

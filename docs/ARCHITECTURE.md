# BrowserBuddy architecture (v0.1.0)

This document explains how BrowserBuddy is put together and why. The wire format itself is specified separately in [PROTOCOL.md](PROTOCOL.md); this document covers structure, data flow and design rationale.

## 1. Components

Three pieces of code, in two processes.

- **Content script** (`extension/content.js`) — injected into the top frame of every eligible page. It is the only component that touches the DOM. It observes user interaction (clicks, typing, submits, scrolling, copy/paste), builds selectors, applies redaction, and executes exactly six RPCs: `readPage`, `click`, `fill`, `scroll`, `setClipboard`, `getPageState`. Sensitive values are filtered here, at the source, so they never leave the page.
- **Background service worker** (`extension/background.js`) — the extension's coordinator. It owns the WebSocket connection to the hub, observes browser-level activity through Chrome's extension APIs (tabs, `webNavigation`, downloads, window focus), executes the tab-level half of the RPC surface, routes the six page-level RPCs to the right content script, buffers events while disconnected, and maintains the toolbar badge. `runJs` is its responsibility too: it injects into the page's main world with `chrome.scripting`, bypassing the content script entirely.
- **Server** (`server/src/index.js` plus `hub.js`, `store.js`, `demos.js`, `mcp.js`) — one Node.js process (>= 20) presenting two interfaces: an MCP server over stdio for Claude Code, and the WebSocket hub for the extension. It holds the event store (ring buffer plus JSONL logs), the demonstration store, and the 25 MCP tool implementations.

The user's browser and the assistant's process meet only at the hub. There is no direct channel between the MCP client and Chrome.

## 2. Data flow

### Observation path — the user does something, the assistant can see it

1. The user acts in a page. The content script's listener fires.
2. The content script builds a selector for the target element, extracts the relevant payload, applies redaction, decides `actor` (see §5), and (for `input` and `scroll`) debounces.
3. It posts the event to the background service worker over the extension's internal messaging.
4. The background script fills in tab context (`tabId` from the message sender, `url` if the page did not supply one) and sends an `event` message over the WebSocket. If the socket is down, the event goes into the reconnect buffer instead.
5. The hub stamps `seq` and `receivedAt`, pushes the event into the ring buffer, and appends it to the JSONL log.
6. Later, an MCP tool call — `browser_observe`, `browser_state`, or a blocked `browser_wait_for_user` waking up — reads it back.

Browser-level events (`tab_created`, `navigation`, `page_loaded`, `download_started`, `window_focus`, …) skip steps 1–3: they originate in the background script's Chrome API listeners and enter at step 4. `page_loaded` belongs to this group — it comes from `webNavigation.onCompleted`, not from the content script, so it is reported even on pages where no content script can run.

### Action path — the assistant does something

1. Claude Code calls an MCP tool over stdio, e.g. `browser_click {selector}`.
2. The MCP layer validates arguments and asks the hub to invoke the corresponding RPC method.
3. The hub checks that an extension is connected — if not, the tool fails immediately — assigns an `id`, sends the `rpc` message, and awaits the matching `rpc_result` under a 20-second timeout (a caller may pass its own; `browser_state` uses 5 seconds so orientation stays cheap).
4. The background script dispatches: tab-level methods and `runJs` it handles itself; the six page-level methods it forwards to the content script of the target tab (defaulting to the active tab of the last-focused window).
5. The content script performs the operation against the DOM, marking itself as agent-acting for the duration and 100 ms afterwards.
6. The result travels back as `rpc_result`, the hub resolves the pending call, and the MCP tool returns.

Side effects of step 5 (a synthetic click producing a `click` event, a navigation producing a `navigation` event) flow back through the observation path — tagged `actor:"agent"`, so the assistant does not later mistake its own action for the user's.

A call can also be settled without a result: if the extension socket closes with the call outstanding it is rejected with `Extension disconnected while the call was in flight.`, and a server shutdown rejects everything in flight with `Server shutting down.` before the WebSocket server closes. No MCP tool is ever left hanging on a browser that went away.

## 3. One process, two interfaces

The MCP server and the WebSocket hub are the same process, and that is a deliberate structural choice rather than a convenience.

- **The event store must be shared.** The hub receives events; the MCP tools read them. Splitting them into two processes would require an IPC layer and a synchronisation story for `seq` — solving a problem that only exists because of the split.
- **`browser_wait_for_user` needs both sides in one place.** It is an MCP call that blocks on a WebSocket arrival. In one process, that is a pending promise resolved by the socket handler. Across processes, it is a distributed wait.
- **Lifetime is naturally correct.** Claude Code launches the server and shuts it down with the session. The hub exists exactly while an assistant is present. There is no daemon to install, start, supervise, or forget to stop, and no window where the extension is streaming events at a hub that nobody is reading.
- **Teardown settles everything.** `SIGINT`/`SIGTERM` closes the hub, which first rejects every in-flight RPC with an explicit "Server shutting down." error and then terminates every upgraded socket before closing the WebSocket server — including sockets that never completed a handshake, which would otherwise keep the close pending. Shutdown is bounded and no caller is abandoned mid-call.

The hub also gates on the handshake: only the socket that most recently completed `hello` may deliver events or RPC results. A stray localhost client can open the port, but until it says hello its frames are logged and discarded, so it can neither inject events into the store nor settle somebody else's pending call.

The cost is one hard constraint: **stdout belongs exclusively to the MCP protocol.** MCP over stdio uses stdin and stdout as the framed message channel; a single stray `console.log` corrupts the stream and breaks the session. So:

- No component may write to stdout except the MCP transport.
- All logging, including hub, WebSocket and event-store diagnostics, goes to stderr.
- Startup failures (occupied port, unwritable data directory) are reported on stderr and terminate the process. They are never written to stdout, and never swallowed.

The port check is part of this discipline. If port 8590 is taken, the server exits, naming the port and pointing at the `--port` flag and the matching constant in `extension/background.js`. It does not scan for a free port, because the extension's hub URL is a compile-time constant in that file rather than a setting: a hub that quietly relocated would be a running server with a browser that can never find it, which presents as "everything started fine, nothing works."

## 4. Event model

An event is a flat record: when (`ts`), who (`actor`), what (`type`), where (`tabId`, `url`), and a type-specific `data` object. The shape is uniform across every type so that filtering, storage and display need no per-type knowledge.

Two storage tiers, written together:

- **Ring buffer, 1000 events, in memory.** Serves the overwhelmingly common query — "what just happened" — with no I/O. Bounded, so a long session with a busy page cannot grow memory without limit.
- **JSONL log under `server/data/events/`.** One JSON object per line, appended as events arrive, into a file named for the **UTC day** (`YYYY-MM-DD.jsonl`). Rotation is by calendar day, not by server run: consecutive sessions on the same day share a file. Append-only, trivially greppable, and readable by anything that can read a line at a time. History beyond the ring lives here. Nothing reads it back — the MCP tools are served entirely from the ring — and a failed append is fatal rather than silently dropped.

### Sequence numbers

`seq` is assigned by the hub, densely and strictly increasing, across all events of a server run.

- **Assigned by the hub, not the extension**, because only the hub sees a single serialised stream. The extension has multiple concurrent event sources (one background script, N content scripts) and no shared clock between them.
- **Ordered by arrival, not by `ts`.** `ts` is browser time and may be skewed, and buffered events can arrive long after they occurred. `seq` is the sole ordering authority; `ts` is descriptive only.
- **Per server run.** Not persisted, not stable across restarts. Persisting it would imply a durable cursor contract that the JSONL logs would then have to honour on every read path. Instead, `browser_state` reports the current counter, and an assistant re-anchors after a restart — one extra call, no persistence machinery.

`seq` gives observation a cursor: `browser_observe {sinceSeq}` returns strictly what is new. That is what lets an assistant follow a user continuously without re-reading or missing events.

## 5. Attribution: user versus agent

Every event is labelled `actor: "user"` or `actor: "agent"`. This is the mechanism that makes observation usable at all.

Without it, the loop is pathological: the assistant clicks a link, the resulting `click` and `navigation` events land in the log, the assistant polls `browser_observe`, sees "the user clicked a link and navigated", and reacts to its own action. In a lockstep workflow it is worse — `browser_wait_for_user` would return instantly, woken by the very command that preceded it, and the assistant would conclude the user had acted when the user had not moved.

Attribution is implemented in both layers because the two layers observe different effects and have different information available:

- **Background script — tab-level, time-windowed.** When an RPC touches a tab, that tab is marked agent-driven for 1500 ms, and tab-level events for it are tagged `agent`. A time window is necessary here because the causal chain is asynchronous: `navigate` returns before the navigation commits, and the resulting `navigation` and `page_loaded` events arrive later through unrelated Chrome listeners. There is no token connecting them back to the RPC. 1.5 seconds comfortably covers a commit while staying short enough that a user action a moment afterwards is attributed correctly. Three effects cannot be keyed by tab id at all and get their own global windows: `newTab` (Chrome fires `tabs.onCreated` before `tabs.create` resolves, so the id does not exist yet when the mark would have to be set), `download` (`downloads.onCreated` carries no tab), and window focus (`windows.onFocusChanged` carries no tab either, so `activateTab` opens a 1500 ms focus window immediately before focusing the window, and a `window_focus` inside it is reported as `agent`). `screenshot` marks the tab only in the case where it must activate a background tab to capture it — that activation is the agent's doing.
- **Content script — DOM-level, also time-windowed.** While executing `click`, `fill` or `scroll`, the content script sets an in-page flag and clears it 100 ms after the call returns. The flag alone is not enough, because the `input` and `scroll` observations are debounced by hundreds of milliseconds and would see a flag that had already fallen. So the actor is captured **at listener time** and carried through the debounce timer with the pending event — that is what keeps a debounced agent action attributed to the agent.
- **`runJs` spans both.** It runs in the page's main world via `chrome.scripting`, so it cannot set the in-page flag from inside the content script. The background therefore does two things before injecting: it marks the tab (covering tab-level effects) and sends the content script an internal message that raises an in-page agent window of 1500 ms (covering DOM effects the injected code triggers). The window and the 100 ms RPC flag are independent deadlines; the later one wins. On a page where no content script can run, the message simply fails and `runJs` proceeds — there is nothing in-page to attribute there anyway.

Consequences of the design:

- Observation tools default to `actor: "user"`. `browser_observe` filters to user events unless told otherwise; `browser_wait_for_user` only ever wakes on user events.
- Agent events are still recorded in full. The log is a complete record of both parties, which makes it an audit trail: "what did the assistant do in my browser" is answerable by requesting `actor: "agent"`.
- The time window is an acknowledged approximation. A user clicking something within ~1.5 seconds of an agent command in the same tab may be mislabelled as the agent. The alternative — a correlation token threaded through Chrome's navigation events — is not available in the extension APIs, and mislabelling in that direction is conservative: the assistant under-reacts rather than mistaking its own action for the user's.

## 6. Selector round-trip

One routine, `buildSelector`, produces the selectors in observed events, in page reads, and in demonstration steps. The acting RPCs accept exactly those selectors. Watching and acting share a single vocabulary.

This is a small implementation detail with a large consequence. It means:

- A selector the assistant saw in a `click` event is directly usable as `browser_click {selector}` with no translation, inference, or re-derivation.
- A field listed by `readPage` in `forms` mode can be filled by `browser_fill` with the selector as printed.
- A demonstration is replayable **because** its steps were recorded in the acting vocabulary. Had observation recorded coordinates, or DOM paths in some private format, or screenshots, a recorded demonstration would need a lossy translation step before it could be performed — and it is exactly at that translation that macro-style tools break.

The priority order (`id`, then `data-testid`, then `tag[name]`, then `tag[aria-label]`, then an `nth-of-type` path) is a stability ranking. Ids and test ids survive page changes best; `name` and `aria-label` are semantic and usually stable; a positional CSS path is the fallback and the most brittle. Preferring the stable forms is what gives a demonstration recorded today a reasonable chance of working next month.

Two refinements matter more than the ordering itself:

- **Machine-generated ids are rejected.** An id containing four or more consecutive digits, or consisting of eight or more hex characters and dashes, is skipped in favour of the next strategy. Those ids are re-minted on every render, so a selector built from one is stale before it is used. The heuristic is deliberately crude: a false rejection costs one step down the priority list, while a false acceptance produces a selector that silently stops matching.
- **The positional path is uniqueness-verified, not merely constructed.** Candidates are grown one ancestor at a time (up to eight segments) and each is round-tripped through `document.querySelector`; the first that resolves back to the same element wins, which is also the shortest that does. The 200-character cap is soft and is applied only when no candidate resolved at all, by dropping outer segments rather than truncating the string. A long selector that matches the right element always beats a short one that would act on the wrong one — the round trip is the whole point of the routine, so nothing is allowed to break it.

## 7. Demonstration pipeline

Recording is a three-stage pipeline over the live event stream.

1. **Capture filter.** While a demonstration is recording, events carrying `actor: "user"` and one of ten demonstration-relevant types are copied into the recording buffer as they arrive: `navigation`, `click`, `input`, `form_submit`, `key_command`, `tab_created`, `tab_closed`, `tab_activated`, `download_started`, `page_loaded`. Everything else — notably `scroll`, `copy`, `paste` and `window_focus` — is never captured, because it describes how the user moved around rather than what they did. Agent events are excluded too: a demonstration is a record of what the *user* did. The normal event log continues unaffected; recording is a tap, not a mode switch.
2. **Clean and merge.** On `demo_record_stop` the raw capture is reduced by exactly two rules, applied in one pass over the captured sequence:
   - **Consecutive `input` events on the same selector collapse into one**, keeping the last. The user's corrections and retypes are not part of the task.
   - **A `page_loaded` immediately following a `navigation` to the same URL is dropped**, since it only echoes the navigation that is already recorded.

   Nothing else is filtered at this stage. Clicks that merely focused a field are kept, as are repeated navigations to different URLs; the filtering that removes scrolling happened in step 1, not here. Each surviving event is then projected into a step carrying its type, its URL, and the type-specific essentials (selector, text or title, filled value). A redacted input becomes a step with `redacted: true`, an explanatory note, and the `[REDACTED]` placeholder as its value — so a step reads "fill the password field" without containing a password. Keys that would be `undefined` are stripped, so a step never carries an empty field.
3. **Persist.** The cleaned demonstration is written as one JSON file under `server/data/demos/`, named by a slug derived from the demonstration name, with its description, creation timestamp, step list and the raw event count it was reduced from. `demo_list` and `demo_get` read from there; `demo_get` resolves a name or a slug to the same file.

### Replay is agent-mediated, by design

There is no `demo_replay` tool. `demo_get` returns the steps and the assistant performs them with the ordinary acting tools.

A blind replayer — fire the recorded steps in order against the current page — is a macro, and macros are brittle in exactly the ways that matter. A moved element, an interstitial consent dialog, a slightly different page state, or the entire point of the exercise (running the task with *different values* this time) all break it, and it breaks silently, halfway through, having already performed some steps.

Handing the steps to the assistant makes the demonstration what it should be: a description of how the task is done, not a recording of one performance of it. The assistant can substitute values, read the page to confirm it is where it expects to be, notice that the layout changed and adapt, skip a step that is already satisfied, and stop and ask when reality does not match the demonstration. The recording captures intent; the assistant supplies the judgement.

## 8. MV3 service-worker lifetime

Manifest V3 replaced the persistent background page with a service worker that Chrome terminates when idle — typically after about 30 seconds. Everything about the extension's connection management is shaped by this.

- **Top-level listener registration.** Every Chrome event listener is registered synchronously at the top level of `background.js`, never inside a callback, a promise, or an async initialiser. Chrome uses the listener set to decide whether to wake a terminated worker for an event; a listener registered late may exist only when the worker happens to be alive, which produces events that are observed sometimes and missed other times. Registering at the top level is what makes observation reliable.
- **Ping keepalive.** The 20-second `ping` is a keepalive, not a liveness probe: outbound WebSocket activity resets the worker's idle timer, so a socket with traffic on it keeps the worker alive, and 20 seconds sits comfortably inside the ~30-second window. The extension does not inspect the `pong` it gets back and has no missed-pong logic — a dead peer is discovered when the socket closes, which is what schedules the reconnect.
- **Alarms as a backstop.** A `chrome.alarms` timer firing every 30 seconds wakes the worker independently of the socket and re-attempts the connection, covering the case where the worker was terminated with the connection already down — a situation where neither a ping nor a pending retry timer can fire, because there is nothing running to fire them.
- **Event buffering with a `storage.session` mirror.** Events observed while the socket is down are queued, capped at 500 with the oldest dropped first, so a long outage loses the start of the gap rather than growing without bound. The queue lives in memory for speed and is mirrored to `chrome.storage.session`, which survives worker termination (and, unlike `storage.local`, is cleared when the browser closes — appropriate for transient events that may contain page content). Mirror writes are coalesced over 500 ms, except immediately after a successful full drain, which writes through at once: without that, a teardown inside the coalescing window would rehydrate a mirror still holding the events just sent and deliver them a second time. On restart the worker rehydrates the queue before connecting; on reconnect it drains in original order, and while anything is queued even live events join the back of the queue so nothing overtakes the backlog.
- **Reconnection on a fixed ladder.** Disconnects are routine, not exceptional: worker termination, server exit at the end of a Claude Code session, an extension reload. The extension retries after 1, 2, 5 and 10 seconds, then every 10 seconds indefinitely — a bounded ladder rather than unbounded exponential backoff, because the hub is a local process that typically comes back within seconds and a minutes-long backoff would be pure dead time. The badge reflects the true state, so a disconnected extension is visible rather than mysterious.

The design assumption is that the worker dies constantly and that this must be invisible in the observed event stream.

## 9. Failure philosophy

Every operation has exactly one strategy. When it does not work, it fails loudly.

- **No fallbacks.** `runJs` uses main-world evaluation; if page CSP blocks it, that is an error, not a signal to try an isolated-world approximation that behaves subtly differently. `screenshot` captures the visible tab; there is no degraded off-screen path. One input produces one behaviour, every time.
- **No queueing of commands.** With no extension connected, an acting tool fails immediately. It does not wait for a browser to appear. A command that executes four minutes later, against a page the assistant never reasoned about, is more dangerous than a visible failure — and the assistant can always retry after checking `browser_state`.
- **No silent port relocation.** An occupied port terminates startup. See §3.
- **Errors carry the reason.** `rpc_result` failures return a message describing what went wrong: which selector matched nothing, that CSP blocked evaluation, that the tab has no content script. The assistant is a capable error handler when it is told the truth, and a poor one when handed a generic failure.
- **Redaction has no bypass.** There is no flag to disable it, no "trusted page" list. A guardrail with an escape hatch is a guardrail that will be escaped.

The unifying principle: the assistant is an autonomous consumer that will take whatever path is offered. Ambiguity, silent degradation and best-effort behaviour are all worse for it than a clear failure, because a clear failure it can reason about and report, while a silent degradation it will simply build on.

## 10. Trade-offs accepted in v0.1.0

| Trade-off | Consequence | Why it is accepted |
| --- | --- | --- |
| Synthetic events are `isTrusted: false` | A few hardened sites (payment flows, anti-fraud interstitials) ignore extension-generated clicks. | The only fix is a debugger attachment, which forfeits the entire premise: no debug port, low automation fingerprint, real browser. Lockstep is the answer instead — the assistant hands those specific steps to the user. |
| `browser_eval` is subject to page CSP | Main-world evaluation fails on strictly-configured pages. | A CSP-tolerant workaround would mean a second injection path with different semantics — a silent fallback. Better a documented hard error on a minority of pages. |
| Screenshots capture only the visible tab | The target tab is activated first, changing the user's foreground tab. | Chrome offers no off-screen capture to extensions. Activating first is at least predictable and visible, rather than failing on any non-active tab. |
| One extension connection at a time | A second browser profile cannot connect concurrently; the newer connection displaces the older. | Multiple connections would require routing every RPC by browser identity and partitioning the event stream. Single-profile is the actual use case; the newest-wins rule makes extension reloads resolve deterministically. |
| No `chrome://` pages | Browser-internal pages, the Web Store and other extensions are invisible and untouchable. | A Chrome restriction, not a design choice. Nothing to work around. |
| `seq` is not stable across restarts | A cursor from a previous server run is meaningless. | Persisting it would impose a durability contract on every read path to save one re-anchoring call against `browser_state`. |
| Attribution window is time-based | A user action within ~1.5 s of an agent command in the same tab may be labelled `agent`. | Chrome's navigation events carry no correlation token back to the initiating call. The error is conservative — the assistant under-reacts rather than mistaking its own action for the user's. |

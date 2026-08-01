---
title: Protocol
description: "The normative WebSocket contract between the extension and the local hub: framing, handshake, keepalive, the event stream, and the full RPC surface."
---

# BrowserBuddy wire protocol (v0.1.0)

This document specifies the complete protocol between the browser extension and the local hub. It is intended to be sufficient to reimplement either side without reading the other's source. The protocol is browser-agnostic: the same extension code speaks it from Chrome and from Firefox, and the hub cannot tell them apart.

Two roles:

- **Extension** — the WebSocket client. Runs in Chrome or Firefox; observes the browser and executes commands.
- **Hub** — the WebSocket server, embedded in the same Node.js process that serves MCP over stdio. Stores events and issues commands.

## 1. Transport

- WebSocket over plain HTTP, no TLS.
- Default endpoint: `ws://127.0.0.1:8590/ws`. The port is set by the server's `--port` flag; the path is always `/ws`.
- The listener binds to the loopback interface only. It is never reachable off the machine.
- Every WebSocket message is a single, complete, UTF-8 JSON **object**. No batching, no arrays at the top level, no fragmented application framing. One message, one object.
- Every object has a `kind` field (string) identifying the message type. Messages with an unknown `kind` are ignored by the receiver; they are not an error.
- The extension is always the connecting party. The hub never initiates a connection.
- If the hub is not listening, the extension retries on a fixed reconnect ladder of 1 s, 2 s, 5 s, 10 s, staying at 10 s thereafter (it is not exponential), backed by a 30-second `alarms` timer that retries the connection even if the retry timer was lost to a background teardown. Connection ordering between the browser and the server is not significant.

### Message kinds

| `kind` | Direction | Purpose |
| --- | --- | --- |
| `hello` | ext → hub | Announce the extension and its version. First message on every connection. |
| `hello_ack` | hub → ext | Accept the connection and report the server version. |
| `ping` | ext → hub | Keepalive. |
| `pong` | hub → ext | Keepalive reply. |
| `event` | ext → hub | Report one observed browser or page event. |
| `rpc` | hub → ext | Invoke a method in the extension. |
| `rpc_result` | ext → hub | Result (success or failure) for one `rpc`. |

## 2. Handshake

The extension sends, immediately after the socket opens and before any other message:

```json
{"kind":"hello","role":"extension","version":"0.1.0"}
```

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | string | `"hello"` |
| `role` | string | `"extension"`. The only defined role in v0.1.0; reserved for future client types. |
| `version` | string | Extension version, semver. |

The hub replies:

```json
{"kind":"hello_ack","serverVersion":"0.1.0"}
```

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | string | `"hello_ack"` |
| `serverVersion` | string | Server version, semver. |

Rules:

- **Hello gating is enforced.** Only the socket that most recently completed `hello` may send other frames. Any frame whose `kind` is not `hello`, arriving on a socket that is not the currently adopted one, is logged to stderr and dropped — it cannot inject an event or settle somebody else's RPC. This applies both to a socket that never said hello and to a socket that was displaced by a newer connection.
- **At most one extension connection is live at a time.** When a `hello` arrives on a new socket while another extension connection is established, the hub closes the older socket and adopts the new one. This is the defined behaviour, not a race: the newest connection always wins. It makes extension reloads (which produce a new background context and a new socket) resolve deterministically.
- Version fields are informational in v0.1.0. Neither side refuses a connection on version mismatch.
- On connection loss the extension reconnects on the fixed ladder of §1 and repeats the handshake. Nothing is negotiated or resumed; a reconnect is a fresh session.

## 3. Keepalive

The extension sends every 20 seconds:

```json
{"kind":"ping"}
```

The hub replies immediately:

```json
{"kind":"pong"}
```

The interval exists to keep the MV3 background context's WebSocket activity alive: on Chrome, the outbound message defers the service worker's idle shutdown that would otherwise tear down the connection roughly every 30 seconds, and the 20-second interval is chosen to sit safely inside that window. Firefox does not count WebSocket traffic as background activity, so there the ping does not prevent the event page's idle suspension — the extension instead reconnects when its 30-second alarm revives the page (roughly once a minute at idle), which the newest-wins handshake rule of §2 resolves cleanly.

The extension does **not** act on `pong`. It parses the frame and ignores it; there is no missed-pong counter and no pong-driven reconnect. Liveness is detected only through the socket closing, which schedules the reconnect ladder of §1. A hub that stops replying while the socket stays open is therefore not detected by the keepalive.

Neither `ping` nor `pong` carries a payload, an id, or a timestamp. The hub never initiates a ping.

## 4. Events

### 4.1 Envelope

```json
{"kind":"event","event":{ "ts":1735689600000, "actor":"user", "type":"click", "tabId":42, "url":"https://example.com/orders", "data":{ "selector":"#submit", "text":"Place order", "tag":"button" } }}
```

Fields of the inner `event` object as sent by the extension:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ts` | integer | yes | Epoch milliseconds at which the extension observed the event. |
| `actor` | string | yes | `"user"` or `"agent"`. See §6. |
| `type` | string | yes | One of the event types in §4.3. |
| `tabId` | integer \| null | yes | Browser tab id. `null` for window-level events with no associated tab. |
| `url` | string \| null | yes | URL of the tab at the time of the event. `null` when unknown or not applicable. |
| `data` | object | yes | Type-specific payload. May be empty (`{}`) but must be present. |

### 4.2 Hub stamping and sequence numbers

On receipt the hub adds two fields to the stored event:

| Field | Type | Description |
| --- | --- | --- |
| `seq` | integer | Global sequence number, assigned by the hub. |
| `receivedAt` | integer | Epoch milliseconds at which the hub received the event. |

Sequence semantics:

- `seq` is assigned by the hub, never by the extension. The extension has no say in ordering.
- It is **strictly monotonically increasing** and dense (each event gets the previous value plus one) across all events of a single server run, regardless of tab, actor or type.
- It is **per server run**. The counter starts fresh when the server process starts. It is not persisted and not stable across restarts. A client holding a `seq` from a previous run must not assume it refers to the same event; `browser_state` reports the current counter so an assistant can re-anchor.
- Ordering is by hub arrival, not by `ts`. `ts` comes from the browser and can be skewed or out of order relative to arrival; `seq` is the only ordering authority.
- `seq` is what `browser_observe`'s `sinceSeq` parameter refers to: return events with `seq > sinceSeq`.

Events are appended in stamped form, one JSON object per line, to a JSONL file under the data directory: `<dataDir>/events/YYYY-MM-DD.jsonl`, where the date is the **UTC day** of the event's `receivedAt`. The log therefore rotates once per UTC day, not once per server run: a restart on the same day appends to the same file, and a session spanning midnight UTC writes into two files. The directory is created on the first write and again whenever the day file rolls over; an unwritable log is fatal (the server prints the reason to stderr and exits).

Each event is simultaneously pushed into an in-memory ring buffer of the 1000 most recent events. Reads that fit within the ring are served from memory; the MCP tools never read the JSONL files back.

Note the asymmetry: `seq` restarts at 1 with every server run, while the day file persists across runs. A single day file can therefore contain repeated `seq` values from consecutive runs.

Events are never acknowledged. The hub sends nothing in response to an `event` message.

### 4.3 Event types

`data` fields per type. All events also carry the envelope fields of §4.1.

| `type` | `data` fields | Emitted by | Notes |
| --- | --- | --- | --- |
| `tab_created` | — (`{}`) | background (`tabs.onCreated`) | A new tab was opened. `url` is the tab's `pendingUrl`, falling back to `url`, else `null`. |
| `tab_closed` | — (`{}`) | background (`tabs.onRemoved`) | A tab was closed. `url` is always `null`: `onRemoved` carries no URL and the tab is already gone. |
| `tab_activated` | `title` (string \| null) | background (`tabs.onActivated`) | The foreground tab changed. If the tab cannot be fetched, `url` and `title` are `null`. |
| `navigation` | `transitionType` (string \| null) | background (`webNavigation.onCommitted`) | A main-frame navigation committed. Sub-frame navigations are not reported. `transitionType` is the browser's own value (`link`, `typed`, `reload`, `form_submit`, `auto_bookmark`, and so on; the exact vocabulary differs slightly between Chrome and Firefox). |
| `page_loaded` | `title` (string \| null) | background (`webNavigation.onCompleted`) | The main frame finished loading. This is a browser-level event, not a content-script one: it is emitted even for pages where no content script runs. |
| `click` | `selector` (string), `text` (string), `tag` (string), `href` (string, optional) | content script | `text` is the element's trimmed visible text, capped at 80 characters; when the element has no text it falls back to its `aria-label`, and then to its `value` — except that a sensitive element (§5) reports `"[REDACTED]"` instead of its value. `tag` is lowercase. `href` present only for anchors with an `href`. |
| `input` | `selector` (string), `name` (string, optional), `inputType` (string), `label` (string, optional), `value` (string), `redacted` (boolean) | content script | Debounced; see §4.4. `inputType` is the field's lowercased `type` attribute; a `<input>` with no `type` reports `"text"`, and a `<textarea>`/`<select>`/contenteditable reports its tag name. `label` is the resolved human label if one could be found. `value` is `"[REDACTED]"` when `redacted` is true. `redacted` is always present. |
| `form_submit` | `selector` (string) | content script | Selector of the submitted `<form>`. |
| `key_command` | `key` (string), `selector` (string) | content script | A meaningful key press. In v0.1.0 the only reported `key` is `"Enter"`, and only from an `<input>` or `<textarea>`. `selector` identifies the focused element. |
| `scroll` | `y` (number), `maxY` (number), `pct` (number) | content script | Debounced; see §4.4. Only the document's own scroll is reported — scrolling of an inner container is ignored. `y` is scroll offset in pixels, `maxY` the maximum scrollable offset, `pct` the position as a percentage (0–100, and 0 when the page does not scroll). |
| `copy` | `textPreview` (string) | content script | At most 200 characters of the copied text, never the full contents — and `"[REDACTED]"` when the copy event's target or the focused element is a sensitive field (§5). |
| `paste` | `textPreview` (string) | content script | At most 200 characters of the pasted text, and `"[REDACTED]"` when the paste target is a sensitive field (§5). |
| `download_started` | `filename` (string \| null) | background (`downloads.onCreated`) | A download began. `filename` is the basename of the browser's suggested path. `tabId` is always `null`; `url` is the download URL. |
| `window_focus` | `focused` (boolean) | background (`windows.onFocusChanged`) | The browser window gained (`true`) or lost (`false`) focus. `tabId` and `url` are always `null`. `actor` is `"user"` unless the focus change falls inside the agent focus window opened by `activateTab` (see §6). |

Events originating in a content script are sent with `tabId: null` and the page's `location.href`; the background script overwrites `tabId` from the message sender (and fills `url` from the sender tab if it was empty) before forwarding them to the hub.

### 4.4 Debouncing and flushing

Two event types are coalesced in the content script to avoid flooding the hub with one message per keystroke or per scroll tick:

- **`input` — 800 ms.** While the user types into one field, a single pending event is held and its `value` updated. It is emitted 800 ms after the last keystroke. The pending event is **flushed immediately** on `blur` of the field and on `pagehide` of the document, so a value is never lost because the user tabbed away or navigated. Switching focus to a different field also flushes the pending event for the previous one — each field produces its own event.
- **`scroll` — 600 ms.** Scroll position is sampled and a single event emitted 600 ms after scrolling stops, carrying the final position.

No other event type is debounced. Clicks, submits, navigations and the rest are emitted as they happen.

### 4.5 Event buffering across background restarts

The MV3 background context (a service worker on Chrome, an event page on Firefox) can be terminated at any time. Events observed while the socket is down are buffered in the extension and mirrored to `storage.session`, so a background restart does not lose them. On reconnect the buffer is drained in original order. `ts` therefore reflects observation time, while `seq` and `receivedAt` reflect the (possibly much later) delivery — another reason `seq` orders by arrival and not by `ts`.

Details of the buffer:

- **Capacity 500, drop-oldest.** Once 500 events are queued, each new event evicts the oldest. A long disconnection loses the beginning of the gap, not the end.
- **Ordering is preserved on drain.** While anything is buffered, even a live event is appended to the queue rather than sent directly, so nothing overtakes the backlog.
- **Mirror writes are coalesced** into a single `storage.session` write 500 ms after the last change, **except** immediately after a complete flush, which writes through at once. Without that write-through, a worker teardown inside the coalescing window would restore a mirror still holding the just-sent events and deliver them twice.
- **Rehydration is additive.** On worker start the mirrored array is prepended to whatever is already in memory and the result is truncated to the newest 500 entries, then the socket is connected.

## 5. Redaction

Redaction is **mandatory and applied at the source**, inside the content script, before any message is constructed. Sensitive values do not cross the page boundary: not to the background script, not over the WebSocket, not to disk.

A field's value is redacted when any of these conditions holds:

1. The element's `type` attribute is `password`.
2. The element's `autocomplete` attribute starts with `cc-` (the credit-card family: `cc-number`, `cc-exp`, `cc-csc`, …).
3. The element's `name`, `id` or `aria-label` matches the regular expression `/pass(word)?|card|cvv|cvc|ssn|secret|token|otp|pin\b/i`.

When redaction applies, `value` is set to the literal string `"[REDACTED]"` and `redacted` is set to `true`. The original value is never captured into a variable that outlives the check.

The rule applies identically in all three places a field value could otherwise escape:

| Surface | Effect |
| --- | --- |
| `input` events | `data.value` is `"[REDACTED]"`, `data.redacted` is `true`. |
| Page reads (`readPage` with `mode: "forms"`) | The reported `value` of a matching field is `"[REDACTED]"` and the field object carries `redacted: true`. The flag is present only on redacted fields; unredacted fields simply omit it. |
| `click` events | When the clicked element has no text and no `aria-label`, its `value` would otherwise become `data.text`. For a sensitive element the text is `"[REDACTED]"` instead. |
| `copy` events | `data.textPreview` is `"[REDACTED]"` when the copy target **or** the focused element is a sensitive editable field — the selection lives in the focused field, so both are checked. |
| `paste` events | `data.textPreview` is `"[REDACTED]"` when the paste target is a sensitive editable field. |
| Demonstration steps | The recorded step keeps the selector and marks the value as redacted, so the assistant knows a secret belongs there without knowing the secret. |

Redaction is a property of the field, not of the actor: values the agent itself writes via `fill` into a matching field are redacted in the resulting event exactly as the user's would be.

For the `copy`/`paste` surfaces the sensitivity test is narrower than for `input`: the element must be an editable field (`input`, `textarea`, `select`, or contenteditable) *and* match one of the three conditions above. A copy from ordinary page text is not redacted; it is truncated to 200 characters, and the truncation is the safeguard.

Redaction is applied to the *reported* value only. The `fill` RPC will happily write into a sensitive field — the value the assistant supplies is its own, and only the observation of that field is suppressed.

## 6. Attribution

Every event carries `actor`, which is `"user"` for something the human did and `"agent"` for a side effect of the assistant's own commands. Without this, an assistant that clicks a link would then observe "the user navigated" and could act on its own echo.

Attribution is applied in two layers, because the two layers see different effects. Both layers are time-windowed; neither carries a correlation token.

**Background layer — tab-level effects.** The background keeps a map of tab id to expiry timestamp. `markAgentTab(tabId)` sets the expiry to now plus **1500 ms**; every background-emitted tab event looks the tab up and reports `agent` if the entry exists and has not expired (expired entries are deleted on lookup). Marking happens in four distinct ways:

| Mechanism | Applies to | Detail |
| --- | --- | --- |
| Per-tab window | `navigate`, `closeTab`, `activateTab`, `reload`, `goBack`, `goForward`, `zoom`, `runJs`, and the relayed page RPCs `click`, `fill`, `scroll` | The handler marks the resolved tab before performing the operation, so the events the operation causes fall inside the window. Relayed reads (`readPage`, `getPageState`) and `setClipboard` do **not** mark the tab: they change nothing. |
| Global new-tab window | `newTab` | `tabs.create` fires `tabs.onCreated` before its promise resolves, so the new tab's id is not yet known. A separate global timestamp is set to now plus 1500 ms *before* calling `create`; `onCreated` consults it, marks the tab by id, and only then emits `tab_created`, so both that event and the tab's later events say `agent`. The handler additionally marks the tab by id once `create` resolves. |
| Global download window | `download` | A global timestamp is set to now plus 1500 ms before `downloads.download`. `downloads.onCreated` is a browser-level event with no tab, so it consults that timestamp directly instead of the per-tab map. |
| Global focus window | `activateTab` | Activating a tab also focuses its window. A global timestamp is set to now plus 1500 ms immediately before `windows.update({focused:true})`; `windows.onFocusChanged` carries no tab either, so it consults that timestamp and reports `agent` inside the window. |

`screenshot` is a special case: it does not mark the tab in general, but when the target tab is not active it must activate it first, and it marks the tab before doing so — the activation is the agent's doing, not the user's.

**Content-script layer — DOM effects.** The acting content RPCs (`click`, `fill`, `scroll`) run inside a wrapper that sets an in-page flag, and clears it **100 ms after the call returns**. This is a time window too, not an exact bracket: the synthetic `click()` or dispatched `input` event is delivered synchronously, but the debounced `input` and `scroll` emissions (§4.4) fire hundreds of milliseconds later, long after the flag is down. So the actor is captured **when the DOM listener runs** and carried through the debounce timer, which is what keeps a debounced agent action attributed to the agent.

Two consequences worth knowing:

- `runJs` executes in the page's main world from the background via the `scripting` API, not through the content script, so it cannot set the in-page flag itself. Instead the background sends the target tab's content script an internal `agentWindow` message immediately before injecting, which raises an in-page agent window of **1500 ms**; DOM events the injected code causes inside that window are attributed `agent`. The window and the 100 ms RPC flag coexist — whichever deadline is later wins. A tab with no content script (browser-internal pages, extension stores) cannot receive the message; that failure is ignored and `runJs` proceeds. Its tab-level effects are `agent` regardless, because the background marks the tab.
- `readPage`, `getPageState` and `setClipboard` do not set the flag either; they produce no DOM events.

Observation tools default to `actor: "user"`: `browser_observe` filters to user events unless asked otherwise, and `browser_wait_for_user` only ever wakes on `actor:"user"` events. Agent events are still recorded in full and can be requested explicitly, which makes the log a complete audit of both parties.

## 7. Selectors

One selector-building routine (`buildSelector`) is used everywhere a selector is produced — observed events, page reads, and demonstration steps — and the selectors it produces are exactly what the acting RPCs accept. This round trip is what makes a selector the assistant saw the user click directly usable in a later `click`.

The routine tries the following in order and returns the first candidate that matches exactly one element in the document:

1. **`#id`** — only if the element has an id that does *not* look machine-generated. The heuristic is `/\d{4,}|^[a-f0-9-]{8,}$/i`: an id containing a run of four or more digits, or consisting entirely of eight or more hex characters and dashes, is skipped, because framework-generated ids of that shape change on every render. The id is escaped with `CSS.escape` where available.
2. **`[data-testid="…"]`** — the attribute alone, with no tag qualifier.
3. **`tag[name="…"]`** — only for `input`, `select`, `textarea`, `button` and `form` elements, and always qualified by the tag name.
4. **`tag[aria-label="…"]`** — for any element, qualified by the tag name.
5. **A `:nth-of-type` CSS path**, described below.

Attribute values are escaped by backslash-prefixing `"` and `\`. Steps 2–4 are skipped when the attribute is absent, and any of steps 1–4 that produces a non-unique selector falls through to the next.

The CSS path is built from the element outwards, one `tag` or `tag:nth-of-type(n)` segment per ancestor (the index is only added when the parent has more than one child of that tag), stopping at `<body>`/`<html>` or after **8 segments**. It is then **uniqueness-verified**: candidates are grown one ancestor at a time, from the element's own segment outwards, and the first candidate for which `document.querySelector` round-trips back to *the same element* is returned. Because adding ancestors only ever narrows the match set, the first candidate that resolves to the element is also the shortest one that does.

There is a soft length cap of 200 characters, and it never breaks a working selector: it is applied only when *no* candidate resolved to the element, and even then by dropping outer segments (never by truncating the string), so the result is always syntactically valid CSS. A long selector that resolves to the right element always beats a short one that would act on the wrong one.

The output is always a plain CSS selector string that `document.querySelector` accepts. There is no custom selector syntax and no XPath.

## 8. RPC

### 8.1 Framing

Request, hub → extension:

```json
{"kind":"rpc","id":17,"method":"click","params":{"selector":"#submit"}}
```

| Field | Type | Description |
| --- | --- | --- |
| `kind` | string | `"rpc"` |
| `id` | integer | Correlation id, assigned by the hub. Unique within a connection; increasing. |
| `method` | string | Method name from §8.3. |
| `params` | object | Method parameters. Always present; `{}` when the method takes none. |

Response, extension → hub. Exactly one of these two shapes, exactly once per request:

```json
{"kind":"rpc_result","id":17,"ok":true,"result":{"clicked":{"selector":"#submit","tag":"button","text":"Place order"}}}
```

```json
{"kind":"rpc_result","id":17,"ok":false,"error":"No element matches selector: #submit"}
```

| Field | Type | Description |
| --- | --- | --- |
| `kind` | string | `"rpc_result"` |
| `id` | integer | The `id` of the request being answered. |
| `ok` | boolean | Whether the call succeeded. |
| `result` | object | Present if and only if `ok` is `true`. Method-specific; always an object. |
| `error` | string | Present if and only if `ok` is `false`. A human-readable message. |

Rules:

- The extension must answer every `rpc` exactly once. It must not send an `rpc_result` for an id it was not sent, or answer the same id twice.
- Requests are correlated by `id` only. Responses may arrive out of order; the hub matches on `id` and must not assume FIFO.
- The extension never initiates an RPC. The hub never sends an `rpc_result`.
- Errors are reported as `ok:false` with a message, never as a thrown transport-level failure and never as a partially-successful `result`. There is no error code enumeration in v0.1.0; the string is the contract.

### 8.2 Timeout and failure

- The hub applies a **20-second default timeout** to every RPC. If no `rpc_result` for that `id` has arrived when it expires, the hub fails the call with `Timed out after 20000ms waiting for the extension to complete "<method>".` and discards the id; a late-arriving result for a timed-out id is ignored (it is logged as an `rpc_result` for an unknown id).
- **The timeout is overridable per call.** The caller may pass its own value. The only current use is `browser_state`, which issues its `listTabs` with a **5-second** timeout: orientation must answer quickly even when the page is busy, and `browser_state` reports the failure as an `activeTabError` field rather than failing the whole tool.
- If the extension socket closes with RPCs outstanding, all of them are rejected immediately with `Extension disconnected while the call was in flight.` On server shutdown, in-flight calls are likewise rejected, with `Server shutting down.`, before the WebSocket server is closed — no caller is left hanging in either case. Nothing is retried or queued for the next connection.
- If no extension is connected when a call is attempted, it fails immediately with a message naming the port and explaining how to load the extension. The hub does not queue commands waiting for a browser to show up. This is deliberate: a command that silently executes several minutes later, against a different page than the assistant reasoned about, is worse than a visible failure.

### 8.3 Methods

`tabId` is optional on every method that accepts it and defaults to **the active tab of the last-focused normal window**. When there is no such tab the call fails with `No active tab in the last-focused window`.

Result objects are exactly as listed. Several methods deliberately return an empty object: the RPC either succeeded or reported an error, and there is nothing further to say. An extension handler that returns nothing is normalised to `{}` before it goes on the wire.

**Tab and navigation control** (handled in the background script):

| Method | Params | Result |
| --- | --- | --- |
| `listTabs` | — | `{tabs: [{tabId, url, title, active, windowId}]}` |
| `newTab` | `url` (string, optional) | `{tabId}` |
| `closeTab` | `tabId` (optional) | `{}` |
| `activateTab` | `tabId` (optional) | `{}` |
| `navigate` | `url` (string, required), `tabId` (optional) | `{tabId}` |
| `goBack` | `tabId` (optional) | `{}` |
| `goForward` | `tabId` (optional) | `{}` |
| `reload` | `tabId` (optional) | `{}` |
| `zoom` | `factor` (number, required), `tabId` (optional) | `{}` |
| `download` | `url` (string, required), `filename` (string, optional) | `{downloadId}` |
| `screenshot` | `tabId` (optional) | `{format: "jpeg", base64: "<base64>"}` |
| `runJs` | `code` (string, required), `tabId` (optional) | `{result}` |

Notes:

- `listTabs` queries **all** windows and reports every tab. `url` and `title` are `null` when the browser does not expose them. There is no `index` field.
- `newTab` returns only the new tab's id; it does not echo the URL. Omitting `url` opens a blank tab.
- `activateTab` both activates the tab and focuses its window.
- `screenshot`: the browser can only capture the **visible** tab, so if the target is not the active tab the extension activates it, waits 350 ms, and leaves it active. The image is JPEG at quality 70, returned base64-encoded in the **`base64`** field without the `data:image/jpeg;base64,` prefix. There is no `tabId` in the result. An unexpected data-URL format from the browser is an error, not a silently passed-through string. On Firefox, capture without a user gesture is impossible in MV3 (granted host permissions are never treated as the capture permission), so the call fails with `ok:false` and an error explaining the one supported path: the user clicks the extension's toolbar button on the tab, which grants `activeTab` until the tab navigates, after which `screenshot` succeeds. There is no silent alternative capture path.
- `download` runs through the browser's own downloader, so it carries the user's cookies and session — which is the point of downloading through the extension rather than fetching the URL server-side.
- `runJs` returns `{result: <value>}`, with `null` substituted when the evaluated code produced `undefined`. Despite being a page-level operation it is handled by the background script, not the content script: see below.

**Page interaction** (dispatched to the content script of the target tab, top frame only):

| Method | Params | Result |
| --- | --- | --- |
| `readPage` | `mode`: `"text" \| "outline" \| "links" \| "forms"` (default `"text"`), `tabId` (optional) | `{url, title, content}`; `content` is mode-dependent, see below. |
| `click` | `selector` (string) **or** `text` (string), `tabId` (optional) | `{clicked: {selector, tag, text}}` |
| `fill` | `selector` (string, required), `value` (string), `submit` (boolean, optional), `tabId` (optional) | `{}` |
| `scroll` | `direction`: `"up" \| "down" \| "top" \| "bottom"` (required), `amount` (number, viewport pages, default 1), `tabId` (optional) | `{y}` |
| `setClipboard` | `text` (string), `tabId` (optional) | `{}` |
| `getPageState` | `tabId` (optional) | `{url, title, readyState, scrollY, activeElementSelector?}` |

`readPage` always returns the same three-key envelope — `url` (the page's `location.href`), `title` (`document.title`), and `content`. There is no `mode` field in the result; the caller knows which mode it asked for. An unknown mode is an error naming the four valid ones.

| `mode` | `content` shape |
| --- | --- |
| `text` | **String.** `document.body.innerText` with horizontal whitespace runs collapsed, indentation stripped, and runs of three or more newlines reduced to two, so paragraph structure survives. Capped at 15000 characters, with `...[truncated]` appended when the cap applied. |
| `outline` | **String**, not a structured list. Visible `h1`/`h2`/`h3` headings in document order, one per line, indented by two spaces per heading level below `h1`. If any visible landmarks exist, a blank line, the line `Landmarks:`, and one `[name] label` line per landmark are appended. A landmark is a `nav`/`main`/`header`/`footer`/`aside` element or an element whose `role` is one of `banner`, `navigation`, `main`, `complementary`, `contentinfo`, `search`, `form`, `region`; `name` is the role if present, otherwise the tag; `label` comes from `aria-label` or `aria-labelledby` and is omitted when absent. Headings carry no level number and no selector. |
| `links` | **Array** of `{text, href}`, at most 200 entries, visible anchors only, in document order. `text` is the anchor's trimmed text, falling back to its `aria-label`, capped at 200 characters; `href` is the resolved URL, or the raw attribute, or `""`. **There is no `selector` field** — a link is acted on by navigating to its `href`. |
| `forms` | **Array** of `{selector, fields}` groups, one per `<form>` in document order. Each field is `{selector, tag, type, name, label, value}` plus `redacted: true` when §5 applies and `options: [{value, text}]` (at most 20) for `<select>`. `type` is the field's `type` attribute, defaulting to `"text"` for a bare `<input>` and to the tag name otherwise; `name` and `label` are `null` when unresolvable. Inputs, textareas and selects outside any form are collected into a final group whose `selector` is the literal string `"(no form)"`. |

`click` accepts `selector` or `text`; `selector` wins when both are given. With `text`, the extension ranks visible clickable candidates by exact match, then prefix match, then substring match, breaking ties by shortest text, and clicks the best one; when nothing matches at all the error lists up to ten of the clickable texts that were available. The element is scrolled into view before being clicked. The result is **nested under `clicked`** and reports the selector actually clicked, so the assistant can reuse it deterministically next time.

`fill` returns an empty object. It reports `submit` neither back nor as a `submitted` flag, and it does not report whether the field was redacted — that shows up in the resulting `input` event instead. If `submit` is true, the containing `<form>` is submitted via `requestSubmit()`, or, when the field is in no form, an `Enter` keydown/keyup pair is dispatched on the element.

`scroll` moves by `amount` viewport heights for `up`/`down`, and to offset 0 or to `document.documentElement.scrollHeight` for `top`/`bottom`. It scrolls instantly, not smoothly, and returns only the resulting `y` offset — no `maxY` and no `pct`. Any other direction is an error.

`setClipboard` writes through `navigator.clipboard.writeText` in the page, which is why it is a content-script method and needs a reachable tab even though it has nothing to do with that tab's content.

`getPageState` is the cheap orientation read: `readyState` is `document.readyState`, `scrollY` is a rounded pixel offset (not an object, and not a percentage), and `activeElementSelector` is present only when something other than `<body>` is focused. It backs the `browser_page_state` MCP tool.

For `input` and `textarea` targets, `fill` sets the value through the **native value setter** on the element's prototype and then dispatches `input` and `change` events. This is required for React and other frameworks that track values on the property descriptor and ignore direct assignment; without it, a filled field looks filled but the framework's state never updates. A `<select>` is matched by option value first and then by option text, and dispatches `input` and `change`; a contenteditable element has its `textContent` replaced and dispatches `input` only. Any other element is an error naming the tag that was found.

`runJs` evaluates `code` in the page's **main world** (not the isolated content-script world), so it sees the page's own globals. It is injected by the background script through `scripting.executeScript` with `world: "MAIN"` into frame 0 of the target tab — it does not travel through the content script, and therefore does not need one. Main-world injection is why the manifest pins Firefox to 128 or newer (`strict_min_version`); Chrome has supported it far longer. A strict page Content-Security-Policy can block it. When it does, the call fails with `ok:false` and an explanatory error that names CSP as the likely cause. There is no alternative injection strategy and no fallback — one operation, one mechanism.

The six page-interaction methods above require a content script in the target tab. On browser-internal pages (`chrome://`, `about:`), the Chrome Web Store, addons.mozilla.org, and other extensions' pages, the browser does not permit content scripts, so these calls fail with an error that names the tab and explains why it is unreachable. On Firefox they additionally require the host permission to be granted (MV3 host permissions are opt-in there; see the README setup instructions).

## 9. Summary of invariants

- Exactly one JSON object per WebSocket message, always with a `kind`.
- Exactly one extension connection; a new `hello` supersedes the old, and only the adopted socket's frames are honoured.
- `seq` is hub-assigned, dense, strictly increasing, per server run, ordered by arrival. The JSONL log rotates per UTC day, independently of server runs.
- Every `rpc` gets exactly one `rpc_result` with the matching `id`, or fails: by timeout (20 seconds by default, overridable per call), on extension disconnect, or on server shutdown.
- Redaction happens in the page, before transmission, for events, reads and demonstrations alike.
- Every event is attributed to `user` or `agent`; observation defaults to `user`.
- Failures are explicit `ok:false` errors. Nothing is queued, retried, or silently substituted.

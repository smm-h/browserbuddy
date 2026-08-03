'use strict';

// BrowserBuddy content script.
// Observes in-page user activity and executes the page-level half of the RPC
// surface (readPage, click, fill, scroll, setClipboard, getPageState).

(function () {
  if (window.__browserBuddyLoaded) return;
  window.__browserBuddyLoaded = true;

  // Firefox's promise-based API surface is `browser`; Chrome's `chrome` is
  // promise-based in MV3. One binding gives both browsers the same surface.
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  const INPUT_DEBOUNCE_MS = 800;
  const SCROLL_DEBOUNCE_MS = 600;
  const TEXT_CAP = 15000;
  const SELECTOR_CAP = 200;
  const CSS_PATH_MAX_DEPTH = 8;
  const CLIP_PREVIEW = 200;
  const CLICK_TEXT_CAP = 80;
  const LINK_CAP = 200;
  const OPTION_CAP = 20;

  const SENSITIVE_RE = /pass(word)?|card|cvv|cvc|ssn|secret|token|otp|pin\b/i;
  const AUTO_ID_RE = /\d{4,}|^[a-f0-9-]{8,}$/i;
  // The single definition of "clickable". Used by the text-based click RPC and,
  // widened, by the click observer — so anything whose click can be observed is
  // also reachable by click{text}.
  const CLICKABLE_SELECTOR =
    'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    'input[type="button"], input[type="submit"], label, summary, [onclick], select';

  // Observation is deliberately broader: any input, not only buttons.
  const CLICK_OBSERVE_SELECTOR = CLICKABLE_SELECTOR + ', input, select';
  const LANDMARK_TAGS = ['nav', 'main', 'header', 'footer', 'aside'];
  const LANDMARK_ROLES = [
    'banner',
    'navigation',
    'main',
    'complementary',
    'contentinfo',
    'search',
    'form',
    'region'
  ];

  // True while this script is performing an agent RPC, so DOM listeners can
  // attribute the resulting events to the agent instead of the user.
  let agentActing = false;

  // Epoch ms until which DOM activity is the agent's even though this script is
  // not the one acting. Raised by the background before `runJs`, whose injected
  // code runs in the page's main world and never touches `agentActing`. The two
  // mechanisms coexist: whichever deadline is later wins.
  let agentUntil = 0;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function normText(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisible(el) {
    return !!el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  }

  function attrEscape(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function attr(el, name) {
    return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  }

  // ---------------------------------------------------------------------
  // Selector construction (must round-trip: observed selectors get replayed)
  // ---------------------------------------------------------------------

  function pathSegment(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const siblings = Array.prototype.filter.call(parent.children, function (c) {
      return c.tagName === el.tagName;
    });
    if (siblings.length === 1) return tag;
    return tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
  }

  function cssPath(el) {
    const segments = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && segments.length < CSS_PATH_MAX_DEPTH) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') break;
      segments.unshift(pathSegment(cur));
      cur = cur.parentElement;
    }
    if (segments.length === 0) return el.tagName ? el.tagName.toLowerCase() : '*';

    // Grow the path outwards from the element until the candidate resolves back
    // to el. Adding ancestors only ever narrows the match set, so the first
    // candidate that resolves to el is also the shortest one that does.
    // Uniqueness beats the char cap: a long selector that matches el is always
    // better than a short one that would act on the wrong element.
    let deepest = segments[segments.length - 1];
    for (let take = 1; take <= segments.length; take++) {
      const candidate = segments.slice(segments.length - take).join(' > ');
      deepest = candidate;
      let matches = false;
      try {
        matches = document.querySelector(candidate) === el;
      } catch (e) {
        matches = false;
      }
      if (matches) return candidate;
    }

    // No candidate resolved to el, so trimming cannot break a working match.
    // Drop outer segments rather than truncating, so the selector stays valid.
    const parts = deepest.split(' > ');
    while (parts.length > 1 && parts.join(' > ').length > SELECTOR_CAP) parts.shift();
    return parts.join(' > ');
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();

    const id = attr(el, 'id');
    if (id && !AUTO_ID_RE.test(id)) {
      const sel = '#' + (window.CSS && CSS.escape ? CSS.escape(id) : id);
      if (isUnique(sel)) return sel;
    }

    const testId = attr(el, 'data-testid');
    if (testId) {
      const sel = '[data-testid="' + attrEscape(testId) + '"]';
      if (isUnique(sel)) return sel;
    }

    if (/^(input|select|textarea|button|form)$/.test(tag)) {
      const name = attr(el, 'name');
      if (name) {
        const sel = tag + '[name="' + attrEscape(name) + '"]';
        if (isUnique(sel)) return sel;
      }
    }

    const aria = attr(el, 'aria-label');
    if (aria) {
      const sel = tag + '[aria-label="' + attrEscape(aria) + '"]';
      if (isUnique(sel)) return sel;
    }

    return cssPath(el);
  }

  // ---------------------------------------------------------------------
  // Field helpers (redaction, labels, values)
  // ---------------------------------------------------------------------

  function isRedacted(el) {
    if (!el || el.nodeType !== 1) return false;
    const type = String(el.type || attr(el, 'type') || '').toLowerCase();
    if (type === 'password') return true;
    const autocomplete = String(attr(el, 'autocomplete') || '').toLowerCase();
    if (autocomplete.indexOf('cc-') === 0) return true;
    const probe = [attr(el, 'name'), attr(el, 'id'), attr(el, 'aria-label')]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE_RE.test(probe);
  }

  function labelFor(el) {
    const id = attr(el, 'id');
    if (id) {
      try {
        const forLabel = document.querySelector('label[for="' + attrEscape(id) + '"]');
        if (forLabel) {
          const t = normText(forLabel.innerText || forLabel.textContent);
          if (t) return t;
        }
      } catch (e) {
        // Malformed id that cannot be used in a selector; fall through.
      }
    }
    const wrapping = typeof el.closest === 'function' ? el.closest('label') : null;
    if (wrapping) {
      const t = normText(wrapping.innerText || wrapping.textContent);
      if (t) return t;
    }
    const aria = normText(attr(el, 'aria-label'));
    if (aria) return aria;
    const placeholder = normText(attr(el, 'placeholder'));
    if (placeholder) return placeholder;
    return null;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return el.isContentEditable === true || attr(el, 'contenteditable') !== null;
  }

  function fieldValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return el.value == null ? '' : String(el.value);
    }
    return String(el.textContent == null ? '' : el.textContent);
  }

  function inputTypeOf(el) {
    const type = attr(el, 'type');
    if (type) return String(type).toLowerCase();
    const tag = el.tagName.toLowerCase();
    // A bare <input> is a text input as far as the browser is concerned.
    if (tag === 'input') return 'text';
    return tag;
  }

  // True only for form fields whose value must never leave the page.
  function isRedactedField(el) {
    return !!el && el.nodeType === 1 && isEditable(el) && isRedacted(el);
  }

  // ---------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------

  // The protocol's actor set is 'user', 'agent' and 'replay'; 'replay' is
  // reserved for future demonstration playback and is never emitted, so page
  // observation only ever decides between the user and the agent.
  function currentActor() {
    return agentActing || Date.now() <= agentUntil ? 'agent' : 'user';
  }

  function raiseAgentWindow(ms) {
    const duration = typeof ms === 'number' && ms > 0 ? ms : 0;
    const until = Date.now() + duration;
    if (until > agentUntil) agentUntil = until;
  }

  // actorOverride exists for debounced events: the actor must be captured when
  // the DOM listener runs, not when the debounce timer finally fires (by then
  // the 100ms agentActing window has already closed).
  function emit(type, data, actorOverride) {
    try {
      const p = ext.runtime.sendMessage({
        bb: 'event',
        event: {
          ts: Date.now(),
          actor: actorOverride || currentActor(),
          type: type,
          tabId: null,
          url: location.href,
          data: data || {}
        }
      });
      // If the extension was reloaded the promise rejects; stay silent.
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // Extension context invalidated. Nothing useful to do in the page.
    }
  }

  // ---------------------------------------------------------------------
  // User activity listeners
  // ---------------------------------------------------------------------

  function clickTextOf(el) {
    let t = normText(el.innerText || el.textContent);
    if (!t) t = normText(attr(el, 'aria-label'));
    if (!t) {
      // Never surface the value of a sensitive field as click text.
      t = isRedacted(el) ? '[REDACTED]' : normText(el.value);
    }
    return t.slice(0, CLICK_TEXT_CAP);
  }

  document.addEventListener(
    'click',
    function (e) {
      let target = e.target;
      if (target && target.nodeType !== 1) target = target.parentElement;
      if (!target) return;
      const actionable =
        (typeof target.closest === 'function' && target.closest(CLICK_OBSERVE_SELECTOR)) || target;
      const data = {
        selector: buildSelector(actionable),
        text: clickTextOf(actionable),
        tag: actionable.tagName.toLowerCase()
      };
      if (actionable.tagName === 'A' && actionable.href) data.href = actionable.href;
      emit('click', data);
    },
    true
  );

  const inputTimers = new WeakMap();
  const inputActors = new WeakMap();
  const pendingInputs = new Set();

  function emitInput(el) {
    pendingInputs.delete(el);
    inputTimers.delete(el);
    const actor = inputActors.get(el) || 'user';
    inputActors.delete(el);
    const redacted = isRedacted(el);
    const data = {
      selector: buildSelector(el),
      inputType: inputTypeOf(el),
      value: redacted ? '[REDACTED]' : fieldValue(el),
      redacted: redacted
    };
    const name = attr(el, 'name');
    if (name) data.name = name;
    const label = labelFor(el);
    if (label) data.label = label;
    emit('input', data, actor);
  }

  function flushInput(el) {
    const timer = inputTimers.get(el);
    if (timer === undefined) return;
    clearTimeout(timer);
    emitInput(el);
  }

  document.addEventListener(
    'input',
    function (e) {
      const el = e.target;
      if (!isEditable(el)) return;
      const existing = inputTimers.get(el);
      if (existing !== undefined) clearTimeout(existing);
      pendingInputs.add(el);
      inputActors.set(el, currentActor());
      inputTimers.set(
        el,
        setTimeout(function () {
          emitInput(el);
        }, INPUT_DEBOUNCE_MS)
      );
    },
    true
  );

  document.addEventListener(
    'blur',
    function (e) {
      if (e.target && e.target.nodeType === 1) flushInput(e.target);
    },
    true
  );

  window.addEventListener('pagehide', function () {
    Array.from(pendingInputs).forEach(flushInput);
  });

  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      emit('key_command', { key: 'Enter', selector: buildSelector(el) });
    },
    true
  );

  let scrollTimer = null;
  let scrollActor = 'user';
  window.addEventListener(
    'scroll',
    function (e) {
      // capture:true also delivers scrolls of inner containers, which leave
      // window.scrollY unchanged; only the document's own scroll is reported.
      if (e.target !== document && e.target !== document.documentElement) return;
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      scrollActor = currentActor();
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        const y = Math.round(window.scrollY);
        const maxY = Math.max(
          0,
          Math.round(document.documentElement.scrollHeight - window.innerHeight)
        );
        emit(
          'scroll',
          { y: y, maxY: maxY, pct: maxY > 0 ? Math.round((y / maxY) * 100) : 0 },
          scrollActor
        );
      }, SCROLL_DEBOUNCE_MS);
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    'copy',
    function (e) {
      let text = '';
      try {
        text = window.getSelection ? String(window.getSelection()) : '';
      } catch (err) {
        text = '';
      }
      // A copy out of a sensitive field must not preview its contents. The
      // selection lives in the focused field, so activeElement matters too.
      const redacted = isRedactedField(e.target) || isRedactedField(document.activeElement);
      emit('copy', { textPreview: redacted ? '[REDACTED]' : text.slice(0, CLIP_PREVIEW) });
    },
    true
  );

  document.addEventListener(
    'paste',
    function (e) {
      let text = '';
      try {
        text = e.clipboardData ? e.clipboardData.getData('text') : '';
      } catch (err) {
        text = '';
      }
      // Pasting into a sensitive field must not preview the pasted value.
      const preview = isRedactedField(e.target)
        ? '[REDACTED]'
        : String(text || '').slice(0, CLIP_PREVIEW);
      emit('paste', { textPreview: preview });
    },
    true
  );

  document.addEventListener(
    'submit',
    function (e) {
      emit('form_submit', { selector: buildSelector(e.target) });
    },
    true
  );

  // ---------------------------------------------------------------------
  // readPage
  // ---------------------------------------------------------------------

  function readText() {
    const raw = document.body ? document.body.innerText || '' : '';
    // Collapse horizontal runs and excessive blank lines, but keep the
    // paragraph structure that makes the text readable for an agent.
    const text = raw
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + '...[truncated]' : text;
  }

  function landmarkLabel(el) {
    const aria = normText(attr(el, 'aria-label'));
    if (aria) return aria;
    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return normText(ref.innerText || ref.textContent);
    }
    return '';
  }

  function readOutline() {
    const lines = [];
    document.querySelectorAll('h1, h2, h3').forEach(function (h) {
      if (!isVisible(h)) return;
      const text = normText(h.innerText || h.textContent);
      if (!text) return;
      const level = Number(h.tagName.charAt(1));
      lines.push('  '.repeat(level - 1) + text);
    });

    const landmarks = [];
    document.querySelectorAll('nav, main, header, footer, aside, [role]').forEach(function (el) {
      const tag = el.tagName.toLowerCase();
      const role = String(attr(el, 'role') || '').toLowerCase();
      const named = role || tag;
      const qualifies =
        LANDMARK_TAGS.indexOf(tag) !== -1 || LANDMARK_ROLES.indexOf(role) !== -1;
      if (!qualifies || !isVisible(el)) return;
      const label = landmarkLabel(el);
      landmarks.push('[' + named + ']' + (label ? ' ' + label : ''));
    });

    let out = lines.join('\n');
    if (landmarks.length > 0) {
      out += (out ? '\n\n' : '') + 'Landmarks:\n' + landmarks.join('\n');
    }
    return out;
  }

  function readLinks() {
    const out = [];
    const anchors = document.querySelectorAll('a');
    for (let i = 0; i < anchors.length && out.length < LINK_CAP; i++) {
      const a = anchors[i];
      if (!isVisible(a)) continue;
      let text = normText(a.innerText || a.textContent);
      if (!text) text = normText(attr(a, 'aria-label'));
      out.push({ text: text.slice(0, 200), href: a.href || attr(a, 'href') || '' });
    }
    return out;
  }

  function fieldInfo(el) {
    const tag = el.tagName.toLowerCase();
    const redacted = isRedacted(el);
    const info = {
      selector: buildSelector(el),
      tag: tag,
      type: inputTypeOf(el),
      name: attr(el, 'name'),
      label: labelFor(el),
      value: redacted ? '[REDACTED]' : fieldValue(el)
    };
    if (redacted) info.redacted = true;
    if (tag === 'select') {
      info.options = Array.prototype.slice
        .call(el.options, 0, OPTION_CAP)
        .map(function (o) {
          return { value: o.value, text: normText(o.text) };
        });
    }
    return info;
  }

  function readForms() {
    const groups = [];
    const claimed = new Set();
    document.querySelectorAll('form').forEach(function (form) {
      const fields = [];
      form.querySelectorAll('input, textarea, select').forEach(function (el) {
        claimed.add(el);
        fields.push(fieldInfo(el));
      });
      groups.push({ selector: buildSelector(form), fields: fields });
    });

    const orphans = [];
    document.querySelectorAll('input, textarea, select').forEach(function (el) {
      if (claimed.has(el)) return;
      orphans.push(fieldInfo(el));
    });
    if (orphans.length > 0) groups.push({ selector: '(no form)', fields: orphans });

    return groups;
  }

  function rpcReadPage(params) {
    const mode = params.mode || 'text';
    let content;
    if (mode === 'text') content = readText();
    else if (mode === 'outline') content = readOutline();
    else if (mode === 'links') content = readLinks();
    else if (mode === 'forms') content = readForms();
    else throw new Error('readPage: unknown mode "' + mode + '" (expected text, outline, links, or forms)');
    return { url: location.href, title: document.title, content: content };
  }

  // ---------------------------------------------------------------------
  // Acting RPCs
  // ---------------------------------------------------------------------

  function withAgentFlag(fn) {
    agentActing = true;
    try {
      return fn();
    } finally {
      setTimeout(function () {
        agentActing = false;
      }, 100);
    }
  }

  function findByText(wanted) {
    const want = normText(wanted).toLowerCase();
    if (!want) throw new Error('click: text must not be empty');
    const candidates = Array.prototype.filter.call(
      document.querySelectorAll(CLICKABLE_SELECTOR),
      isVisible
    );

    const scored = [];
    candidates.forEach(function (el) {
      const texts = [el.innerText || el.textContent, el.value, attr(el, 'aria-label')]
        .map(function (v) {
          return normText(v).toLowerCase();
        })
        .filter(Boolean);
      let rank = -1;
      let len = Infinity;
      texts.forEach(function (t) {
        let r = -1;
        if (t === want) r = 0;
        else if (t.indexOf(want) === 0) r = 1;
        else if (t.indexOf(want) !== -1) r = 2;
        if (r === -1) return;
        if (rank === -1 || r < rank || (r === rank && t.length < len)) {
          rank = r;
          len = t.length;
        }
      });
      if (rank !== -1) scored.push({ el: el, rank: rank, len: len });
    });

    if (scored.length === 0) {
      const available = [];
      for (let i = 0; i < candidates.length && available.length < 10; i++) {
        const t = clickTextOf(candidates[i]);
        if (t) available.push(JSON.stringify(t));
      }
      throw new Error(
        'No clickable element matching text "' +
          wanted +
          '". Available clickable texts: ' +
          (available.length > 0 ? available.join(', ') : '(none visible)')
      );
    }

    scored.sort(function (a, b) {
      return a.rank - b.rank || a.len - b.len;
    });
    return scored[0].el;
  }

  function rpcClick(params) {
    return withAgentFlag(function () {
      let el;
      if (params.selector) {
        el = document.querySelector(params.selector);
        if (!el) throw new Error('No element matches selector ' + params.selector);
      } else if (params.text) {
        el = findByText(params.text);
      } else {
        throw new Error('click requires either selector or text');
      }
      el.scrollIntoView({ block: 'center' });
      el.click();
      return {
        clicked: {
          selector: buildSelector(el),
          tag: el.tagName.toLowerCase(),
          text: clickTextOf(el)
        }
      };
    });
  }

  function dispatchEnter(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function setNativeValue(el, tag, value) {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    // The native setter is required so React's value tracker sees the change.
    descriptor.set.call(el, value);
  }

  function rpcFill(params) {
    return withAgentFlag(function () {
      if (!params.selector) throw new Error('fill requires a selector');
      const el = document.querySelector(params.selector);
      if (!el) throw new Error('No element matches selector ' + params.selector);
      const tag = el.tagName.toLowerCase();
      const value = params.value == null ? '' : String(params.value);
      const contentEditable = el.isContentEditable === true || attr(el, 'contenteditable') !== null;

      if (tag === 'select') {
        let index = -1;
        for (let i = 0; i < el.options.length; i++) {
          if (el.options[i].value === value) {
            index = i;
            break;
          }
        }
        if (index === -1) {
          const wanted = normText(value).toLowerCase();
          for (let i = 0; i < el.options.length; i++) {
            if (normText(el.options[i].text).toLowerCase() === wanted) {
              index = i;
              break;
            }
          }
        }
        if (index === -1) {
          throw new Error('No option in ' + params.selector + ' matches "' + value + '"');
        }
        el.selectedIndex = index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tag === 'input' || tag === 'textarea') {
        el.focus();
        setNativeValue(el, tag, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (contentEditable) {
        el.focus();
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        throw new Error(
          'Element ' +
            params.selector +
            ' is not fillable: expected input, textarea, select, or [contenteditable], got <' +
            tag +
            '>'
        );
      }

      if (params.submit) {
        const form = typeof el.closest === 'function' ? el.closest('form') : null;
        if (form) form.requestSubmit();
        else dispatchEnter(el);
      }
      return {};
    });
  }

  function rpcScroll(params) {
    return withAgentFlag(function () {
      const amount = typeof params.amount === 'number' ? params.amount : 1;
      const page = window.innerHeight * amount;
      const direction = params.direction;
      let top;
      if (direction === 'down') top = window.scrollY + page;
      else if (direction === 'up') top = window.scrollY - page;
      else if (direction === 'top') top = 0;
      else if (direction === 'bottom') top = document.documentElement.scrollHeight;
      else throw new Error('scroll: direction must be one of up, down, top, bottom');
      window.scrollTo({ top: top, behavior: 'instant' });
      return { y: Math.round(window.scrollY) };
    });
  }

  function rpcSetClipboard(params) {
    const text = params.text == null ? '' : String(params.text);
    return navigator.clipboard.writeText(text).then(function () {
      return {};
    });
  }

  function rpcGetPageState() {
    const state = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: Math.round(window.scrollY)
    };
    const active = document.activeElement;
    if (active && active.nodeType === 1 && active !== document.body) {
      state.activeElementSelector = buildSelector(active);
    }
    return state;
  }

  function dispatchRpc(method, params) {
    switch (method) {
      case 'readPage':
        return rpcReadPage(params);
      case 'click':
        return rpcClick(params);
      case 'fill':
        return rpcFill(params);
      case 'scroll':
        return rpcScroll(params);
      case 'setClipboard':
        return rpcSetClipboard(params);
      case 'getPageState':
        return rpcGetPageState();
      default:
        throw new Error('Unknown content RPC method: ' + method);
    }
  }

  ext.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.bb === 'agentWindow') {
      raiseAgentWindow(msg.ms);
      sendResponse({ ok: true });
      return;
    }
    if (msg.bb !== 'rpc') return;
    // The page may navigate away before the reply is sent, invalidating the
    // message channel. The hub's RPC timeout covers the lost reply.
    function respond(payload) {
      try {
        sendResponse(payload);
      } catch (e) {
        // Message port already closed; nothing useful to do in the page.
      }
    }
    Promise.resolve()
      .then(function () {
        return dispatchRpc(msg.method, msg.params || {});
      })
      .then(function (result) {
        respond({ ok: true, result: result === undefined ? {} : result });
      })
      .catch(function (err) {
        respond({
          ok: false,
          error: err && err.message ? err.message : String(err)
        });
      });
    return true; // response is sent asynchronously
  });
})();

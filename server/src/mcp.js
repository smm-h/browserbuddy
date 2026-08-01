import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const tabId = z.number().describe('Browser tab id; defaults to the active tab when omitted.');

/** browser_state is an orientation call: it must answer fast even when the page is busy. */
const STATE_LIST_TABS_TIMEOUT_MS = 5000;

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Flattens an event's data into the top level for compact agent-facing output. */
function renderEvent(event) {
  const { seq, ts, actor, type, tabId: tab, url, data } = event;
  // Data first: the event's own canonical fields must win over same-named keys in data.
  return { ...(data ?? {}), seq, ts, actor, type, tabId: tab ?? null, url: url ?? null };
}

/**
 * Acting tools: thin wrappers that forward to an extension RPC. Each entry may
 * supply `params` (tool args -> RPC params) and `result` (RPC result -> MCP result).
 */
const ACTING_TOOLS = [
  {
    name: 'browser_tabs',
    method: 'listTabs',
    description: 'List all open browser tabs with their ids, urls, titles, and which one is active. Use this to find the tabId for other tools.',
    schema: {}
  },
  {
    name: 'browser_open_tab',
    method: 'newTab',
    description: 'Open a new browser tab, optionally at a url. Returns the new tabId.',
    schema: { url: z.string().optional().describe('Url to open; a blank tab is opened when omitted.') }
  },
  {
    name: 'browser_close_tab',
    method: 'closeTab',
    description: 'Close the browser tab with the given id.',
    schema: { tabId: z.number().describe('Browser tab id to close.') }
  },
  {
    name: 'browser_focus_tab',
    method: 'activateTab',
    description: 'Bring the given tab to the foreground so the user sees it.',
    schema: { tabId: z.number().describe('Browser tab id to activate.') }
  },
  {
    name: 'browser_navigate',
    method: 'navigate',
    description: 'Navigate a tab to a url. Use this instead of opening a new tab when you want to reuse the current one.',
    schema: { url: z.string().describe('Destination url.'), tabId: tabId.optional() }
  },
  {
    name: 'browser_back',
    method: 'goBack',
    description: 'Go back one entry in the tab history.',
    schema: { tabId: tabId.optional() }
  },
  {
    name: 'browser_forward',
    method: 'goForward',
    description: 'Go forward one entry in the tab history.',
    schema: { tabId: tabId.optional() }
  },
  {
    name: 'browser_reload',
    method: 'reload',
    description: 'Reload the tab.',
    schema: { tabId: tabId.optional() }
  },
  {
    name: 'browser_read',
    method: 'readPage',
    description: 'Read the current page as text, an outline of headings, its links, or its form fields. This is the primary way to see what is on screen.',
    schema: {
      mode: z.enum(['text', 'outline', 'links', 'forms']).default('text').describe('What to extract from the page.'),
      tabId: tabId.optional()
    }
  },
  {
    name: 'browser_screenshot',
    method: 'screenshot',
    description: 'Capture a JPEG screenshot of the visible area of a tab. Use it when the page layout or visual state matters.',
    schema: { tabId: tabId.optional() },
    result: (r) => ({ content: [{ type: 'image', data: r.base64, mimeType: 'image/jpeg' }] })
  },
  {
    name: 'browser_click',
    method: 'click',
    description: 'Click an element, located either by CSS selector or by its visible text. Provide at least one of selector or text.',
    schema: {
      selector: z.string().optional().describe('CSS selector of the element to click.'),
      text: z.string().optional().describe('Visible text of the element to click.'),
      tabId: tabId.optional()
    },
    validate: (args) => {
      if (!args.selector && !args.text) {
        throw new Error('browser_click requires either "selector" or "text".');
      }
    }
  },
  {
    name: 'browser_fill',
    method: 'fill',
    description: 'Type a value into a form field identified by CSS selector, optionally submitting the form afterwards.',
    schema: {
      selector: z.string().describe('CSS selector of the input or textarea.'),
      value: z.string().describe('Value to type into the field.'),
      submit: z.boolean().default(false).describe('Submit the containing form after filling.'),
      tabId: tabId.optional()
    }
  },
  {
    name: 'browser_scroll',
    method: 'scroll',
    description: 'Scroll the page up, down, to the top, or to the bottom. Returns the resulting scroll position.',
    schema: {
      direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Scroll direction.'),
      amount: z.number().default(1).describe('Number of viewport-sized steps to scroll for up/down.'),
      tabId: tabId.optional()
    }
  },
  {
    name: 'browser_zoom',
    method: 'zoom',
    description: 'Set the zoom factor of a tab (1 is 100%). Useful to fit more content on screen before reading or screenshotting.',
    schema: { factor: z.number().describe('Zoom factor, where 1 means 100%.'), tabId: tabId.optional() }
  },
  {
    name: 'browser_set_clipboard',
    method: 'setClipboard',
    description: "Put text on the user's system clipboard so they can paste it themselves.",
    schema: { text: z.string().describe('Text to place on the clipboard.') }
  },
  {
    name: 'browser_download',
    method: 'download',
    description: 'Download a url through the browser, optionally under a given filename.',
    schema: {
      url: z.string().describe('Url to download.'),
      filename: z.string().optional().describe('Suggested filename for the download.')
    }
  },
  {
    name: 'browser_page_state',
    method: 'getPageState',
    description: 'Lightweight page status for the current or given tab: url, title, readyState, scroll position, focused element. Cheaper than browser_read for checking where things stand.',
    schema: { tabId: tabId.optional() }
  },
  {
    name: 'browser_eval',
    method: 'runJs',
    description: 'Run JavaScript in the page and return its result. Use it when no dedicated tool covers what you need.',
    schema: { code: z.string().describe('JavaScript source to evaluate in the page.'), tabId: tabId.optional() }
  }
];

export function createMcpServer({ hub, store, demos }) {
  const server = new McpServer({ name: 'browserbuddy', version: '0.1.0' });

  for (const tool of ACTING_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args = {}) => {
        if (tool.validate) tool.validate(args);
        const params = tool.params ? tool.params(args) : args;
        const result = await hub.rpc(tool.method, params);
        return tool.result ? tool.result(result) : jsonResult(result);
      }
    );
  }

  server.registerTool(
    'browser_state',
    {
      description: 'Snapshot of the browser session: whether the extension is connected, the active tab, whether a demonstration is recording, and how many events are currently retained (up to 1000). Call this first to orient yourself.',
      inputSchema: {}
    },
    async () => {
      const connected = hub.isConnected();
      let activeTab = null;
      let activeTabError = null;
      if (connected) {
        try {
          const { tabs = [] } = await hub.rpc('listTabs', {}, STATE_LIST_TABS_TIMEOUT_MS);
          activeTab = tabs.find((t) => t.active) ?? null;
        } catch (err) {
          // Orientation must stay cheap and answerable: report the failure
          // rather than failing the whole tool.
          activeTabError = err.message;
        }
      }
      return jsonResult({
        connected,
        activeTab,
        ...(activeTabError ? { activeTabError } : {}),
        recording: demos.currentInfo(),
        eventCount: store.eventCount(),
        latestSeq: store.latestSeq()
      });
    }
  );

  server.registerTool(
    'browser_observe',
    {
      description: 'Read recent browser activity (navigation, clicks, typing, scrolling, tabs). Pass the previous latestSeq as sinceSeq to get only what happened since your last look.',
      inputSchema: {
        sinceSeq: z.number().optional().describe('Return only events with a seq greater than this.'),
        limit: z.number().int().min(1).max(200).default(30).describe('Maximum number of events to return, most recent kept.'),
        types: z.array(z.string()).optional().describe('Restrict to these event types.'),
        actor: z.enum(['user', 'agent', 'all']).default('user').describe('Whose actions to return.')
      }
    },
    async ({ sinceSeq, limit, types, actor }) => {
      const events = store.query({ sinceSeq, types, actor, limit });
      return jsonResult({ events: events.map(renderEvent), latestSeq: store.latestSeq() });
    }
  );

  server.registerTool(
    'browser_wait_for_user',
    {
      description: 'Block until the user performs their next action in the browser. Use this to work in lockstep: hand a step to the user, wait, then continue.',
      inputSchema: {
        types: z.array(z.string()).optional().describe('Only return when one of these event types occurs.'),
        tabId: z.number().optional().describe('Only return for events in this tab.'),
        timeoutSec: z.number().int().min(1).max(600).default(120).describe('How long to wait before giving up.')
      }
    },
    async ({ types, tabId: tab, timeoutSec }) => {
      const event = await store.waitFor({ types, tabId: tab, actor: 'user' }, timeoutSec * 1000);
      return jsonResult(event ? { event: renderEvent(event) } : { timedOut: true });
    }
  );

  server.registerTool(
    'demo_record_start',
    {
      description: "Start recording the user's actions as a named, replayable demonstration.",
      inputSchema: {
        name: z.string().describe('Name of the demonstration.'),
        description: z.string().optional().describe('What this demonstration accomplishes.'),
        overwrite: z.boolean().default(false).describe('Replace an existing demonstration with the same name.')
      }
    },
    async ({ name, description, overwrite }) => {
      demos.start(name, description ?? '', overwrite);
      return jsonResult({ recording: true, name });
    }
  );

  server.registerTool(
    'demo_record_stop',
    {
      description: 'Stop the active recording and save the cleaned, replayable steps.',
      inputSchema: {}
    },
    async () => {
      const demo = demos.stop();
      return jsonResult({ name: demo.name, stepCount: demo.steps.length, steps: demo.steps });
    }
  );

  server.registerTool(
    'demo_list',
    {
      description: 'List saved demonstrations. Check here before asking the user how to do something.',
      inputSchema: {}
    },
    async () => jsonResult({ demos: demos.list() })
  );

  server.registerTool(
    'demo_get',
    {
      description: 'Retrieve a saved demonstration and its steps so you can replay them with the acting tools.',
      inputSchema: { name: z.string().describe('Demonstration name or slug.') }
    },
    async ({ name }) => jsonResult(demos.get(name))
  );

  return server;
}

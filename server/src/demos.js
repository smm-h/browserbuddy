import fs from 'node:fs';
import path from 'node:path';

const CAPTURED_TYPES = new Set([
  'navigation',
  'click',
  'input',
  'form_submit',
  'key_command',
  'tab_created',
  'tab_closed',
  'tab_activated',
  'download_started',
  'page_loaded'
]);

const REDACTION_NOTE = 'value was redacted for privacy; obtain it from the user at replay time';

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Records user actions into named, replayable demonstrations stored as JSON.
 */
export class DemoRecorder {
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new Error('DemoRecorder requires a dataDir');
    this.demosDir = path.join(dataDir, 'demos');
    this.active = null;
  }

  isRecording() {
    return this.active !== null;
  }

  currentInfo() {
    if (!this.active) return null;
    return {
      name: this.active.name,
      description: this.active.description,
      stepsSoFar: this.active.events.length
    };
  }

  start(name, description = '', overwrite = false) {
    if (this.active) {
      throw new Error(`Already recording demonstration "${this.active.name}". Stop it first with demo_record_stop.`);
    }
    if (!name || !String(name).trim()) throw new Error('Demonstration name is required.');
    const slug = slugify(name);
    if (!slug) throw new Error(`Demonstration name "${name}" does not produce a usable slug.`);
    if (!overwrite && fs.existsSync(this.#fileFor(slug))) {
      throw new Error(`A demonstration named "${slug}" already exists. Pass overwrite: true to replace it.`);
    }
    this.active = { name, slug, description, events: [], startedAt: Date.now() };
    return { recording: true, name, slug };
  }

  capture(event) {
    if (!this.active) return;
    if (event.actor !== 'user') return;
    if (!CAPTURED_TYPES.has(event.type)) return;
    this.active.events.push(event);
  }

  stop() {
    if (!this.active) {
      throw new Error('Not currently recording a demonstration.');
    }
    const active = this.active;
    this.active = null;

    const cleaned = cleanEvents(active.events);
    const demo = {
      name: active.name,
      slug: active.slug,
      description: active.description,
      createdAt: new Date().toISOString(),
      steps: cleaned.map(toStep),
      rawEventCount: active.events.length
    };
    fs.mkdirSync(this.demosDir, { recursive: true });
    fs.writeFileSync(this.#fileFor(active.slug), `${JSON.stringify(demo, null, 2)}\n`);
    return demo;
  }

  list() {
    if (!fs.existsSync(this.demosDir)) return [];
    return fs
      .readdirSync(this.demosDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.demosDir, f), 'utf8')))
      .map((d) => ({
        name: d.name,
        description: d.description,
        createdAt: d.createdAt,
        stepCount: Array.isArray(d.steps) ? d.steps.length : 0
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  get(name) {
    const slug = slugify(name);
    const file = this.#fileFor(slug);
    if (!fs.existsSync(file)) {
      throw new Error(`No demonstration named "${name}" (looked for slug "${slug}"). Use demo_list to see what exists.`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  #fileFor(slug) {
    return path.join(this.demosDir, `${slug}.json`);
  }
}

/**
 * Removes noise from a raw capture: collapses repeated typing into a single
 * input per field, and drops page_loaded events that merely echo a navigation.
 */
function cleanEvents(events) {
  const out = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'input' &&
      event.type === 'input' &&
      prev.data?.selector === event.data?.selector
    ) {
      out[out.length - 1] = event;
      continue;
    }
    if (
      prev &&
      prev.type === 'navigation' &&
      event.type === 'page_loaded' &&
      prev.url === event.url
    ) {
      continue;
    }
    out.push(event);
  }
  return out;
}

function toStep(event) {
  const data = event.data ?? {};
  const step = { type: event.type, url: event.url ?? null };
  switch (event.type) {
    case 'click':
      step.selector = data.selector;
      step.text = data.text;
      break;
    case 'input':
      step.selector = data.selector;
      step.value = data.value;
      step.redacted = Boolean(data.redacted);
      if (data.redacted) step.note = REDACTION_NOTE;
      break;
    case 'form_submit':
      step.selector = data.selector;
      break;
    case 'key_command':
      step.selector = data.selector;
      step.text = data.key;
      break;
    case 'tab_activated':
    case 'page_loaded':
      step.text = data.title;
      break;
    case 'download_started':
      step.text = data.filename;
      break;
    default:
      break;
  }
  for (const key of Object.keys(step)) {
    if (step[key] === undefined) delete step[key];
  }
  return step;
}

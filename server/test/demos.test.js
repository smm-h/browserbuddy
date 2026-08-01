import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DemoRecorder, slugify } from '../src/demos.js';
import { makeTmpDir, removeTmpDir, makeEvent } from './helpers.js';

describe('DemoRecorder', () => {
  let dir;
  let demos;

  beforeEach(() => {
    dir = makeTmpDir('demos');
    demos = new DemoRecorder({ dataDir: dir });
  });

  afterEach(() => {
    removeTmpDir(dir);
  });

  const feed = (events) => events.forEach((e) => demos.capture(makeEvent(e)));

  test('slug rules: lowercase, non-alphanumeric runs collapse, edges trimmed', () => {
    assert.equal(slugify('Log In To Mail'), 'log-in-to-mail');
    assert.equal(slugify('  Weekly__Report (v2)!! '), 'weekly-report-v2');
    assert.equal(slugify('Already-Slugged'), 'already-slugged');
  });

  test('start while recording is an error; stop while idle is an error', () => {
    assert.equal(demos.isRecording(), false);
    assert.throws(() => demos.stop(), /Not currently recording/);
    demos.start('First Demo');
    assert.equal(demos.isRecording(), true);
    assert.throws(() => demos.start('Second Demo'), /Already recording/);
    demos.stop();
    assert.equal(demos.isRecording(), false);
  });

  test('currentInfo reports name and steps so far', () => {
    assert.equal(demos.currentInfo(), null);
    demos.start('Check Mail', 'open the inbox');
    feed([{ type: 'click', data: { selector: '#a', text: 'A' } }]);
    assert.deepEqual(demos.currentInfo(), { name: 'Check Mail', description: 'open the inbox', stepsSoFar: 1 });
  });

  test('capture excludes agent-actor events and non-captured types', () => {
    demos.start('Filtering');
    feed([
      { type: 'click', actor: 'agent', data: { selector: '#agent' } },
      { type: 'scroll', data: { y: 10 } },
      { type: 'copy', data: { textPreview: 'hi' } },
      { type: 'window_focus', data: { focused: true } },
      { type: 'click', data: { selector: '#user', text: 'User' } }
    ]);
    const demo = demos.stop();
    assert.equal(demo.rawEventCount, 1);
    assert.deepEqual(demo.steps, [
      { type: 'click', url: 'https://example.com/', selector: '#user', text: 'User' }
    ]);
  });

  test('consecutive input events on the same selector merge, keeping the last', () => {
    demos.start('Typing');
    feed([
      { type: 'input', data: { selector: '#q', value: 'h', inputType: 'text', redacted: false } },
      { type: 'input', data: { selector: '#q', value: 'he', inputType: 'text', redacted: false } },
      { type: 'input', data: { selector: '#q', value: 'hello', inputType: 'text', redacted: false } },
      { type: 'input', data: { selector: '#other', value: 'x', inputType: 'text', redacted: false } },
      { type: 'input', data: { selector: '#q', value: 'hello again', inputType: 'text', redacted: false } }
    ]);
    const demo = demos.stop();
    assert.equal(demo.rawEventCount, 5);
    assert.deepEqual(demo.steps.map((s) => [s.selector, s.value]), [
      ['#q', 'hello'],
      ['#other', 'x'],
      ['#q', 'hello again']
    ]);
  });

  test('page_loaded immediately following a navigation to the same url is dropped', () => {
    demos.start('Nav');
    feed([
      { type: 'navigation', url: 'https://a.test/', data: { transitionType: 'link' } },
      { type: 'page_loaded', url: 'https://a.test/', data: { title: 'A' } },
      { type: 'navigation', url: 'https://b.test/', data: { transitionType: 'link' } },
      { type: 'page_loaded', url: 'https://c.test/', data: { title: 'C' } }
    ]);
    const demo = demos.stop();
    assert.deepEqual(demo.steps, [
      { type: 'navigation', url: 'https://a.test/' },
      { type: 'navigation', url: 'https://b.test/' },
      { type: 'page_loaded', url: 'https://c.test/', text: 'C' }
    ]);
  });

  test('redacted input steps carry the privacy note', () => {
    demos.start('Login');
    feed([
      { type: 'input', data: { selector: '#pw', value: '', inputType: 'password', redacted: true } },
      { type: 'form_submit', data: { selector: 'form#login' } }
    ]);
    const demo = demos.stop();
    assert.equal(demo.steps[0].redacted, true);
    assert.equal(demo.steps[0].note, 'value was redacted for privacy; obtain it from the user at replay time');
    assert.deepEqual(demo.steps[1], { type: 'form_submit', url: 'https://example.com/', selector: 'form#login' });
  });

  test('key_command and tab/download events map to steps', () => {
    demos.start('Misc');
    feed([
      { type: 'key_command', data: { key: 'Enter', selector: '#q' } },
      { type: 'tab_created', url: 'https://n.test/' },
      { type: 'tab_activated', data: { title: 'Tab Title' } },
      { type: 'download_started', data: { filename: 'report.pdf' } },
      { type: 'tab_closed' }
    ]);
    const demo = demos.stop();
    assert.deepEqual(demo.steps, [
      { type: 'key_command', url: 'https://example.com/', selector: '#q', text: 'Enter' },
      { type: 'tab_created', url: 'https://n.test/' },
      { type: 'tab_activated', url: 'https://example.com/', text: 'Tab Title' },
      { type: 'download_started', url: 'https://example.com/', text: 'report.pdf' },
      { type: 'tab_closed', url: 'https://example.com/' }
    ]);
  });

  test('persists to disk and roundtrips through list/get', () => {
    demos.start('Log In To Mail', 'signs in to webmail');
    feed([{ type: 'click', data: { selector: '#signin', text: 'Sign in' } }]);
    const saved = demos.stop();

    const file = path.join(dir, 'demos', 'log-in-to-mail.json');
    assert.ok(fs.existsSync(file));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, saved);
    assert.equal(onDisk.slug, 'log-in-to-mail');
    assert.ok(!Number.isNaN(Date.parse(onDisk.createdAt)));

    assert.deepEqual(demos.list(), [
      { name: 'Log In To Mail', description: 'signs in to webmail', createdAt: saved.createdAt, stepCount: 1 }
    ]);

    // get() accepts either the name or the slug.
    assert.deepEqual(demos.get('Log In To Mail'), saved);
    assert.deepEqual(demos.get('log-in-to-mail'), saved);
    assert.throws(() => demos.get('nope'), /No demonstration named "nope"/);
  });

  test('overwrite is required to replace an existing demonstration', () => {
    demos.start('Dup');
    demos.stop();
    assert.throws(() => demos.start('Dup'), /already exists/);
    demos.start('Dup', 'second take', true);
    feed([{ type: 'click', data: { selector: '#x', text: 'X' } }]);
    const replaced = demos.stop();
    assert.equal(replaced.description, 'second take');
    assert.equal(replaced.steps.length, 1);
    assert.equal(demos.list().length, 1);
  });
});

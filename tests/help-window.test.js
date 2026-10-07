'use strict';

/**
 * The guide window.
 *
 * NexusChat keeps the long explanations in ONE dialog — the top-bar Help chip,
 * a `?` on every section and F1 all open it — instead of a paragraph under
 * every heading. These tests pin both halves of that deal: the markup/app.js
 * contract as text, and the window itself loaded in a VM with a small DOM stub
 * so the registry, the topic menu and the open/close wiring run for real.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appJs = read('src/renderer/app.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/theme.css');

/* ---------------- markup + wiring ---------------- */

test('the guide is one dialog with a topic menu and a reading pane', () => {
  const tag = html.match(/<div id="helpModal"[^>]*>/);
  assert.ok(tag, '#helpModal is in the markup');
  assert.ok(tag[0].includes('hidden'), 'it starts hidden');
  assert.ok(tag[0].includes('role="dialog"'), 'role dialog');
  assert.ok(tag[0].includes('aria-modal="true"'), 'aria-modal');
  assert.ok(tag[0].includes('aria-labelledby="helpTitle"'), 'labelled by its title');
  for (const id of ['helpTitle', 'helpTopics', 'helpTopicTitle', 'helpBody', 'helpCloseBtn', 'helpDoneBtn']) {
    assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
  }
  assert.ok(appJs.includes('function openHelp(') && appJs.includes('function closeHelp('), 'open/close exist');
  assert.ok(appJs.includes('bindHelp();'), 'bound during boot');
  assert.ok(
    appJs.indexOf('bindHelp();') < appJs.indexOf('bindComposer();'),
    'bound before the other dialogs so it owns F1/Escape first'
  );
});

test('the help chip and every ? affordance name the topic they open', () => {
  const chip = html.match(/<button[^>]*id="helpBtn"[^>]*>/);
  assert.ok(chip, '#helpBtn present');
  assert.ok(chip[0].includes('data-help="welcome"'), 'the chip opens the guide on the intro topic');
  assert.ok(chip[0].includes('aria-label="'), 'the chip has an accessible name');
  const buttons = [...html.matchAll(/<button[^>]*class="[^"]*\bhelp-btn\b[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.ok(buttons.length >= 8, 'the shell carries a ? per section (' + buttons.length + ')');
  for (const b of buttons) {
    assert.match(b, /data-help="[a-z-]+"/, 'each ? names a topic: ' + b);
    assert.match(b, /aria-label="[^"]+"/, 'each ? has an accessible name: ' + b);
    assert.match(b, /title="[^"]+"/, 'each ? has a tooltip: ' + b);
  }
  assert.ok(html.includes('class="help-link" data-help="bots"'), 'the bots sidebar links to the bots topic');
});

test('every ? in the markup points at a topic that exists', () => {
  const ids = new Set([...appJs.matchAll(/^ {4}id: '([a-z-]+)',$/gm)].map(m => m[1]));
  assert.ok(ids.size >= 10, 'the registry parsed (' + ids.size + ' topics)');
  const wanted = [...new Set([...html.matchAll(/data-help="([a-z-]+)"/g)].map(m => m[1]))];
  assert.ok(wanted.length >= 8, 'the shell has plenty of affordances');
  const missing = wanted.filter(id => !ids.has(id)).sort();
  assert.deepEqual(missing, [], 'buttons pointing at no topic: ' + missing.join(', '));
});

test('explanations moved into the guide; the shell keeps one-liners', () => {
  // Each phrase used to be a paragraph in the chrome and now lives in the guide.
  for (const phrase of [
    'Skills are instruction blocks added to the system prompt',
    'Nothing is downloaded and no code runs',
    'A bot is a named task that runs on a schedule',
    'closing the window hides the app to the system tray',
    'Keys are encrypted at rest'
  ]) {
    assert.ok(!html.includes(phrase), 'still a wall of text on screen: ' + phrase);
    assert.ok(appJs.includes(phrase), 'missing from the guide: ' + phrase);
  }
  // And it cannot creep back: every visible p.muted left is a single line.
  const long = [];
  for (const m of html.matchAll(/<p class="muted[^"]*"[^>]*>([\s\S]*?)<\/p>/g)) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 200) long.push(t.slice(0, 60));
  }
  assert.deepEqual(long, [], 'paragraphs that belong in the guide: ' + long.join(' | '));
  // Removed features leave nothing behind to explain. ('no subscriptions' in the
  // welcome copy is deliberate — it is the promise, not the feature.)
  for (const gone of ['Chief', 'license', 'Cloud mode', 'bypass code']) {
    assert.ok(!appJs.includes(gone), 'the guide still mentions ' + gone);
  }
});

test('the guide is built from DOM nodes, never interpolated HTML', () => {
  const start = appJs.indexOf('function renderHelpMenu()');
  const end = appJs.indexOf('function applyTheme(theme)');
  assert.ok(start > 0 && end > start, 'the guide block is one contiguous region');
  const block = appJs.slice(start, end);
  assert.ok(!block.includes('${'), 'no template literals in the guide');
  assert.ok(!/\binnerHTML\b/.test(block), 'the guide never writes innerHTML');
  assert.ok(block.includes('textContent = topic.'), 'topics are painted with textContent');
  assert.ok(block.includes("document.createElement('li')"), 'bullets are DOM nodes');
  assert.ok(block.includes("$$('[data-help]')"), 'every ? affordance is wired from one selector');
});

test('every help style class used by the UI has CSS', () => {
  const used = new Set();
  for (const src of [appJs, html]) {
    for (const m of src.matchAll(/'((?:help)-[a-z-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^help-/.test(c)) used.add(c);
    }
    for (const m of src.matchAll(/className = '([^']*)'/g)) {
      for (const c of m[1].split(/\s+/)) if (/^help-/.test(c)) used.add(c);
    }
  }
  assert.ok(used.size >= 8, 'sanity: found help classes (' + used.size + ')');
  const unstyled = [...used].filter(c => !css.includes('.' + c)).sort();
  assert.deepEqual(unstyled, [], 'no CSS for: ' + unstyled.join(', '));
  // The window scrolls its own panes, and stacks on narrow screens.
  assert.ok(/\.help-body\s*\{[^}]*overflow-y: auto/.test(css), 'the reading pane scrolls');
  assert.ok(css.includes('.help-split { grid-template-columns: 1fr; }'), 'the menu stacks on narrow windows');
});

/* ---------------- the window, actually running ---------------- */

/**
 * A DOM stub with just enough surface for the guide: classList backed by
 * className, dataset, and a document that remembers its keydown listeners.
 */
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    dataset: {},
    style: {},
    className: '',
    _text: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    _listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    get firstElementChild() { return this.children[0] || null; },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    remove() {
      const p = this._parent;
      if (p) p.children = p.children.filter(c => c !== this);
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) {
      const event = Object.assign({
        target: this,
        preventDefault() {},
        stopImmediatePropagation() {}
      }, ev || {});
      for (const fn of this._listeners[type] || []) fn(event);
    },
    querySelectorAll() { return []; },
    focus() {}
  };
  el._parent = null;
  el.classList = {
    _set() { return new Set(String(el.className).split(/\s+/).filter(Boolean)); },
    _apply(s) { el.className = [...s].join(' '); },
    add(c) { const s = this._set(); s.add(c); this._apply(s); },
    remove(c) { const s = this._set(); s.delete(c); this._apply(s); },
    contains(c) { return this._set().has(c); },
    toggle(c, force) {
      const s = this._set();
      const on = force === undefined ? !this._set().has(c) : !!force;
      if (on) s.add(c); else s.delete(c);
      this._apply(s);
      return on;
    }
  };
  return el;
}

const classes = (el) => String(el.className).split(/\s+/).filter(Boolean);

const texts = (el) => {
  const out = [];
  const walk = (n) => {
    if (n._text) out.push(n._text);
    for (const c of n.children) walk(c);
  };
  walk(el);
  return out.join(' | ');
};

/** A document with the real ids, plus one stub button per ? in the markup. */
function makeDocument(helpKeys) {
  const byId = new Map();
  // The window ships hidden; the stub mirrors that starting class.
  const seedClasses = { helpModal: 'modal-backdrop hidden' };
  const helps = helpKeys.map(key => {
    const el = makeEl('button');
    el.dataset.help = key;
    return el;
  });
  const lookup = (sel) => {
    const m = /#([A-Za-z0-9_-]+)/.exec(sel);
    const id = m ? m[1] : sel;
    if (!byId.has(id)) {
      byId.set(id, makeEl(id.startsWith('help') ? 'div' : 'button'));
      byId.get(id).className = seedClasses[id] || '';
    }
    return byId.get(id);
  };
  const docListeners = {};
  const document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => lookup(sel),
    querySelectorAll: (sel) => {
      if (sel === '[data-help]') return helps;
      const menu = /^#([A-Za-z0-9_-]+) \.help-topic$/.exec(sel);
      if (menu) return lookup('#' + menu[1]).children.filter(c => classes(c).includes('help-topic'));
      return [];
    },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    key(type, ev) {
      const event = Object.assign({ preventDefault() {}, stopImmediatePropagation() {} }, ev || {});
      for (const fn of docListeners[type] || []) fn(event);
    }
  };
  document._helps = helps;
  return document;
}

/** Load the real renderer with boot() dropped, exposing just the guide API. */
function loadRenderer() {
  const bootAt = appJs.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');

  const helpKeys = [...new Set([...html.matchAll(/data-help="([a-z-]+)"/g)].map(m => m[1]))];
  const document = makeDocument(helpKeys);
  const nexus = new Proxy({}, { get: () => async () => ({ ok: true }) });
  const sandbox = { document, console, nexus, setTimeout: () => 0, clearTimeout: () => {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appJs.slice(0, bootAt) + `
    globalThis.__api = {
      HELP_TOPICS, openHelp, closeHelp, showHelpTopic, renderHelpMenu, helpIsOpen, bindHelp
    };
  `, sandbox, { filename: 'app.js' });

  return { api: sandbox.__api, document, el: (id) => document.querySelector('#' + id) };
}

test('openHelp paints the topic it was asked for and the menu is built from the registry', () => {
  const { api, el, document } = loadRenderer();
  assert.equal(el('helpModal').classList.contains('hidden'), true, 'the window starts hidden');

  api.openHelp('bots');
  assert.equal(api.helpIsOpen(), true, 'openHelp reveals the window');
  assert.equal(el('helpTopicTitle').textContent, 'How bots work', 'the requested topic is shown');
  assert.match(texts(el('helpBody')), /A bot is a named task/, 'the lead is rendered');
  assert.ok(texts(el('helpBody')).length > 80, 'a topic carries real copy');

  const items = document.querySelectorAll('#helpTopics .help-topic');
  assert.equal(items.length, api.HELP_TOPICS.length, 'one menu item per topic');
  assert.ok(el('helpTopics').children.some(c => classes(c).includes('help-group')), 'the menu is grouped');
  const marked = items.filter(c => classes(c).includes('on'));
  assert.equal(marked.length, 1, 'exactly one menu item is marked');
  assert.equal(marked[0].dataset.helpTopic, 'bots', 'and it is the open topic');

  api.closeHelp();
  assert.equal(el('helpModal').classList.contains('hidden'), true, 'closeHelp hides it again');
});

test('every ? in the shell opens the window on its own topic', () => {
  const { api, el, document } = loadRenderer();
  api.bindHelp();
  assert.ok(document._helps.length >= 8, 'the shell has affordances to click');
  for (const btn of document._helps) {
    btn.dispatch('click');
    const topic = api.HELP_TOPICS.find(t => t.id === btn.dataset.help);
    assert.ok(topic, 'topic exists: ' + btn.dataset.help);
    assert.equal(el('helpTopicTitle').textContent, topic.title, '?' + btn.dataset.help + ' opens its topic');
  }
});

test('F1 toggles the guide and Escape is consumed only while it is open', () => {
  const { api, document } = loadRenderer();
  api.bindHelp();

  document.key('keydown', { key: 'F1' });
  assert.equal(api.helpIsOpen(), true, 'F1 opens the guide');
  document.key('keydown', { key: 'F1' });
  assert.equal(api.helpIsOpen(), false, 'F1 again closes it');

  document.key('keydown', { key: 'F1' });
  let stopped = 0;
  document.key('keydown', { key: 'Escape', stopImmediatePropagation: () => stopped++ });
  assert.equal(api.helpIsOpen(), false, 'Escape closes the guide');
  assert.equal(stopped, 1, 'Escape is swallowed so a dialog behind it stays open');

  stopped = 0;
  document.key('keydown', { key: 'Escape', stopImmediatePropagation: () => stopped++ });
  assert.equal(stopped, 0, 'Escape is left alone when the guide is closed');
});

test('every topic is complete, and an unknown key falls back to the first topic', () => {
  const { api, el } = loadRenderer();
  const ids = new Set();
  for (const t of api.HELP_TOPICS) {
    assert.ok(/^[a-z-]+$/.test(t.id), 'kebab-case id: ' + t.id);
    assert.ok(!ids.has(t.id), 'unique id: ' + t.id);
    ids.add(t.id);
    assert.ok(t.group && t.title, 'group and title on ' + t.id);
    assert.ok(t.kicker || t.title, 'a menu label on ' + t.id);
    assert.ok(t.lead || (t.lines || []).length || (t.bullets || []).length, 'copy to read on ' + t.id);
  }
  api.showHelpTopic('no-such-topic');
  assert.equal(el('helpTopicTitle').textContent, api.HELP_TOPICS[0].title, 'unknown keys never blank the pane');
});

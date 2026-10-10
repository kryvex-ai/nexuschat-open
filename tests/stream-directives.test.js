'use strict';

/**
 * Tool directives must never be visible: not while streaming, not afterwards.
 * The bubble paints through stripStreamDirectives (complete shapes removed, a
 * trailing in-progress shape held back), and the stored message keeps the
 * same rule — malformed fragments stay visible in both, exactly like the main
 * process parser treats them.
 *
 * Runs the real renderer in a VM with the DOM stub agent-ui.test.js uses.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, dataset: {}, style: {},
    className: '', _text: '', value: '', disabled: false, scrollTop: 0,
    _listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    appendChild(c) { this.children.push(c); c._parent = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this._parent) this._parent.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
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

function makeDocument() {
  const byId = new Map();
  return {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => {
      const m = /#([A-Za-z0-9_-]+)/.exec(sel);
      const id = m ? m[1] : sel;
      if (!byId.has(id)) byId.set(id, makeEl('div'));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {}
  };
}

function loadRenderer() {
  const bootAt = appJs.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');
  const document = makeDocument();
  const sandbox = { document, console, nexus: {}, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0 };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appJs.slice(0, bootAt) + `
    currentConvId = "c1";
    globalThis.__api = {
      strip: stripStreamDirectives,
      delta: onChatDelta,
      bubble: () => (typeof streamBubble !== 'undefined' && streamBubble ? streamBubble._text : null)
    };
  `, sandbox, { filename: 'app.js' });
  return sandbox.__api;
}

const SHOT = '[[tool {"name":"read_file","args":{"path":"nexuschat-open/README.md"}}]]Now let me examine the source:';

test('a complete directive never reaches bubble text', () => {
  const api = loadRenderer();
  assert.equal(api.strip(SHOT), 'Now let me examine the source:');
  assert.equal(api.strip('a [[tool {"name":"x","args":{}}]] b'), 'a  b');
  assert.equal(api.strip('no directives here'), 'no directives here');
  assert.equal(api.strip(''), '');
});

test('prose and lookalikes paint untouched', () => {
  const api = loadRenderer();
  assert.equal(api.strip('use [[toolbox]] here'), 'use [[toolbox]] here');
  assert.equal(api.strip('a [[b]] c'), 'a [[b]] c');
  // Malformed JSON is not executable: it stays visible, like the stored text.
  assert.equal(api.strip('oops [[tool {not json}]] done'), 'oops [[tool {not json}]] done');
  assert.equal(api.strip('oops [[tool {"nope":1}]] done'), 'oops [[tool {"nope":1}]] done');
});

test('a partial directive is held back, then released', () => {
  const api = loadRenderer();
  assert.equal(api.strip('Now '), 'Now ');
  assert.equal(api.strip('Now [[tool {"name":"rea'), 'Now ');
  assert.equal(api.strip('Now [[tool {"name":"read_file","args":{"path":"a"}}]] done'), 'Now  done');
});

test('the bubble never shows directive syntax mid-stream', () => {
  const api = loadRenderer();
  const chunks = [
    'Let me look. ',
    '[[tool {"name":"read',
    '_file","args":{"path":"a.txt"}}]]',
    ' Done.'
  ];
  for (const delta of chunks) {
    api.delta({ conversationId: 'c1', delta });
    assert.ok(!String(api.bubble()).includes('[['), 'leaked: ' + api.bubble());
  }
  assert.ok(String(api.bubble()).includes('Let me look.'), 'prose survives');
  assert.ok(String(api.bubble()).includes('Done.'), 'trailing prose survives');
  assert.ok(!String(api.bubble()).includes('read_file'), 'no directive residue');
});

test('deltas for another chat never touch this bubble', () => {
  const api = loadRenderer();
  api.delta({ conversationId: 'other', delta: 'hello' });
  assert.equal(api.bubble(), null, 'no bubble for a foreign chat');
});

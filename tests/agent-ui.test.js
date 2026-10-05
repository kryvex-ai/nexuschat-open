'use strict';

/**
 * The agent's renderer half, run for real in a VM with a small DOM stub:
 * the permission queue, and the tools switch following the conversation.
 *
 * The stub is the same shape help-window.test.js uses — classList backed by
 * className, dataset, and a document that remembers its listeners.
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
    get firstElementChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); c._parent = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this._parent) this._parent.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) {
      const event = Object.assign({ target: this, preventDefault() {}, stopImmediatePropagation() {} }, ev || {});
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

function makeDocument(seedClasses) {
  const byId = new Map();
  const lookup = (sel) => {
    const m = /#([A-Za-z0-9_-]+)/.exec(sel);
    const id = m ? m[1] : sel;
    if (!byId.has(id)) {
      byId.set(id, makeEl(id.startsWith('tool') || id === 'helpModal' ? 'div' : 'button'));
      byId.get(id).className = (seedClasses && seedClasses[id]) || '';
    }
    return byId.get(id);
  };
  const docListeners = {};
  return {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => lookup(sel),
    querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    key(type, ev) {
      const event = Object.assign({ preventDefault() {}, stopImmediatePropagation() {} }, ev || {});
      for (const fn of docListeners[type] || []) fn(event);
    }
  };
}/** Load the real renderer with boot() dropped, exposing the agent UI. */
function loadRenderer(nexusOverrides = {}, convId = 'c1') {
  const bootAt = appJs.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');

  const answered = [];
  const document = makeDocument({ toolModal: 'modal-backdrop hidden' });
  const nexus = Object.assign({
    agentInfo: async () => ({ enabled: true, workspaceOk: true, catalog: [], grants: [], maxSteps: 12 }),
    answerTool: async (id, decision) => { answered.push({ id, decision }); return { ok: true }; },
    onToolAsk: (cb) => { nexus._onAsk = cb; },
    onToolPlan: () => {},
    onToolResult: () => {},
    updateSettings: async () => ({}),
    getConversation: async () => ({ id: convId, messages: [] }),
    getState: async () => ({ settings: {}, brand: { APP_NAME: 'Test' }, providers: [] })
  }, nexusOverrides);

  const sandbox = { document, console, nexus, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0 };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // boot() is deliberately not run, so seed what it would have left behind —
  // after app.js's own `let state`, which would otherwise overwrite it.
  vm.runInContext(
    appJs.slice(0, bootAt) + `
    state = { brand: { APP_NAME: "Test" }, settings: {}, providers: [] };
    currentConvId = ${JSON.stringify(JSON.stringify(convId))};
    globalThis.__api = { bindAgent, showToolAsk, answerTool, renderMessages, updateToolsToggle, getState: () => ({ toolsOn, pendingTool, toolQueue }) };
  `, sandbox, { filename: 'app.js' });

  return { api: sandbox.__api, document, answered, ask: (r) => nexus._onAsk(r) };
}

const tick = () => new Promise(r => setImmediate(r));

test('permission prompts queue instead of overwriting each other', async () => {
  const { api, document, answered, ask } = loadRenderer();
  api.bindAgent();

  // Two writes in a row: the second must not strand the first.
  ask({ id: 'c1', name: 'write_file', risk: 'write', summary: 'Edit a.js', canRemember: true });
  ask({ id: 'c2', name: 'edit_file', risk: 'write', summary: 'Edit b.js', canRemember: true });
  assert.equal(document.querySelector('#toolSummary').textContent, 'Edit a.js', 'the first is on screen');
  assert.equal(document.querySelector('#toolModal').classList.contains('hidden'), false);

  document.querySelector('#toolDenyBtn').dispatch('click');
  await tick(); await tick();
  assert.deepEqual(answered, [{ id: 'c1', decision: 'deny' }]);
  assert.equal(document.querySelector('#toolSummary').textContent, 'Edit b.js', 'the second is shown next');
  assert.equal(document.querySelector('#toolModal').classList.contains('hidden'), false);

  document.querySelector('#toolAllowBtn').dispatch('click');
  await tick(); await tick();
  assert.deepEqual(answered[1], { id: 'c2', decision: 'allow' });
  assert.equal(document.querySelector('#toolModal').classList.contains('hidden'), true, 'closed when the queue is empty');
});

test('Escape denies the prompt on screen, and a dangerous one cannot be remembered', async () => {
  const { api, document, answered, ask } = loadRenderer();
  api.bindAgent();
  ask({ id: 'c9', name: 'run_command', risk: 'danger', summary: 'Run: rm -rf build', canRemember: false });
  assert.equal(document.querySelector('#toolAlwaysBtn').classList.contains('hidden'), true, 'no session button for a dangerous action');
  document.key('keydown', { key: 'Escape' });
  await tick(); await tick();
  assert.deepEqual(answered, [{ id: 'c9', decision: 'deny' }]);
});

test('the tools switch follows the conversation, not the last chat opened', async () => {
  const first = loadRenderer({ getConversation: async () => ({ id: 'c1', tools: true, messages: [] }) }, 'c1');
  await first.api.renderMessages();
  assert.equal(first.api.getState().toolsOn, true, 'a conversation that had tools on keeps them');

  const second = loadRenderer({ getConversation: async () => ({ id: 'c2', tools: false, messages: [] }) }, 'c2');
  await second.api.renderMessages();
  assert.equal(second.api.getState().toolsOn, false, 'another chat does not inherit the switch');
});

test('the queue is never silently dropped: three prompts, three answers', async () => {
  const { api, document, answered, ask } = loadRenderer();
  api.bindAgent();
  for (const id of ['a', 'b', 'c']) ask({ id, name: 'write_file', risk: 'write', summary: 'Edit ' + id, canRemember: true });
  for (let i = 0; i < 3; i++) {
    document.querySelector('#toolAllowBtn').dispatch('click');
    await tick(); await tick();
  }
  assert.deepEqual(answered.map(a => a.id), ['a', 'b', 'c']);
  assert.equal(api.getState().pendingTool, null);
  assert.equal(api.getState().toolQueue.length, 0);
});
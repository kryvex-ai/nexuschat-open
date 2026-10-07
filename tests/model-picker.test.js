'use strict';

/**
 * The model picker: which providers are offered, how the list narrows, which
 * choice survives, and the renderer wiring that draws it.
 *
 * The logic lives in src/renderer/models.js so it can be required and tested
 * directly; the popup itself runs for real here in a VM with a small DOM stub,
 * the same way the guide window and the permission queue are tested.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const models = require('../src/renderer/models.js');
const appJs = read('src/renderer/app.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/theme.css');

/* ---------------- the pure half ---------------- */

const provider = (over) => Object.assign({ id: 'p', name: 'P', kind: 'openai', defaultModels: [] }, over);

test('only ready providers are offered', () => {
  const groups = models.modelGroups([
    provider({ id: 'nokey', name: 'No Key', defaultModels: ['a'] }),
    provider({ id: 'keyed', name: 'Keyed', config: { hasKey: true }, defaultModels: ['a', 'b'] }),
    provider({ id: 'off', name: 'Off', config: { hasKey: true, enabled: false }, defaultModels: ['x'] }),
    provider({ id: 'url', name: 'Self-hosted', requiresBaseUrl: true, config: { baseUrl: 'http://x' }, defaultModels: ['s'] }),
    provider({ id: 'nourl', name: 'No URL', requiresBaseUrl: true, config: { baseUrl: '' }, defaultModels: ['s'] }),
    provider({ id: 'local', name: 'Local', offline: true, defaultModels: ['l'] }),
    provider({ id: 'empty', name: 'Empty', config: { hasKey: true }, defaultModels: [] })
  ]);
  assert.deepEqual(groups.map(g => g.id), ['keyed', 'url', 'local'],
    'no keyless, disabled, URL-less or model-less entries');
  assert.deepEqual(groups[0].models, ['a', 'b'], 'defaults come through in order');
});

test('the list it hands out is a copy, so the registry cannot drift', () => {
  const source = provider({ id: 'k', name: 'K', config: { hasKey: true }, defaultModels: ['a'] });
  const groups = models.modelGroups([source]);
  groups[0].models.push('mutated');
  assert.deepEqual(source.defaultModels, ['a'], 'the source list is untouched');
  assert.deepEqual(models.modelGroups([source])[0].models, ['a'], 'a second build is unaffected');
});

test('a fetched model list replaces the shipped defaults', () => {
  const g = models.modelGroups([provider({
    id: 'x', name: 'X', defaultModels: ['old'], config: { hasKey: true, models: ['new-1', 'new-2'] }
  })]);
  assert.deepEqual(g[0].models, ['new-1', 'new-2']);
});

test('filterGroups narrows by model and provider name', () => {
  const groups = [
    { id: 'openai', label: 'OpenAI', models: ['gpt-5', 'gpt-4o-mini'] },
    { id: 'ollama', label: 'Ollama — Local (offline)', models: ['hermes3', 'llama3.2'] },
    { id: 'groq', label: 'Groq', models: ['llama-3.3-70b-versatile'] }
  ];
  assert.deepEqual(models.filterGroups(groups, ''), groups, 'an empty query keeps everything');
  assert.deepEqual(models.filterGroups(groups, 'GPT').map(g => g.id), ['openai'], 'model match, case-insensitive');
  assert.deepEqual(models.filterGroups(groups, 'ollama').flatMap(g => g.models), ['hermes3', 'llama3.2'],
    'a provider name matches all of its models');
  assert.deepEqual(models.filterGroups(groups, 'openai gpt').flatMap(g => g.models), ['gpt-5', 'gpt-4o-mini'],
    'every term must match');
  assert.deepEqual(models.filterGroups(groups, 'llama').map(g => g.id), ['ollama', 'groq'],
    'a substring matches across providers, in list order');
  assert.deepEqual(models.filterGroups(groups, 'llama').map(g => g.models), [['llama3.2'], ['llama-3.3-70b-versatile']],
    'model names win over the provider name, so "llama" does not drag hermes3 back in');
  assert.deepEqual(models.filterGroups(groups, 'zzz'), [], 'no match is an empty list, not the whole list');
  assert.deepEqual(models.filterGroups(undefined, 'x'), [], 'no groups never throws');
});

test('filterGroups falls back to the provider name only when no model name matches', () => {
  const groups = [
    { id: 'openai', label: 'OpenAI', models: ['gpt-5', 'gpt-4o-mini'] },
    { id: 'ollama', label: 'Ollama — Local (offline)', models: ['hermes3', 'llama3.2', 'qwen2.5'] },
    { id: 'groq', label: 'Groq', models: ['llama-3.3-70b-versatile'] }
  ];
  assert.deepEqual(models.filterGroups(groups, 'ollama').flatMap(g => g.models), ['hermes3', 'llama3.2', 'qwen2.5'],
    'a provider query still shows that provider’s whole list');
  assert.deepEqual(models.filterGroups(groups, 'qwen').flatMap(g => g.models), ['qwen2.5'],
    'a model-name hit suppresses the provider fallback everywhere else');
  assert.deepEqual(models.filterGroups(groups, 'QWEN ollama').flatMap(g => g.models), ['qwen2.5'],
    'in the fallback each term may match a different field: model name + provider name');
});

test('splitSelection round trips providerId::model', () => {
  assert.deepEqual(models.splitSelection('openai::gpt-5'), { providerId: 'openai', model: 'gpt-5' });
  assert.deepEqual(models.splitSelection('x::a::b'), { providerId: 'x', model: 'a::b' }, 'only the first separator splits');
  assert.deepEqual(models.splitSelection(''), { providerId: '', model: '' });
  assert.deepEqual(models.splitSelection(null), { providerId: '', model: '' });
});

test('resolveSelection keeps a live choice and repairs a stale one', () => {
  const groups = [
    { id: 'openai', label: 'OpenAI', models: ['gpt-5', 'gpt-4o'] },
    { id: 'ollama', label: 'Ollama', models: ['hermes3'] }
  ];
  assert.equal(models.resolveSelection(groups, 'ollama::hermes3'), 'ollama::hermes3', 'a choice still on the list survives');
  assert.equal(models.resolveSelection(groups, 'openai::gone'), 'openai::gpt-5', 'a vanished model falls back to the first');
  assert.equal(models.resolveSelection(groups, null), 'openai::gpt-5', 'nothing saved picks the first model');
  assert.equal(models.resolveSelection([], 'openai::gpt-5'), '', 'no providers means no selection');
});

test('firstModelOf only ever offers that provider its own model', () => {
  const groups = [
    { id: 'openai', label: 'OpenAI', models: ['gpt-5'] },
    { id: 'ollama', label: 'Ollama', models: ['hermes3'] }
  ];
  assert.equal(models.firstModelOf(groups, 'ollama'), 'ollama::hermes3');
  assert.equal(models.firstModelOf(groups, 'openai'), 'openai::gpt-5');
  assert.equal(models.firstModelOf(groups, 'missing'), '', 'a provider with no models offers nothing');
  assert.equal(models.firstModelOf(undefined, 'x'), '');
});

/* ---------------- the renderer's half, as text ---------------- */

test('the picker replaced the flat select in the markup', () => {
  assert.ok(!html.includes('modelSelect'), 'the old #modelSelect is gone');
  assert.ok(!appJs.includes('modelSelect'), 'and app.js no longer talks to it');
  for (const id of ['modelPicker', 'modelBtn', 'modelProvider', 'modelName', 'modelPop',
    'modelSearch', 'modelList', 'modelEmpty', 'modelEmptyText', 'modelSetupBtn']) {
    assert.ok(html.includes('id="' + id + '"'), 'markup has #' + id);
  }
  assert.ok(html.includes('<script src="models.js"></script>'), 'models.js is loaded');
  assert.ok(html.indexOf('models.js') < html.indexOf('app.js'), 'before app.js, which needs the global');
  assert.match(appJs, /if \(typeof NexusModels === 'undefined'\) throw new Error\('models\.js did not load'\)/,
    'a missing models.js fails loudly at boot');
});

test('the popup carries listbox semantics and a search field', () => {
  const btn = html.match(/<button[^>]*id="modelBtn"[^>]*>/);
  assert.ok(btn, '#modelBtn present');
  for (const attr of ['aria-haspopup="listbox"', 'aria-expanded="false"', 'aria-controls="modelPop"']) {
    assert.ok(btn[0].includes(attr), 'the trigger declares ' + attr);
  }
  assert.ok(html.includes('id="modelList" class="model-list" role="listbox"'), 'the list is a listbox');
  const search = html.match(/<input[^>]*id="modelSearch"[^>]*>/);
  assert.ok(search && search[0].includes('aria-label="Search models"'), 'the search field has an accessible name');
  assert.ok(html.includes('id="modelPop" class="model-pop hidden"'), 'the popup starts closed');
  assert.match(appJs, /opt\.setAttribute\('role', 'option'\)/, 'options are painted as options');
  assert.match(appJs, /aria-activedescendant/, 'the active option is announced');
});

test('the picker is wired on both sides of the bridge', () => {
  for (const fn of ['paintModelPicker', 'renderModelList', 'setActiveModelOption',
    'openModelPop', 'closeModelPop', 'chooseModel', 'bindModelPicker']) {
    assert.match(appJs, new RegExp('function ' + fn + '\\b'), 'app.js has ' + fn);
  }
  assert.ok(appJs.includes('bindModelPicker();'), 'bound during boot');
  assert.ok(appJs.indexOf('bindHelp();') < appJs.indexOf('bindModelPicker();'),
    'bound after the guide, which owns Escape/F1 first');
  assert.match(appJs, /NexusModels\.modelGroups\(state\.providers\)/, 'the list comes from models.js');
  assert.match(appJs, /NexusModels\.firstModelOf/, 'connecting activates that provider’s model');
  assert.ok(appJs.includes('Save & connect'), 'the save button promises the whole handover');
  assert.ok(!/\bnexus\.[A-Za-z]+/.test(read('src/renderer/models.js')), 'models.js stays pure');
});

test('every picker style class used by the UI has CSS', () => {
  const used = new Set();
  for (const src of [appJs, html]) {
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^model-/.test(c)) used.add(c);
    }
    for (const m of src.matchAll(/className = '([^']*)'/g)) {
      for (const c of m[1].split(/\s+/)) if (/^model-/.test(c)) used.add(c);
    }
  }
  assert.ok(used.size >= 8, 'sanity: found picker classes (' + [...used].join(', ') + ')');
  const unstyled = [...used].filter(c => !css.includes('.' + c)).sort();
  assert.deepEqual(unstyled, [], 'no CSS for: ' + unstyled.join(', '));
  assert.ok(/bottom: calc\(100% \+ 6px\)/.test(css), 'the popup opens upward — the composer sits at the bottom');
});

/* ---------------- the popup, actually running ---------------- */

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, dataset: {}, style: {},
    className: '', _text: '', value: '', disabled: false, id: '',
    scrollTop: 0, _listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    get firstElementChild() { return this.children[0] || null; },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this._parent) this._parent.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) {
      const event = Object.assign({ target: this, preventDefault() {}, stopImmediatePropagation() {} }, ev || {});
      for (const fn of this._listeners[type] || []) fn(event);
    },
    contains(node) {
      for (let n = node; n; n = n._parent) if (n === el) return true;
      return false;
    },
    focus() {},
    scrollIntoView() {},
    querySelectorAll() { return []; },
    // Just enough for the provider cards the CTA route builds: .class and #id.
    querySelector(sel) {
      const isId = sel.startsWith('#');
      const want = isId ? sel.slice(1) : sel.startsWith('.') ? sel.slice(1) : null;
      if (want == null) return null;
      const match = (n) => (isId ? n.id === want : String(n.className).split(/\s+/).includes(want));
      const walk = (n) => {
        for (const c of n.children) {
          if (match(c)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    }
  };
  el._parent = null;
  el.classList = {
    _set: () => new Set(String(el.className).split(/\s+/).filter(Boolean)),
    _apply(s) { el.className = [...s].join(' '); },
    add(c) { const s = this._set(); s.add(c); this._apply(s); },
    remove(c) { const s = this._set(); s.delete(c); this._apply(s); },
    contains(c) { return this._set().has(c); },
    toggle(c, force) {
      const s = this._set();
      const on = force === undefined ? !s.has(c) : !!force;
      if (on) s.add(c); else s.delete(c);
      this._apply(s);
      return on;
    }
  };
  return el;
}

function loadRenderer(state) {
  const bootAt = appJs.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');

  const byId = new Map();
  const docListeners = {};
  const document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector(sel) {
      const m = /#([A-Za-z0-9_-]+)/.exec(sel);
      const id = m ? m[1] : sel;
      if (!byId.has(id)) { const el = makeEl('div'); el.id = id; byId.set(id, el); }
      return byId.get(id);
    },
    querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    dispatch(type, ev) {
      const event = Object.assign({ target: null, preventDefault() {}, stopImmediatePropagation() {} }, ev || {});
      for (const fn of docListeners[type] || []) fn(event);
    }
  };

  const saved = [];
  const nexus = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => ({ ok: true });
    }
  });
  nexus.updateSettings = async (patch) => { saved.push(patch); return Object.assign({}, patch); };

  const sandbox = { document, console, nexus, NexusModels: models, setTimeout: () => 0, clearTimeout: () => {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    appJs.slice(0, bootAt) + `
    state = ${JSON.stringify(state)};
    globalThis.__api = {
      paintModelPicker, renderModelList, openModelPop, closeModelPop, chooseModel,
      bindModelPicker, get: () => ({ modelOpen, modelActive, options: modelOptions.map(o => o.dataset.value) })
    };
  `, sandbox, { filename: 'app.js' });

  return { api: sandbox.__api, document, saved, el: (id) => document.querySelector('#' + id) };
}

const readyState = () => ({
  brand: { APP_NAME: 'NexusChat Open', APP_TAGLINE: 'x' },
  settings: { activeChatModel: 'ollama::hermes3' },
  providers: [
    { id: 'openai', name: 'OpenAI', defaultModels: ['gpt-5', 'gpt-4o-mini'], config: { hasKey: true, models: [] } },
    { id: 'ollama', name: 'Ollama — Local (offline)', offline: true, defaultModels: ['hermes3', 'llama3.2'], config: {} }
  ]
});

test('painting shows the chosen model on the trigger and in the header', () => {
  const { api, el } = loadRenderer(readyState());
  api.paintModelPicker();
  assert.equal(el('modelProvider').textContent, 'Ollama — Local (offline)');
  assert.equal(el('modelName').textContent, 'hermes3');
  assert.equal(el('chatStatus').textContent, 'Ollama — Local (offline) · hermes3',
    'the header always says who is answering');
});

test('a stale saved choice is repaired instead of pointing at nothing', () => {
  const state = readyState();
  state.settings.activeChatModel = 'openai::gpt-3.5-turbo';
  const { api, el, saved } = loadRenderer(state);
  api.paintModelPicker();
  assert.equal(el('modelName').textContent, 'gpt-5', 'falls back to a model that exists');
  assert.deepEqual(saved, [{ activeChatModel: 'openai::gpt-5' }], 'and remembers the repair');
});

test('the popup opens grouped, filters as you type, and Enter picks', async () => {
  const { api, saved, el } = loadRenderer(readyState());
  api.bindModelPicker();
  api.openModelPop();
  assert.equal(el('modelPop').classList.contains('hidden'), false, 'opened');
  assert.equal(el('modelBtn').getAttribute('aria-expanded'), 'true');

  const list = el('modelList');
  assert.equal(list.children.length, 2, 'one group per ready provider');
  assert.equal(list.children[0].getAttribute('role'), 'group');
  assert.equal(list.children[0].getAttribute('aria-label'), 'OpenAI', 'grouped and labelled by provider');
  assert.equal(list.children[1].getAttribute('aria-label'), 'Ollama — Local (offline)');
  assert.equal(api.get().options.length, 4, 'every model of every ready provider');
  assert.equal(api.get().modelActive, 2, 'the model in use is highlighted on open');
  assert.equal(list.children[1].children[1].getAttribute('aria-selected'), 'true', 'and marked as selected');
  assert.equal(el('modelList').getAttribute('aria-activedescendant'), 'modelOpt-2', 'announced as the active option');

  const search = el('modelSearch');
  search.value = 'gpt';
  search.dispatch('input');
  assert.deepEqual(api.get().options, ['openai::gpt-5', 'openai::gpt-4o-mini'], 'typing narrows the list');
  assert.equal(api.get().modelActive, 0, 'the highlight resets to the first match — type, then Enter');
  assert.equal(el('modelEmpty').classList.contains('hidden'), true, 'there are matches, so no empty panel');

  search.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(api.get().modelActive, 1, 'the arrow moves the highlight');
  search.dispatch('keydown', { key: 'Enter' });
  await new Promise(r => setImmediate(r));
  assert.equal(api.get().modelOpen, false, 'choosing closes the popup');
  assert.equal(el('modelPop').classList.contains('hidden'), true);
  assert.deepEqual(saved, [{ activeChatModel: 'openai::gpt-4o-mini' }], 'the choice is persisted');
  assert.equal(el('modelName').textContent, 'gpt-4o-mini', 'the trigger repaints at once');
  assert.equal(el('chatStatus').textContent, 'OpenAI · gpt-4o-mini');
});

test('an empty list explains itself and offers the way out', () => {
  const { api, el, document } = loadRenderer({
    brand: { APP_NAME: 'X', APP_TAGLINE: 'x' },
    settings: { activeChatModel: null },
    providers: [{ id: 'openai', name: 'OpenAI', defaultModels: ['gpt-5'], config: { hasKey: false } }]
  });
  api.bindModelPicker();
  api.paintModelPicker();
  assert.equal(el('modelName').textContent, 'No model');
  assert.match(el('chatStatus').textContent, /No model yet/, 'the header says so too');
  api.openModelPop();
  assert.equal(api.get().options.length, 0, 'nothing is offered');
  assert.equal(el('modelEmpty').classList.contains('hidden'), false, 'the empty panel shows');
  assert.match(el('modelEmptyText').textContent, /Providers tab/, 'and points at the fix');
  el('modelSetupBtn').dispatch('click');
  assert.equal(api.get().modelOpen, false, 'the CTA closes the popup');
  assert.equal(document.querySelector('#providerCards') != null, true, 'and lands on the Providers tab');
});

test('Escape and outside clicks close the popup, inside clicks do not', () => {
  const { api, document, el } = loadRenderer(readyState());
  api.bindModelPicker();
  api.openModelPop();
  el('modelSearch').dispatch('keydown', { key: 'Escape' });
  assert.equal(api.get().modelOpen, false, 'Escape in the search field closes it');
  assert.equal(el('modelPop').classList.contains('hidden'), true);

  // The document listener the picker added.
  api.openModelPop();
  document.dispatch('click', { target: makeEl('div') });
  assert.equal(api.get().modelOpen, false, 'a click outside closes it');
  api.openModelPop();
  document.dispatch('click', { target: el('modelPicker') });
  assert.equal(api.get().modelOpen, true, 'a click inside leaves it open');
});

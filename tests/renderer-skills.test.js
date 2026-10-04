'use strict';

/**
 * Renderer tests without a browser.
 *
 * Electron can't run in CI/headless containers (no GTK), so this loads the real
 * src/renderer/app.js in a VM with a small DOM stub and drives the Skills tab and
 * the per-bot picker directly. It catches runtime errors (typos, bad property
 * access, wrong payload shapes) that a text-only check can't.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { SKILLS, PLUGINS, resolveSkillIds } = require('../src/shared/skills');

const APP_PATH = path.join(__dirname, '..', 'src', 'renderer', 'app.js');

/* ---------------- DOM stub ---------------- */

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
    checked: false,
    disabled: false,
    _listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) {
      this._html = String(v);
      if (v === '') { this.children = []; this._text = ''; }
    },
    get firstElementChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    remove() {
      const parent = this._parent;
      if (parent) parent.children = parent.children.filter(c => c !== this);
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type) { for (const fn of this._listeners[type] || []) fn({ target: this }); },
    querySelectorAll() { return []; }
  };
  el._parent = null;
  el.classList = {
    _set() { return new Set(el.className.split(/\s+/).filter(Boolean)); },
    _apply(s) { el.className = [...s].join(' '); },
    add(c) { const s = this._set(); s.add(c); this._apply(s); },
    remove(c) { const s = this._set(); s.delete(c); this._apply(s); },
    contains(c) { return this._set().has(c); },
    toggle(c) {
      const s = this._set();
      const had = s.has(c);
      if (had) s.delete(c); else s.add(c);
      this._apply(s);
      return !had;
    }
  };
  const rawAppend = el.appendChild;
  el.appendChild = (c) => { c._parent = el; rawAppend.call(el, c); return c; };
  return el;
}

function makeDocument() {
  const byId = new Map();
  const lookup = (sel) => {
    const m = /#([A-Za-z0-9_-]+)/.exec(sel);
    const id = m ? m[1] : sel;
    if (!byId.has(id)) byId.set(id, makeEl(id.startsWith('bot') ? 'button' : 'div'));
    return byId.get(id);
  };
  const document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ nodeType: 3, _text: String(t), children: [] }),
    querySelector: (sel) => lookup(sel),
    querySelectorAll: (sel) => {
      // Only the picker uses a descendant selector: "#botSkillPicker .skill-pick.on".
      if (sel.includes('.skill-pick')) {
        const out = [];
        const walk = (node) => {
          for (const c of node.children) {
            const cls = String(c.className || '');
            if (cls.includes('skill-pick') && cls.includes('on')) out.push(c);
            walk(c);
          }
        };
        walk(lookup('#botSkillPicker'));
        return out;
      }
      return [];
    },
    addEventListener() {}
  };
  document._byId = byId;
  return document;
}

/**
 * Load app.js in a VM. The trailing `boot().catch(...)` invocation is dropped so
 * the module can be driven function-by-function without a full app state.
 */
function loadRenderer() {
  const src = fs.readFileSync(APP_PATH, 'utf8');
  const bootAt = src.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');
  const stripped = src.slice(0, bootAt);

  const document = makeDocument();
  const calls = [];
  const nexus = new Proxy({}, {
    get: (_t, name) => async (arg) => {
      calls.push({ name, arg });
      // skillsState mirrors the real main-process payload.
      if (name === 'skillsState') return stateFrom({});
      return { ok: true, bot: { id: 'b-new' } };
    }
  });

  const sandbox = {
    document,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    nexus
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(stripped + `
    globalThis.__api = {
      renderSkills, renderBotSkillPicker, botModalSkillIds, setSkillEnabled, setPluginEnabled,
      loadSkills, saveSkills, SKILLS_NOTE,
      setState: (s) => { skillsState = s; },
      getState: () => skillsState,
      setQuery: (q) => { skillQuery = q; }
    };
  `, sandbox, { filename: 'app.js' });

  return { api: sandbox.__api, document, calls, el: (id) => document.querySelector('#' + id) };
}

/** A skills:state payload shaped exactly like the main process returns it. */
function stateFrom(settings) {
  const active = resolveSkillIds(settings);
  return {
    plugins: PLUGINS,
    skills: SKILLS,
    enabledPlugins: settings.enabledPlugins || [],
    enabledSkills: settings.enabledSkills || [],
    activeSkills: active
  };
}

const texts = (el) => {
  const out = [];
  const walk = (n) => {
    if (n._text) out.push(n._text);
    if (n._html) out.push(n._html);
    for (const c of n.children) walk(c);
  };
  walk(el);
  return out.join(' | ');
};

/* ---------------- tests ---------------- */

test('app.js loads and exposes the skills renderers', () => {
  const { api, el } = loadRenderer();
  assert.equal(typeof api.renderSkills, 'function');
  assert.equal(typeof api.renderBotSkillPicker, 'function');
  assert.ok(!/Failed to start/.test(el('body').textContent || ''), 'no boot-time crash');
});

test('skills tab: packs, rows and the summary render from real state', () => {
  const { api, el } = loadRenderer();
  const settings = { enabledPlugins: ['writing'], enabledSkills: [] };
  api.setState(stateFrom(settings));
  api.renderSkills();

  const grid = el('pluginGrid');
  assert.equal(grid.children.length, PLUGINS.length, 'one card per pack');
  assert.ok(texts(grid).includes(PLUGINS[0].name), 'pack name rendered');

  const list = el('skillList');
  assert.equal(list.children.length, SKILLS.length, 'one row per skill');
  assert.ok(/Active/.test(texts(list)), 'active skills tagged');

  const active = resolveSkillIds(settings);
  assert.match(el('skillsSummary').textContent, new RegExp(active.length + ' skills? active'));
  assert.equal(el('skillsNote').textContent, api.SKILLS_NOTE);
});

test('skills tab: the search box filters rows and reports no matches', () => {
  const { api, el } = loadRenderer();
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: [] }));

  api.setQuery('zzzz-no-such-skill');
  api.renderSkills();
  assert.equal(el('skillList').children.length, 1, 'a single notice row');
  assert.match(texts(el('skillList')), /No skills match/);

  const target = SKILLS[2];
  api.setQuery(target.name.slice(0, 4).toLowerCase());
  api.renderSkills();
  assert.match(texts(el('skillList')), new RegExp(target.name.slice(0, 4), 'i'));
});

test('skills tab: unavailable state degrades instead of throwing', () => {
  const { api, el } = loadRenderer();
  api.setState(null);
  api.renderSkills();
  assert.match(texts(el('skillList')), /unavailable/i);
  assert.equal(el('pluginGrid').children.length, 0);
});

test('skills tab: toggling an individual skill saves the right payload', async () => {
  const { api, calls } = loadRenderer();
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: [] }));

  await api.setSkillEnabled('concise', true);
  const patch = calls.find(c => c.name === 'setSkills');
  assert.ok(patch, 'setSkills was called');
  assert.deepEqual(patch.arg, { plugins: [], skills: ['concise'] });

  calls.length = 0;
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: ['concise'] }));
  await api.setSkillEnabled('concise', false);
  assert.deepEqual(calls.find(c => c.name === 'setSkills').arg, { plugins: [], skills: [] });
});

test('skills tab: switching one skill off inside an enabled pack keeps its siblings', async () => {
  const { api, calls } = loadRenderer();
  const pack = PLUGINS.find(p => p.skills.length > 1);
  assert.ok(pack, 'need a multi-skill pack');
  const [first, second] = pack.skills;
  api.setState(stateFrom({ enabledPlugins: [pack.id], enabledSkills: [] }));

  await api.setSkillEnabled(first, false);
  const patch = calls.find(c => c.name === 'setSkills').arg;
  assert.deepEqual(patch.plugins, [], 'the pack is dropped');
  assert.ok(patch.skills.includes(second), 'the other member stays on');
  assert.ok(!patch.skills.includes(first), 'the switched-off skill is gone');
});

test('skills tab: enabling a pack folds its members away', async () => {
  const { api, calls } = loadRenderer();
  const pack = PLUGINS[0];
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: [pack.skills[0]] }));

  await api.setPluginEnabled(pack.id, true);
  assert.deepEqual(calls.find(c => c.name === 'setSkills').arg, { plugins: [pack.id], skills: [] });

  calls.length = 0;
  api.setState(stateFrom({ enabledPlugins: [pack.id], enabledSkills: [] }));
  await api.setPluginEnabled(pack.id, false);
  assert.deepEqual(calls.find(c => c.name === 'setSkills').arg, { plugins: [], skills: [] });
});

test('bot modal: the picker reflects and returns the bot\'s own skills', () => {
  const { api, el } = loadRenderer();
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: ['concise'] }));

  const picked = [SKILLS[0].id, SKILLS[3].id];
  api.renderBotSkillPicker({ skills: picked });
  const buttons = el('botSkillPicker').children;
  assert.equal(buttons.length, SKILLS.length, 'one button per skill');
  assert.deepEqual(api.botModalSkillIds(), picked, 'ticked skills come back');

  const on = buttons.filter(b => b.classList.contains('on'));
  assert.equal(on.length, picked.length);
  for (const b of on) assert.equal(b.getAttribute('aria-pressed'), 'true');
  assert.match(texts(el('botSkillPicker')), /Always on/, 'app-wide skills are marked');
  assert.match(el('botSkillHint').textContent, /app-wide skill/);

  // Clicking toggles the tick, and the modal reads it back.
  const idx = SKILLS.findIndex(s => s.id === picked[0]);
  const btn = buttons[idx];
  assert.ok(btn.classList.contains('on'), 'the first pick is ticked');
  btn.dispatch('click');
  assert.ok(!api.botModalSkillIds().includes(picked[0]), 'unticked after the click');
  btn.dispatch('click');
  assert.ok(api.botModalSkillIds().includes(picked[0]), 'ticked again');
});

test('bot modal: no skills, and no registry, both degrade safely', () => {
  const { api, el } = loadRenderer();
  api.setState(stateFrom({ enabledPlugins: [], enabledSkills: [] }));
  api.renderBotSkillPicker({});
  assert.deepEqual(api.botModalSkillIds(), []);
  assert.match(el('botSkillHint').textContent, /Pick skills for this bot/);

  api.setState(null);
  api.renderBotSkillPicker({});
  assert.deepEqual(api.botModalSkillIds(), []);
  assert.match(texts(el('botSkillPicker')), /unavailable/i);
});

test('loadSkills: the tab paints itself from the bridge payload', async () => {
  const { api, el } = loadRenderer();
  await api.loadSkills();
  assert.ok(api.getState(), 'state set from the bridge');
  assert.equal(el('skillList').children.length, SKILLS.length);
});
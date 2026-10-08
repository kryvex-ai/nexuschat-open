'use strict';

/**
 * The redesign's new renderer logic, run for real in a VM with a DOM stub —
 * the same harness shape help-window.test.js and agent-ui.test.js use: app.js
 * sliced at boot().catch(), the functions under test exposed on __api.
 *
 * What gets pinned here:
 *   - the sidebar's age buckets and relative times (boundaries, midnight,
 *     future and broken timestamps — never "Invalid Date"),
 *   - the search filter and the two different empty sentences,
 *   - which element owns the open click (the row, not just the inner wrapper),
 *   - the focus each dialog stashes and hands back, twice-closed included,
 *   - the live region that announces completions, capped and cleared,
 *   - the hover Copy action on an assistant turn, and the bots' empty pane.
 *
 * The stub models bubbling and stopPropagation: the row-vs-.conv-open split
 * only means anything if a click can travel from the inner wrapper up to the
 * row — and be stopped by the delete button / kebab on the way.
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

const tick = () => new Promise(r => setImmediate(r));
const classes = (el) => String(el.className).split(/\s+/).filter(Boolean);

/** Depth-first search of the stub tree. */
function byClass(el, cls) {
  if (classes(el).includes(cls)) return el;
  for (const c of el.children) {
    const hit = byClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

const kidsOf = (el, cls) => el.children.filter(c => classes(c).includes(cls));

/* ---------------- the DOM stub ---------------- */

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, dataset: {}, style: {},
    className: '', _text: '', _html: '', value: '', disabled: false,
    options: [], selected: false, title: '', type: '',
    scrollTop: 0, scrollHeight: 0, focusCount: 0, _listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    // app.js empties lists with innerHTML = ''; the stub drops the children
    // and keeps the literal — it never parses markup, so a `<div id=…>` inside
    // a string stays invisible, exactly as the real parser would put it in a
    // different subtree than document.querySelector finds it.
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get firstElementChild() { return this.children[0] || null; },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this._parent) this._parent.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    focus() { this.focusCount++; if (this._doc) this._doc.activeElement = this; },
    blur() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
    contains(node) {
      for (let n = node; n; n = n._parent) if (n === el) return true;
      return false;
    },
    /** Dispatch with real bubbling: listeners run target → ancestors, and a
     *  stopPropagation() in any of them cuts the walk short. */
    dispatch(type, ev) {
      const event = Object.assign({
        type, target: el, defaultPrevented: false, _stopped: false,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() { event._stopped = true; },
        stopImmediatePropagation() { event._stopped = true; }
      }, ev || {});
      for (let n = el; n; n = n._parent) {
        for (const fn of (n._listeners[type] || []).slice()) fn(event);
        if (event._stopped) break;
      }
      return event;
    },
    querySelectorAll() { return []; },
    // Just enough for the delegated handlers: .class and #id, in this subtree.
    querySelector(sel) {
      const isId = sel.startsWith('#');
      const want = isId ? sel.slice(1) : sel.startsWith('.') ? sel.slice(1) : null;
      if (want == null) return null;
      const match = (n) => (isId ? n.id === want : classes(n).includes(want));
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
    _set: () => new Set(classes(el)),
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

function makeDocument(seedClasses) {
  const byId = new Map();
  const lookup = (sel) => {
    const m = /#([A-Za-z0-9_-]+)/.exec(sel);
    const id = m ? m[1] : sel;
    if (!byId.has(id)) {
      const el = makeEl('div');
      el.id = id;
      el.className = (seedClasses && seedClasses[id]) || '';
      el._doc = document;
      byId.set(id, el);
    }
    return byId.get(id);
  };
  const docListeners = {};
  const document = {
    body: makeEl('body'),
    createElement: (tag) => { const el = makeEl(tag); el._doc = document; return el; },
    createTextNode: (t) => { const el = makeEl('#text'); el._doc = document; el.textContent = t; return el; },
    querySelector: (sel) => lookup(sel),
    querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    /** Document-level listeners (Escape etc.) do not bubble up from elements
     *  in this stub, so they are fired directly — as a key press would. */
    dispatch(type, ev) {
      const event = Object.assign({
        type, target: null, defaultPrevented: false,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {}
      }, ev || {});
      for (const fn of (docListeners[type] || []).slice()) fn(event);
      return event;
    }
  };
  document.body._doc = document;
  document.activeElement = document.body;
  return document;
}

/** Load the real renderer with boot() dropped, exposing the new UI logic. */
function loadRenderer() {
  const bootAt = appJs.indexOf('boot().catch(');
  assert.ok(bootAt > 0, 'app.js still ends with a boot() invocation');

  const document = makeDocument({
    botModal: 'modal-backdrop hidden',
    toolModal: 'modal-backdrop hidden'
  });

  const calls = { deleted: [], answered: [], clipboard: [], opens: 0 };
  let payload = [];   // what nexus.listConversations hands back

  const nexus = new Proxy({
    listConversations: async () => { calls.opens++; return payload; },
    getConversation: async (id) => ({ id, title: 'Chat ' + id, messages: [] }),
    deleteConversation: async (id) => { calls.deleted.push(id); return { ok: true }; },
    answerTool: async (id, decision) => { calls.answered.push({ id, decision }); return { ok: true }; },
    updateSettings: async (patch) => patch,
    onChatBegin() {}, onChatDelta() {}, onChatDone() {}, onChatError() {},
    onToolAsk() {}, onToolPlan() {}, onToolResult() {}, onBotChanged() {}
  }, { get: (t, k) => (k in t ? t[k] : async () => ({ ok: true })) });

  const sandbox = {
    document, console, nexus,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    requestAnimationFrame: () => 0,
    navigator: { clipboard: { writeText: async (t) => { calls.clipboard.push(t); } } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // boot() never runs, so seed what it would have left behind — after app.js's
  // own `let state`, which would otherwise be overwritten by the assignment.
  vm.runInContext(
    appJs.slice(0, bootAt) + `
    state = { brand: { APP_NAME: 'Test', APP_TAGLINE: 'A test app' },
              settings: { theme: 'dark' }, providers: [] };
    globalThis.__api = {
      dayStart, convGroupOf, convRelTime, paintConversations, refreshConversations,
      bindConversationSearch, convRow, botRow, announceChat, setStreamingUI,
      turnActions, renderBotEmptyState, stashReturnFocus, handBackFocus,
      bindBots, openBotModal, closeBotModal, showToolAsk, answerTool,
      seedBots: (arr) => { bots = arr; },
      setConv: (id) => { currentConvId = id; },
      setBot: (id) => { currentBotId = id; },
      get: () => ({ convId: currentConvId, botId: currentBotId,
                    toolReturnTo, botReturnTo, streaming, convQuery })
    };
  `, sandbox, { filename: 'app.js' });

  return {
    api: sandbox.__api, document, calls,
    el: (id) => document.querySelector('#' + id),
    setPayload: (arr) => { payload = arr; }
  };
}

/* ---------------- markup ---------------- */

test('the completion announcer lives outside the transcript', () => {
  const messages = html.match(/<div id="messages"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(messages, '#messages is in the markup');
  assert.ok(!messages[1].includes('chatAnnouncer'), 'the live region is not inside #messages');
  assert.ok(html.includes('id="chatAnnouncer" class="sr-only" aria-live="polite" aria-atomic="true"'),
    'the announcer keeps its polite, atomic live region');
});

/* ---------------- date bucketing ---------------- */

test('age buckets split on the calendar, not on elapsed hours', () => {
  const { api } = loadRenderer();
  const iso = (ms) => new Date(ms).toISOString();
  const midnight = new Date(api.dayStart(0));
  assert.equal(midnight.getHours(), 0, 'dayStart(0) is local midnight');
  assert.equal(midnight.getMinutes(), 0);
  assert.equal(midnight.getSeconds(), 0);
  assert.equal(midnight.getMilliseconds(), 0);

  assert.equal(api.convGroupOf(iso(Date.now())), 'Today', 'a fresh stamp is Today');
  assert.equal(api.convGroupOf(iso(api.dayStart(0))), 'Today', 'midnight today still counts as Today');
  assert.equal(api.convGroupOf(iso(api.dayStart(0) - 1)), 'Yesterday',
    'one millisecond before midnight rolls to Yesterday');
  assert.equal(api.convGroupOf(iso(api.dayStart(1))), 'Yesterday', 'yesterday midnight is Yesterday');
  assert.equal(api.convGroupOf(iso(api.dayStart(7))), 'Previous 7 days',
    'exactly seven days back is still inside the window');
  assert.equal(api.convGroupOf(iso(api.dayStart(7) - 1)), 'Older',
    'a millisecond past the seven-day cutoff is Older');
  assert.equal(api.convGroupOf(iso(api.dayStart(8))), 'Older', 'eight days ago is Older');
  assert.equal(api.convGroupOf(iso(api.dayStart(30))), 'Older');
  assert.equal(api.convGroupOf(iso(Date.now() + 3600e3)), 'Today',
    'a clock ahead of us lands on Today, never on an error');
});

test('a broken or missing updatedAt falls into Older and reads as a blank', () => {
  const { api } = loadRenderer();
  for (const bad of ['not-a-date', '', undefined, null, '2026-13-45']) {
    assert.equal(api.convGroupOf(bad), 'Older', JSON.stringify(bad) + ' → Older');
    assert.equal(api.convRelTime(bad), '', JSON.stringify(bad) + ' → no time label');
  }
  assert.ok(!api.convRelTime('not-a-date').includes('Invalid'), 'never "Invalid Date"');

  const row = api.convRow({ id: 'c1', title: 'No timestamp', updatedAt: 'garbage' });
  const meta = byClass(row, 'conv-meta');
  assert.equal(meta.textContent, '', 'the row shows no time, not a raw Date string');
  assert.equal(meta.getAttribute('title'), null, 'and no tooltip built from a NaN date');
});

test('row times read like a chat app says them, across the midnight edge', () => {
  const { api } = loadRenderer();
  const now = Date.now();

  assert.equal(api.convRelTime(new Date(now).toISOString()), 'now');
  assert.equal(api.convRelTime(new Date(now + 3600e3).toISOString()), 'now',
    'the future clamps to "now" instead of going negative');

  // The minute/hour labels only apply while the stamp is still on today's
  // calendar; run within a few minutes of midnight and the same stamp is
  // yesterday's — both outcomes are asserted, so this cannot flake.
  for (const [ms, label] of [[4 * 60e3, '4m'], [2 * 3600e3, '2h']]) {
    const t = new Date(now - ms);
    const got = api.convRelTime(t.toISOString());
    if (t.getTime() >= api.dayStart(0)) assert.equal(got, label);
    else assert.equal(got, 'Yesterday', 'just past midnight the same stamp rolls over');
  }

  const yesterdayNoon = api.dayStart(1) + 12 * 3600e3;
  assert.equal(api.convRelTime(new Date(yesterdayNoon).toISOString()), 'Yesterday',
    'yesterday noon is always Yesterday, whatever the clock says');

  const withinWeek = new Date(now - 3 * 864e5);
  const weekday = api.convRelTime(withinWeek.toISOString());
  assert.match(weekday, /^[A-Za-z]{3}$/, 'inside the week the label is an abbreviated weekday');
  assert.notEqual(weekday, 'Invalid Date');
  assert.notEqual(weekday, withinWeek.toLocaleDateString(), '…and not the full date yet');

  const older = new Date(now - 20 * 864e5);
  assert.equal(api.convRelTime(older.toISOString()), older.toLocaleDateString(),
    'past the week it becomes a plain date');
});

/* ---------------- search + grouping ---------------- */

test('the sidebar groups every bucket and filters case-insensitively', async () => {
  const { api, el, setPayload } = loadRenderer();
  const now = Date.now();
  setPayload([
    { id: 'a', title: 'Design review', updatedAt: new Date(now).toISOString() },
    { id: 'b', title: 'standup notes', updatedAt: new Date(api.dayStart(1) + 12 * 3600e3).toISOString() },
    { id: 'c', title: 'Retro', updatedAt: new Date(api.dayStart(4)).toISOString() },
    { id: 'd', title: 'Old planning', updatedAt: new Date(api.dayStart(30)).toISOString() }
  ]);
  api.bindConversationSearch();
  await api.refreshConversations();

  const list = el('convList');
  const headers = kidsOf(list, 'conv-group').map(g => g.children[0].textContent);
  assert.deepEqual(headers, ['Today', 'Yesterday', 'Previous 7 days', 'Older'],
    'the four buckets, newest first, and only the ones with rows');
  const titles = kidsOf(list, 'conv-item').map(r => byClass(r, 'conv-title').textContent);
  assert.deepEqual(titles, ['Design review', 'standup notes', 'Retro', 'Old planning'],
    'each row sits under its own bucket');
  assert.equal(byClass(list, 'conv-item').getAttribute('aria-current'), null,
    'no chat is open, so none claims aria-current');

  const search = el('convSearch');
  search.value = 'REVIEW';
  search.dispatch('input');
  assert.deepEqual(kidsOf(list, 'conv-item').map(r => byClass(r, 'conv-title').textContent),
    ['Design review'], 'the query matches a title whatever its case');
  assert.deepEqual(kidsOf(list, 'conv-group').map(g => g.children[0].textContent), ['Today'],
    'the surviving row keeps its header');

  search.value = 'nothing here';
  search.dispatch('input');
  assert.equal(list.children.length, 1, 'a miss renders one node, not a blank list');
  assert.equal(list.children[0].textContent, 'No chats match "nothing here".',
    'the search wording says it is the filter speaking');

  search.value = '';
  search.dispatch('input');
  assert.equal(kidsOf(list, 'conv-item').length, 4, 'clearing the query brings everything back');
  assert.equal(kidsOf(list, 'conv-group').length, 4, 'with all four headers');
});

test('an empty sidebar says which kind of empty it is', async () => {
  const { api, el } = loadRenderer();
  api.bindConversationSearch();
  await api.refreshConversations();
  const list = el('convList');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, 'No chats yet — start one above.');

  const search = el('convSearch');
  search.value = 'x';
  search.dispatch('input');
  assert.equal(list.children[0].textContent, 'No chats match "x".',
    'with a filter up, the empty list is the filter\'s fault and says so');
});

/* ---------------- Finding 3: which element owns the open click ---------------- */

test('a click anywhere on a conversation row opens it; delete never does', async () => {
  const { api, calls } = loadRenderer();
  const row = api.convRow({ id: 'c1', title: 'Hello', updatedAt: new Date().toISOString() });
  const openEl = byClass(row, 'conv-open');
  const del = byClass(row, 'conv-del');
  assert.ok(openEl && del, 'the row has its wrapper and its delete button');
  assert.equal(openEl.getAttribute('role'), 'button', 'the wrapper keeps the a11y role');
  assert.equal(openEl.getAttribute('aria-label'), 'Open chat: Hello');
  assert.equal(row.children.includes(del), true, 'the delete button is a child of the row');
  assert.equal(openEl.contains(del), false, '…and never a descendant of the wrapper (no button in a button)');

  // The padding band: a click that lands on the row container itself.
  row.dispatch('click');
  assert.equal(api.get().convId, 'c1', 'a click on the row opens the chat');

  api.setConv(null);
  openEl.dispatch('click');
  assert.equal(api.get().convId, 'c1', 'a click on the inner wrapper still opens it');

  api.setConv(null);
  openEl.dispatch('keydown', { key: 'Enter' });
  assert.equal(api.get().convId, 'c1', 'Enter opens from the focused wrapper');
  api.setConv(null);
  openEl.dispatch('keydown', { key: ' ' });
  assert.equal(api.get().convId, 'c1', 'Space does too');

  api.setConv(null);
  del.dispatch('click');
  assert.equal(api.get().convId, null, 'the delete button does not also open the chat');
  await tick();
  assert.deepEqual(calls.deleted, ['c1'], 'it deletes instead');
  await tick();
});

test('a bot row opens from anywhere on it; the kebab keeps its own click', () => {
  const { api } = loadRenderer();
  const row = api.botRow({
    id: 'b1', name: 'Digest', task: 'Summarize the inbox', status: 'running',
    intervalSec: 3600, nextRunAt: new Date(Date.now() + 600e3).toISOString()
  });
  const openEl = byClass(row, 'conv-open');
  const kebab = byClass(row, 'bot-kebab');
  assert.ok(openEl && kebab, 'the row has its wrapper and its kebab');
  assert.equal(openEl.getAttribute('role'), 'button');
  assert.equal(openEl.getAttribute('aria-label'), 'Open bot: Digest');

  row.dispatch('click');
  assert.equal(api.get().botId, 'b1', 'a click anywhere on the row opens the bot');

  api.setBot(null);
  openEl.dispatch('keydown', { key: 'Enter' });
  assert.equal(api.get().botId, 'b1', 'Enter opens from the wrapper');

  api.setBot(null);
  kebab.dispatch('click');
  assert.equal(api.get().botId, null, 'the kebab stops the row from opening — its own menu, not the bot');
});

/* ---------------- Finding 2: focus return ---------------- */

test('a dialog hands focus back exactly once, however it closes', async () => {
  const { api, document, el } = loadRenderer();
  api.bindBots();   // the Escape handler that closes the bot editor

  const opener = document.createElement('button');
  opener.id = 'openerBtn';
  document.activeElement = opener;

  api.openBotModal(false);
  assert.equal(api.get().botReturnTo, opener, 'the opener was stashed on the way in');
  assert.equal(document.activeElement, el('botName'), 'focus moved into the dialog');

  document.dispatch('keydown', { key: 'Escape' });
  await tick();
  assert.equal(el('botModal').classList.contains('hidden'), true, 'Escape closed it');
  assert.equal(document.activeElement, opener, 'focus went back to where it came from');
  assert.equal(opener.focusCount, 1, 'handed back once');
  assert.equal(api.get().botReturnTo, null, 'the return address is spent');

  // Escape again with the dialog already closed: a no-op, not a double hand-back.
  document.dispatch('keydown', { key: 'Escape' });
  await tick();
  assert.equal(opener.focusCount, 1, 'no second hand-back');
  assert.equal(document.activeElement, opener, 'focus stays put');
  api.closeBotModal();   // closing twice directly is harmless too
  assert.equal(opener.focusCount, 1);
});

test('the permission prompt stashes the opener and restores it when answered', async () => {
  const { api, document, el, calls } = loadRenderer();
  const opener = document.createElement('button');
  opener.id = 'regenBtn';
  document.activeElement = opener;

  api.showToolAsk({ id: 'c1', name: 'write_file', risk: 'write', summary: 'Edit a.js', canRemember: true });
  assert.equal(api.get().toolReturnTo, opener, 'stashed while the prompt is up');
  assert.equal(el('toolModal').classList.contains('hidden'), false, 'and shown');
  assert.equal(document.activeElement, el('toolDenyBtn'), 'the safe action has focus');

  await api.answerTool('deny');
  assert.deepEqual(calls.answered, [{ id: 'c1', decision: 'deny' }], 'the answer went over the bridge');
  assert.equal(document.activeElement, opener, 'focus went back to what asked');
  assert.equal(opener.focusCount, 1, 'once, not twice');
  assert.equal(api.get().toolReturnTo, null, 'the return address is spent');

  // Answering when nothing is up (Escape arriving twice) must not throw.
  await api.answerTool('deny');
  assert.equal(opener.focusCount, 1, 'no prompt, no hand-back');
});

test('stashReturnFocus refuses the body and the dialog itself', () => {
  const { api, document } = loadRenderer();
  const modal = document.querySelector('#botModal');
  document.activeElement = document.body;
  assert.equal(api.stashReturnFocus(modal), null, 'the body is nowhere to return to');
  document.activeElement = modal;
  assert.equal(api.stashReturnFocus(modal), null, 'nor is the dialog that just opened');
  const real = document.createElement('button');
  document.activeElement = real;
  assert.equal(api.stashReturnFocus(modal), real, 'an actual control is worth remembering');
  real.focusCount = 0;
  api.handBackFocus(real);
  assert.equal(real.focusCount, 1, 'and is focused on the way out');
  api.handBackFocus(null);   // nothing stashed: no hand-back, no throw
});

/* ---------------- Finding 2: the live region ---------------- */

test('completions are announced outside the transcript, capped, and cleared', () => {
  const { api, el } = loadRenderer();
  const region = el('chatAnnouncer');
  const transcript = el('messages');

  api.announceChat('Done deal');
  assert.equal(region.textContent, 'Done deal');
  assert.notEqual(region, transcript, 'a repaint of #messages cannot wipe the announcement');

  api.announceChat('x'.repeat(1500));
  assert.equal(region.textContent.length, 1000, 'capped at 1000 characters');

  api.announceChat('Finished');
  api.setStreamingUI(true);
  assert.equal(region.textContent, '', 'a new stream drops the last reply, so it can be re-read');
  assert.equal(transcript.getAttribute('aria-busy'), 'true', 'the transcript says it is busy');

  api.setStreamingUI(false);
  assert.equal(transcript.getAttribute('aria-busy'), 'false');
});

/* ---------------- Finding 2: copy action + bots empty pane ---------------- */

test('an assistant turn carries a Copy action that writes the raw text', async () => {
  const { api, calls } = loadRenderer();
  const wrap = api.turnActions(['## Hello', 'Second block']);
  assert.equal(classes(wrap).includes('turn-actions'), true);
  const btn = wrap.children[0];
  assert.equal(classes(btn).includes('msg-copy'), true);
  assert.equal(btn.getAttribute('aria-label'), 'Copy message');
  assert.equal(btn.textContent, 'Copy');

  btn.dispatch('click');
  await tick();
  assert.deepEqual(calls.clipboard, ['## Hello\n\nSecond block'],
    'the markdown source, joined the way the renderer split it');
  assert.equal(btn.textContent, 'Copied', 'the confirmation lives on the button that was pressed');
});

test('the bots pane explains itself when nothing is open', () => {
  const { api, el } = loadRenderer();
  api.seedBots([]);
  api.renderBotEmptyState();
  const box = el('botMessages');
  const empty = box.children[0];
  assert.equal(classes(empty).includes('empty-state'), true);
  const title = empty.children.find(c => c.tagName === 'H1');
  assert.equal(title.textContent, 'Create your first bot', 'no bots yet: the first-run pitch');
  const create = empty.children.find(c => c.tagName === 'BUTTON');
  assert.equal(create.textContent, 'Create a bot');
  create.dispatch('click');
  assert.equal(el('botModal').classList.contains('hidden'), false, 'the button opens the editor');

  api.closeBotModal();
  api.seedBots([{ id: 'b1', name: 'Digest' }]);
  api.renderBotEmptyState();
  const second = box.children[0];
  assert.equal(second.children.find(c => c.tagName === 'H1').textContent, 'No bot selected',
    'with bots on file, an unselected pane is a selection problem');
  assert.equal(second.children.some(c => c.tagName === 'BUTTON'), false,
    'and it does not offer to create another one');
});

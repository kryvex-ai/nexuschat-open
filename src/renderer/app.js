'use strict';
/* global nexus */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let state = null;              // full app state from main (state:get)
let currentConvId = null;
let streaming = false;
let canRegenerate = false;     // current conversation has something to regenerate
let streamedText = '';
let streamBubble = null;
let providerQuery = '';
let renderToken = 0;           // guards against out-of-order chat repaints
let botQuery = '';             // bot sidebar search
let botFilter = 'all';         // bot sidebar filter chip
let skillsState = null;        // { plugins, skills, enabledPlugins, enabledSkills, activeSkills }
let skillQuery = '';           // skills tab search
let appInfo = null;            // { version, dataDir, … } for the Settings tab
let settingsSaveTimer = null;
let agentState = null;          // agent:info — tools on/off, workspace, catalogue
let toolsOn = false;            // per-chat: may the assistant use tools this turn?
let pendingTool = null;         // the permission request on screen
let toolQueue = [];            // requests that arrived while one was showing
                                 // (the main process waits on each, so none may be dropped)
let toolReturnTo = null;        // focus goes back here when the permission prompt closes
let botReturnTo = null;         // …and here when the bot editor closes
let introReturnTo = null;       // …the first-run overlays each keep their own
let bgReturnTo = null;
let updateReturnTo = null;

/** Remember who had focus before a dialog opens, so it can be handed back.
 *  Body and the dialog itself are not worth remembering: there is nowhere
 *  to return to. The guide window (openHelp) does exactly this. */
function stashReturnFocus(modal) {
  const active = document.activeElement;
  if (!active || active === document.body || active === modal) return null;
  if (typeof active.focus !== 'function') return null;
  return active;
}

function handBackFocus(stashed) {
  if (stashed && stashed.focus) stashed.focus();
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

async function boot() {
  // models.js is a second <script> (the renderer has no bundler and no
  // require): say so plainly instead of failing later on an undefined global.
  if (typeof NexusModels === 'undefined') throw new Error('models.js did not load');
  state = await nexus.getState();
  $('#brandName').textContent = state.brand.APP_NAME;
  document.title = state.brand.APP_NAME;
  const inputEl = $('#input');
  if (inputEl) inputEl.placeholder = 'Message ' + state.brand.APP_NAME + '…';
  applyTheme(state.settings.theme);
  bindTabs();
  // The guide is bound first so its Escape/F1 handler owns the keyboard
  // before any other dialog listener reacts to the same key press.
  bindHelp();
  bindComposer();
  bindModelPicker();
  bindThemeToggle();
  bindChatEvents();
  bindConversationSearch();
  bindMarkdownCopy();
  bindSettings();
  bindBots();
  bindBotToolbar();
  bindSkills();
  bindProviderSearch();
  bindAgent();
  bindSshDest();
  bindUpdates();
  nexus.onBotChanged(() => loadBots());
  await refreshConversations();
  renderMessages();
  renderProviders();
  renderSettings();
  // First-launch intro first; the background-mode prompt waits until it is
  // dismissed so the two overlays never stack. The update nudge joins that
  // chain for the same reason: one overlay at a time.
  maybeShowIntro(() => { maybeShowBackgroundPrompt(); maybePromptUpdate(); });
  await loadBots();
  await loadSkills();
  loadAgent();
  nexus.appInfo().then(info => { appInfo = info; renderSettings(); paintUpdatePill(); }).catch(() => {});
  checkForUpdates(true);
  setInterval(() => { if (document.hidden) return; if ($('#view-bots').classList.contains('active')) loadBots(true); }, 10000);
  paintModelPicker();
}

/* ================================================================== */
/* Tabs                                                               */
/* ================================================================== */

function bindTabs() {
  $$('#tabs .tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
  // The active tab is decided by markup at boot, so mark it here too —
  // aria-current is not something activateTab() gets to run for on load.
  const current = $('#tabs .tab.active');
  if (current) current.setAttribute('aria-current', 'page');
}

function activateTab(name) {
  $$('#tabs .tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'providers') renderProviders();
  if (name === 'settings') renderSettings();
  if (name === 'skills') renderSkills();
  if (name === 'bots') {
    // First entry paints at once: loadBots() is async, and an empty panel
    // must never be what the tab shows while it waits.
    if (!currentBot()) renderBotEmptyState();
    loadBots();
  }
}

/* ================================================================== */
/* Conversations                                                      */
/* ================================================================== */

let convQuery = '';             // sidebar search, as typed into #convSearch
let convCache = [];             // last conversations:list payload, newest first

/** The age buckets the sidebar groups rows under, newest first. */
const CONV_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

/** Midnight `offsetDays` back — computed on the calendar, so DST cannot skew it. */
function dayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

function convGroupOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Older';
  if (t >= dayStart(0)) return 'Today';
  if (t >= dayStart(1)) return 'Yesterday';
  if (t >= dayStart(7)) return 'Previous 7 days';
  return 'Older';
}

/** Row time: "now", "4m", "2h", "Yesterday", "Mon" — a date once it ages out. */
function convRelTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const group = convGroupOf(iso);
  if (group === 'Today') {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h';
  }
  if (group === 'Yesterday') return 'Yesterday';
  const d = new Date(t);
  if (group === 'Previous 7 days') return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString();
}

/** One sidebar row: title, relative time, and the delete button.
 *  The open action is bound on the row itself, so every pixel of it — the
 *  padding band that lights up on hover included — opens the chat. The inner
 *  wrapper stays the focusable, role="button" element, and the delete button
 *  remains its sibling, not its descendant (a button inside a button is not a
 *  control a screen reader can walk); the delete handler stops propagation so
 *  its clicks never reach the row's open action. */
function convRow(c) {
  const item = document.createElement('div');
  item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
  const openEl = document.createElement('div');
  openEl.className = 'conv-open';
  // Rows are actionable: reachable by keyboard, and announced as buttons.
  openEl.tabIndex = 0;
  openEl.setAttribute('role', 'button');
  openEl.setAttribute('aria-label', 'Open chat: ' + c.title);
  if (c.id === currentConvId) openEl.setAttribute('aria-current', 'true');
  const open = () => { currentConvId = c.id; refreshConversations(); renderMessages(); };
  item.addEventListener('click', open);
  // Focus and the Enter/Space activation stay on .conv-open, where the
  // role="button" and aria-label live.
  openEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); open(); }
  });
  const title = document.createElement('span');
  title.className = 'conv-title';
  title.textContent = c.title;
  title.title = c.title;
  const meta = document.createElement('span');
  meta.className = 'conv-meta';
  meta.textContent = convRelTime(c.updatedAt);
  // The row time is a label, not data: a missing or unparseable updatedAt
  // falls back to an empty meta, never a literal "Invalid Date".
  const updated = Date.parse(c.updatedAt);
  if (Number.isFinite(updated)) meta.title = new Date(updated).toLocaleString();
  const del = document.createElement('button');
  del.className = 'conv-del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = 'Delete chat';
  del.setAttribute('aria-label', 'Delete chat: ' + c.title);
  del.addEventListener('click', async e => {
    e.stopPropagation();
    await nexus.deleteConversation(c.id);
    if (currentConvId === c.id) { currentConvId = null; renderMessages(); }
    refreshConversations();
  });
  openEl.appendChild(title);
  openEl.appendChild(meta);
  item.appendChild(openEl);
  item.appendChild(del);
  return item;
}

/** Paint the cached conversations: search first, then the age groups.
 *  Rows are DOM nodes throughout — a title is model output, never markup. */
function paintConversations() {
  const list = $('#convList');
  if (!list) return;
  list.innerHTML = '';
  const q = convQuery.trim().toLowerCase();
  const rows = [...convCache]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter(c => !q || String(c.title || '').toLowerCase().includes(q));
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    // Two distinct situations: nothing to show at all, and nothing matching
    // the filter. The second keeps its search wording.
    empty.textContent = q
      ? 'No chats match "' + convQuery.trim() + '".'
      : 'No chats yet — start one above.';
    list.appendChild(empty);
    return;
  }
  for (const label of CONV_GROUPS) {
    const group = rows.filter(c => convGroupOf(c.updatedAt) === label);
    if (!group.length) continue;
    const head = document.createElement('div');
    head.className = 'conv-group';
    const name = document.createElement('span');
    name.className = 'conv-group-label';
    name.textContent = label;
    head.appendChild(name);
    list.appendChild(head);
    for (const c of group) list.appendChild(convRow(c));
  }
}

async function refreshConversations() {
  const convos = await nexus.listConversations();
  convCache = Array.isArray(convos) ? convos : [];
  paintConversations();
}

function bindConversationSearch() {
  const box = $('#convSearch');
  if (!box) return;
  box.addEventListener('input', () => {
    convQuery = box.value || '';
    paintConversations();
  });
}

async function newChat() {
  // A stream in flight belongs to the old conversation: stop it first so its
  // late done/error events can't repaint the fresh chat mid-creation.
  if (streaming) nexus.stop();
  const c = await nexus.createConversation('New chat');
  currentConvId = c.id;
  await refreshConversations();
  renderMessages();
  $('#input').focus();
}

/* ================================================================== */
/* Models — a searchable, grouped picker above the composer            */
/*                                                                     */
/* Which providers are offered, how the list narrows and which         */
/* "providerId::model" survives a provider disappearing all live in     */
/* models.js (NexusModels); this half is the DOM.                      */
/* ================================================================== */

let modelGroupsCache = [];   // every model the picker offers, rebuilt on paint
let modelOptions = [];       // the option nodes on screen, in order
let modelOpen = false;       // the popup is showing
let modelActive = -1;        // highlighted option within modelOptions

/** Paint the trigger, the chat-header status line and (if open) the list. */
function paintModelPicker() {
  modelGroupsCache = NexusModels.modelGroups(state.providers);
  const value = NexusModels.resolveSelection(modelGroupsCache, state.settings.activeChatModel);
  const sel = NexusModels.splitSelection(value);
  if (value && value !== state.settings.activeChatModel) {
    // The saved choice went stale — key cleared, provider removed. Keep the
    // setting and the screen saying the same thing.
    state.settings.activeChatModel = value;
    nexus.updateSettings({ activeChatModel: value });
  }
  const group = modelGroupsCache.find(g => g.id === sel.providerId);
  $('#modelProvider').textContent = group ? group.label : '';
  $('#modelName').textContent = sel.model || 'No model';
  // The header repeats the choice, so it stays visible with the popup closed
  // and the composer full of text.
  $('#chatStatus').textContent = sel.model
    ? (group ? group.label : sel.providerId) + ' · ' + sel.model
    : 'No model yet — open the picker to set one up';
  if (modelOpen) renderModelList();
}

/** Rebuild the popup's option list from the search field. */
function renderModelList() {
  const list = $('#modelList');
  const query = $('#modelSearch').value;
  const groups = NexusModels.filterGroups(modelGroupsCache, query);
  list.textContent = '';
  modelOptions = [];
  for (const g of groups) {
    const box = document.createElement('div');
    box.className = 'model-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', g.label);
    const head = document.createElement('div');
    head.className = 'model-group-label';
    head.setAttribute('aria-hidden', 'true');
    head.textContent = g.label;
    box.appendChild(head);
    for (const m of g.models) {
      const value = g.id + '::' + m;
      const opt = document.createElement('div');
      opt.className = 'model-opt';
      opt.setAttribute('role', 'option');
      opt.id = 'modelOpt-' + modelOptions.length;
      opt.setAttribute('aria-selected', String(value === state.settings.activeChatModel));
      opt.dataset.value = value;
      const name = document.createElement('span');
      name.className = 'model-opt-name';
      name.textContent = m;
      opt.appendChild(name);
      opt.addEventListener('click', () => chooseModel(value));
      box.appendChild(opt);
      modelOptions.push(opt);
    }
    list.appendChild(box);
  }
  const none = modelOptions.length === 0;
  $('#modelEmpty').classList.toggle('hidden', !none);
  $('#modelEmptyText').textContent = modelGroupsCache.length
    ? 'No model matches “' + query + '”.'
    : 'No models yet — add a key in the Providers tab.';
  setActiveModelOption(Math.min(modelActive, modelOptions.length - 1));
}

/** Move the highlight (and aria-activedescendant) to option i.
 *  The attribute goes on the combobox that owns the list — that is the node
 *  a screen reader tracks — and stays on the listbox too, which is the shape
 *  the wiring test reads. */
function setActiveModelOption(i) {
  modelActive = i;
  modelOptions.forEach((o, n) => o.classList.toggle('on', n === i));
  const on = modelOptions[i];
  const list = $('#modelList');
  const search = $('#modelSearch');
  const active = on ? on.id : null;
  if (list && list.setAttribute) {
    if (active) list.setAttribute('aria-activedescendant', active);
    else if (list.removeAttribute) list.removeAttribute('aria-activedescendant');
  }
  if (search && search.setAttribute) {
    if (active) search.setAttribute('aria-activedescendant', active);
    else if (search.removeAttribute) search.removeAttribute('aria-activedescendant');
  }
  if (on) {
    // Scroll after the class swap: the highlight must be visible at once.
    if (on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
}

function openModelPop() {
  if (modelOpen) return;
  // Rebuild first: a provider may have been saved, imported or cleared since
  // the last paint, and the popup must never offer yesterday's list.
  paintModelPicker();
  modelOpen = true;
  $('#modelPop').classList.remove('hidden');
  $('#modelBtn').setAttribute('aria-expanded', 'true');
  const searchBox = $('#modelSearch');
  if (searchBox) searchBox.setAttribute('aria-expanded', 'true');
  $('#modelSearch').value = '';
  modelActive = -1;
  renderModelList();
  // Land on the model in use, so Enter keeps what you already had.
  const at = modelOptions.findIndex(o => o.getAttribute('aria-selected') === 'true');
  setActiveModelOption(at >= 0 ? at : 0);
  $('#modelSearch').focus();
}

function closeModelPop(restoreFocus) {
  if (!modelOpen) return;
  modelOpen = false;
  $('#modelPop').classList.add('hidden');
  $('#modelBtn').setAttribute('aria-expanded', 'false');
  const searchBox = $('#modelSearch');
  if (searchBox) searchBox.setAttribute('aria-expanded', 'false');
  if (restoreFocus !== false) $('#modelBtn').focus();
}

/** Pick a model: paint at once, then persist — the UI never waits on IPC. */
async function chooseModel(value) {
  if (!value) return;
  state.settings.activeChatModel = value;
  closeModelPop();
  paintModelPicker();
  await nexus.updateSettings({ activeChatModel: value });
}

function bindModelPicker() {
  const btn = $('#modelBtn');
  const search = $('#modelSearch');
  btn.addEventListener('click', () => (modelOpen ? closeModelPop() : openModelPop()));
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openModelPop(); }
    else if (e.key === 'Escape' && modelOpen) { e.preventDefault(); closeModelPop(); }
  });
  // Filtering resets the highlight to the first match: type, then Enter.
  search.addEventListener('input', () => {
    modelActive = -1;
    renderModelList();
    setActiveModelOption(modelOptions.length ? 0 : -1);
  });
  search.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActiveModelOption(Math.min(modelActive + 1, modelOptions.length - 1)); break;
      case 'ArrowUp': e.preventDefault(); setActiveModelOption(modelActive <= 0 ? 0 : modelActive - 1); break;
      case 'Home': e.preventDefault(); setActiveModelOption(0); break;
      case 'End': e.preventDefault(); setActiveModelOption(modelOptions.length - 1); break;
      case 'Enter': {
        e.preventDefault();
        const opt = modelOptions[modelActive] || modelOptions[0];
        if (opt) chooseModel(opt.dataset.value);
        break;
      }
      case 'Escape': e.preventDefault(); closeModelPop(); break;
      case 'Tab': closeModelPop(false); break;
      default: return;
    }
  });
  $('#modelSetupBtn').addEventListener('click', () => { closeModelPop(false); activateTab('providers'); });
  // Clicking anywhere else closes it, like every other menu in the app.
  document.addEventListener('click', e => {
    if (!modelOpen) return;
    const root = $('#modelPicker');
    if (root && root.contains && !root.contains(e.target)) closeModelPop(false);
  });
}

function currentSelection() {
  return NexusModels.splitSelection(state.settings.activeChatModel);
}

/* ================================================================== */
/* Composer + streaming chat                                          */
/* ================================================================== */

function bindComposer() {
  const input = $('#input');
  // Ctrl/Cmd+N: new chat from anywhere in the app.
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newChat();
    }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });
  $('#sendBtn').addEventListener('click', () => sendMessage());
  $('#stopBtn').addEventListener('click', () => nexus.stop());
  $('#regenBtn').addEventListener('click', regenerate);
  $('#newChatBtn').addEventListener('click', newChat);
  $('#refreshModelsBtn').addEventListener('click', async () => {
    const { providerId } = currentSelection();
    if (providerId) {
      const r = await nexus.fetchModels(providerId);
      toast(r.ok ? providerId + ': ' + r.fetched.length + ' model(s) fetched.' : 'Fetch failed: ' + r.error, r.ok ? 'ok' : 'error');
      state = await nexus.getState();
      invalidateProviderStatus(providerId);
    }
    paintModelPicker();
  });
}

function setStreamingUI(on) {
  streaming = on;
  $('#sendBtn').classList.toggle('hidden', on);
  $('#stopBtn').classList.toggle('hidden', !on);
  $('#input').disabled = on;
  // The model can't change mid-stream — a swap would apply to the next message
  // while the running one still streams under the old selection.
  const btn = $('#modelBtn');
  if (btn) btn.disabled = on;
  if (on) closeModelPop(false);
  const pane = $('#messages');
  if (pane && pane.setAttribute) pane.setAttribute('aria-busy', on ? 'true' : 'false');
  // A live region announces on *change*, so drop the last reply now: a new
  // one landing with identical text must still be read out.
  if (on) announceChat('');
  updateRegenBtn();
  if (!on) {
    // Send handed the composer back — refocus it unless the user has moved
    // on to something else while the reply was coming.
    const ae = document.activeElement;
    if (!ae || ae === document.body) {
      const inp = $('#input');
      if (inp && inp.focus) inp.focus();
    }
  }
}

/** The transcript is rebuilt from scratch on every paint, which would have a
 *  live region inside it read the whole conversation back each time — so
 *  completions are announced from this node sitting outside the transcript. */
function announceChat(text) {
  const el = $('#chatAnnouncer');
  if (!el) return;
  const value = text == null ? '' : String(text);
  el.textContent = value.length > 1000 ? value.slice(0, 1000) : value;
}

/* Regenerate only makes sense once the conversation has at least one user
 * message — hide it on a fresh/empty chat instead of showing a dead button. */
function updateRegenBtn() {
  $('#regenBtn').classList.toggle('hidden', streaming || !canRegenerate);
}

function appendMsg(role, text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || role);
  div.textContent = text;
  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return div;
}

function ensureStreamBubble() {
  // chat:send returns as soon as generation starts, so sendMessage repaints
  // the pane (renderMessages → innerHTML = '') while the reply is still
  // streaming — and that repaint detaches this node. Reattach it, or every
  // later delta paints off-screen and the reply only appears when it ends.
  if (streamBubble && !streamBubble.isConnected) {
    $('#messages').appendChild(streamBubble);
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  if (!streamBubble) {
    streamBubble = appendMsg('assistant', '');
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    streamBubble.appendChild(cursor);
  }
  return streamBubble;
}

function clearStreamBubble() {
  if (streamBubble) { streamBubble.remove(); streamBubble = null; }
}

/* ---------------- markdown ---------------- */

/**
 * Paint one message through markdown.js when it is loaded (a plain <script>
 * another agent may add before app.js), otherwise fall back to the raw text.
 * Either way the message's textContent is the reply itself: a paragraph with
 * no markup yields exactly the source string, no separators or labels.
 */
function renderMarkdownBlocks(el, text) {
  const raw = text == null ? '' : String(text);
  if (typeof NexusMarkdown !== 'undefined' && NexusMarkdown
      && typeof NexusMarkdown.render === 'function') {
    const frag = NexusMarkdown.render(raw, document);
    if (frag && typeof frag.appendChild === 'function' && frag.childNodes) {
      el.textContent = '';
      el.appendChild(frag);
      return;
    }
  }
  el.textContent = raw;
}

/** Clipboard write for every copy affordance. Only ever runs on a click, so a
 *  VM test that renders without a clipboard never reaches `navigator`. */
async function copyTextToClipboard(text) {
  const value = text == null ? '' : String(text);
  if (!value) return false;
  if (typeof navigator === 'undefined' || !navigator.clipboard
      || typeof navigator.clipboard.writeText !== 'function') return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (e) {
    return false;
  }
}

/** Copy, then say so on the button for a moment — the confirmation has to
 *  live on the control that was pressed, not a toast across the screen. */
async function copyAndConfirm(btn, text) {
  const ok = await copyTextToClipboard(text);
  if (!ok || !btn) return;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
}

/** One delegated listener per transcript pane: repaints replace the rows,
 *  never the pane, so the listener survives every renderMessages(). */
function bindMarkdownCopy() {
  for (const sel of ['#messages', '#botMessages']) {
    const pane = $(sel);
    if (!pane) continue;
    pane.addEventListener('click', e => {
      const target = e && e.target;
      const btn = target && typeof target.closest === 'function'
        ? target.closest('.md-copy')
        : null;
      if (!btn) return;
      const pre = btn.parentElement;
      const code = pre && typeof pre.querySelector === 'function'
        ? pre.querySelector('code')
        : null;
      copyAndConfirm(btn, code ? code.textContent : '');
    });
  }
}

/** The hover action on an assistant turn: copies the turn's raw text (the
 *  markdown source, not the rendered nodes) and lives outside .msg, so the
 *  message textContent assertions stay clean. */
function turnActions(raw) {
  const wrap = document.createElement('div');
  wrap.className = 'turn-actions';
  const btn = document.createElement('button');
  btn.className = 'msg-copy';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.setAttribute('aria-label', 'Copy message');
  btn.addEventListener('click', () => copyAndConfirm(btn, raw.join('\n\n')));
  wrap.appendChild(btn);
  return wrap;
}

async function renderMessages() {
  const box = $('#messages');
  // Clicking conversations quickly starts overlapping loads; the slower one
  // must not repaint the pane over the newer selection. The token makes every
  // render but the newest a no-op.
  const token = ++renderToken;
  box.innerHTML = '';
  const conv = currentConvId ? await nexus.getConversation(currentConvId) : null;
  if (token !== renderToken) return; // superseded — the newest render owns the pane
  // Tools follow the conversation: a chat that had them on keeps them, and
  // another chat does not silently inherit the switch.
  toolsOn = conv && typeof conv.tools === 'boolean'
    ? conv.tools
    : !!(agentState && agentState.enabled && (agentState.workspaceOk || (conv && conv.sshHostId)));
  updateToolsToggle(conv);
  renderSshDest(conv);
  // The header names the open chat, and says nothing when none is open.
  const heading = $('#chatTitle');
  if (heading) heading.textContent = (conv && conv.title) ? conv.title : '';
  if (!conv || !conv.messages.length) {
    canRegenerate = false;
    updateRegenBtn();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<span class="logo"></span><div id="emptyTitle"></div><div id="emptySub"></div><div class="chips" id="chips"></div>';
    box.appendChild(empty);
    $('#emptyTitle').textContent = state.brand.APP_NAME;
    $('#emptySub').textContent = state.brand.APP_TAGLINE;
    // Starter chips (Hermes-style): click to send immediately.
    const chips = $('#chips');
    const starters = ['Explain quantum computing simply', 'Write a Python script to rename files', 'Brainstorm names for my startup'];
    for (const s of starters) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', () => sendMessage(s));
      chips.appendChild(b);
    }
    return;
  }
  canRegenerate = conv.messages.some(m => m.role === 'user');
  updateRegenBtn();
  renderTurnMessages(box, conv.messages);
}

async function sendMessage(presetText) {
  if (streaming) return;
  const text = (presetText ?? $('#input').value).trim();
  if (!text) return;

  const { providerId, model } = currentSelection();
  if (!providerId) {
    // Nothing to talk to yet — send them where they can fix that.
    toast('No model selected — add a key in the Providers tab.', 'warn');
    activateTab('providers');
    return;
  }

  $('#input').value = '';
  $('#input').style.height = 'auto';
  setStreamingUI(true);
  streamedText = '';

  let res;
  try {
    res = await nexus.send({ conversationId: currentConvId, text, providerId, model, tools: toolsOn });
  } catch (e) {
    // IPC/serialization failure: never leave the composer stuck in streaming.
    setStreamingUI(false);
    clearStreamBubble();
    toast('Send failed: ' + ((e && e.message) || e), 'error');
    return;
  }
  if (!res.ok) {
    setStreamingUI(false);
    clearStreamBubble();
    toast(res.error, 'error');
    if (res.needProviders) activateTab('providers');
    return;
  }
  canRegenerate = true;
  currentConvId = res.conversationId;
  await refreshConversations();
  renderMessages();
  // Signature moment: one faint volt streak behind the message that just flew in.
  const sent = [...document.querySelectorAll('#messages .msg.user')].pop();
  if (sent) sent.classList.add('streak');
}

function onChatBegin(payload) {
  streamedText = '';
  // A new conversation's id only lands after the send promise resolves —
  // begin may arrive before it, so paint only when this chat is on screen.
  if (!currentConvId || payload.conversationId === currentConvId) ensureStreamBubble();
}

function onChatDelta(payload) {
  streamedText += payload.delta;
  // Deltas always accumulate, but never paint into a different chat the
  // user switched to mid-stream.
  if (currentConvId && payload.conversationId !== currentConvId) return;
  const bubble = ensureStreamBubble();
  bubble.textContent = streamedText;
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  bubble.appendChild(cursor);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function onChatDone(payload) {
  setStreamingUI(false);
  streamBubble = null;
  if (payload.message) {
    // The same "never speak for another chat" rule onChatDelta paints by.
    if (!currentConvId || payload.conversationId === currentConvId) {
      const content = typeof payload.message === 'string'
        ? payload.message
        : payload.message.content;
      announceChat(content);
    }
    await refreshConversations();
  }
  renderMessages();
}

function onChatError(payload) {
  setStreamingUI(false);
  clearStreamBubble();
  if (!currentConvId || payload.conversationId === currentConvId) {
    appendMsg('assistant', '! ' + payload.message, 'error');
    announceChat(payload.message);
  }
}

function bindChatEvents() {
  nexus.onChatBegin(onChatBegin);
  nexus.onChatDelta(onChatDelta);
  nexus.onChatDone(onChatDone);
  nexus.onChatError(onChatError);
}

async function regenerate() {
  if (streaming || !currentConvId) return;
  const { providerId, model } = currentSelection();
  if (!providerId) { toast('No model selected — add a key in the Providers tab.', 'warn'); activateTab('providers'); return; }
  setStreamingUI(true);
  streamedText = '';
  let res;
  try {
    res = await nexus.send({ conversationId: currentConvId, regenerate: true, providerId, model });
  } catch (e) {
    setStreamingUI(false);
    toast('Regenerate failed: ' + ((e && e.message) || e), 'error');
    return;
  }
  if (!res.ok) {
    setStreamingUI(false);
    toast(res.error, 'error');
    return;
  }
  renderMessages();
}

/* ================================================================== */
/* Providers tab (offline / free)                                     */
/* ================================================================== */

function providerUsable(p) {
  return NexusModels.isUsable(p);
}

function bindProviderSearch() {
  const el = $('#providerSearch');
  if (!el) return;
  el.addEventListener('input', () => { providerQuery = el.value.trim().toLowerCase(); renderProviders(); });
}

/* Provider connection checks are cached: opening the tab (or any re-render)
 * must not fire a burst of concurrent requests at the providers every time —
 * that trips rate limits and hangs the dots when one host is slow. */
const providerStatusCache = new Map();    // id -> { at, ok, detail }
const providerStatusInflight = new Map(); // id -> promise
const PROVIDER_STATUS_TTL_MS = 60000;

function invalidateProviderStatus(id) {
  if (id) { providerStatusCache.delete(id); providerStatusInflight.delete(id); }
  else { providerStatusCache.clear(); providerStatusInflight.clear(); }
}

async function cachedProviderStatus(p) {
  const hit = providerStatusCache.get(p.id);
  if (hit && Date.now() - hit.at < PROVIDER_STATUS_TTL_MS) return hit;
  if (providerStatusInflight.has(p.id)) return providerStatusInflight.get(p.id);
  const run = (async () => {
    try {
      const st = await nexus.testProvider(p.id);
      const out = { at: Date.now(), ok: !!st.ok, detail: st.detail || st.error || (st.ok ? 'ready' : 'check failed') };
      providerStatusCache.set(p.id, out);
      return out;
    } catch (e) {
      return { at: 0, ok: false, detail: 'check failed: ' + e.message }; // never cached
    } finally {
      providerStatusInflight.delete(p.id);
    }
  })();
  providerStatusInflight.set(p.id, run);
  return run;
}

async function renderProviderStatus(p, el, dot) {
  const set = (ok, text, cls) => {
    el.textContent = text;
    el.className = 'statusline ' + cls;
    if (dot) dot.className = 'pdot ' + cls;
  };
  if (providerUsable(p)) {
    const hit = providerStatusCache.get(p.id);
    if (hit && Date.now() - hit.at < PROVIDER_STATUS_TTL_MS) {
      set(hit.ok, '● ' + hit.detail, hit.ok ? 'ok' : 'err');
      return;
    }
    set(true, '● checking…', '');
    // The card may have re-rendered while the check was in flight — only
    // paint if this element is still in the document.
    const st = await cachedProviderStatus(p);
    if (!el.isConnected) return;
    set(st.ok, '● ' + st.detail, st.ok ? 'ok' : 'err');
  } else if (p.offline) {
    set(false, '● not detected — install & start it, or set the URL below', '');
  } else {
    set(false, p.requiresBaseUrl ? '● set the base URL below' : '● add your API key below', '');
  }
}

function renderProviders() {
  const wrap = $('#providerCards');
  if (!wrap) return;
  wrap.textContent = '';
  const grid = document.createElement('div');
  grid.className = 'provider-grid';
  wrap.appendChild(grid);

  const list = state.providers.filter(p => {
    if (!providerQuery) return true;
    return (p.name + ' ' + p.id + ' ' + (p.notes || '')).toLowerCase().includes(providerQuery);
  });
  const usable = state.providers.filter(providerUsable).length;
  const sum = $('#providerSummary');
  if (sum) sum.textContent = `${usable}/${state.providers.length} providers ready — keys stay on this PC${providerQuery ? ` · filter “${providerQuery}”` : ''}.`;
  if (!list.length) {
    const none = document.createElement('div');
    none.className = 'empty-panel';
    none.textContent = 'No providers match your search.';
    wrap.appendChild(none);
    return;
  }

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'pcard';

    const head = document.createElement('div');
    head.className = 'pcard-head';
    const dot = document.createElement('span');
    dot.className = 'pdot';
    const name = document.createElement('span');
    name.className = 'pcard-name';
    name.textContent = p.name;
    const kind = document.createElement('span');
    kind.className = 'pcard-kind';
    kind.textContent = p.offline ? 'Local & free' : (p.requiresBaseUrl ? 'Self-hosted' : 'API key');
    if (p.offline) kind.className = 'pcard-kind local';
    head.appendChild(dot);
    head.appendChild(name);
    head.appendChild(kind);
    card.appendChild(head);

    const notes = document.createElement('p');
    notes.textContent = p.notes || '';
    card.appendChild(notes);

    const status = document.createElement('div');
    status.className = 'statusline';
    card.appendChild(status);
    renderProviderStatus(p, status, dot);

    if (!p.offline || p.requiresBaseUrl || p.id === 'ollama') {
      if (!p.offline) {
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.placeholder = p.config.hasKey ? 'API key saved — type to replace' : 'API key';
        keyInput.style.marginTop = '8px';
        card.appendChild(keyInput);
        card._keyInput = keyInput;
      }
      if (p.requiresBaseUrl || p.offline) {
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.placeholder = 'Base URL (default: ' + (p.base || 'none') + ')';
        urlInput.value = (p.config.baseUrl || '');
        urlInput.style.marginTop = '8px';
        card.appendChild(urlInput);
        card._urlInput = urlInput;
      }
    }

    const foot = document.createElement('div');
    foot.className = 'pcard-foot';
    if (card._keyInput || card._urlInput) {
      const save = document.createElement('button');
      save.className = 'primary';
      save.textContent = 'Save & connect';
      // One click has to end in a working model: store the key or URL, read the
      // provider's own model list, and switch the composer over to it.
      save.addEventListener('click', async () => {
        if (save.disabled) return;
        const cfg = {};
        if (card._keyInput && card._keyInput.value.trim()) cfg.apiKey = card._keyInput.value.trim();
        if (card._urlInput) cfg.baseUrl = card._urlInput.value.trim();
        if (card._keyInput && !cfg.apiKey && !p.config.hasKey) {
          toast('Paste your ' + p.name + ' API key first.', 'warn');
          card._keyInput.focus();
          return;
        }
        if (card._urlInput && !cfg.baseUrl && p.requiresBaseUrl && !p.config.baseUrl) {
          toast('Set the base URL first.', 'warn');
          card._urlInput.focus();
          return;
        }
        save.disabled = true;
        save.textContent = 'Connecting…';
        try {
          if (Object.keys(cfg).length) {
            const r = await nexus.saveProvider(p.id, cfg);
            if (!r.ok) { toast('Save failed: ' + r.error, 'error'); return; }
          }
          state = await nexus.getState();
          invalidateProviderStatus(p.id); // fresh check for the new key/URL
          let fetchError = null;
          try {
            const fr = await nexus.fetchModels(p.id);
            if (!fr.ok) fetchError = fr.error;
          } catch (e) {
            fetchError = (e && e.message) || 'no answer';
          }
          state = await nexus.getState();
          const value = NexusModels.firstModelOf(NexusModels.modelGroups(state.providers), p.id);
          if (value) await chooseModel(value);
          else paintModelPicker();
          renderProviders();
          if (fetchError) {
            toast('Saved — but ' + p.name + ' did not list any models (' + fetchError + ').', 'warn');
          } else {
            const using = value ? 'using ' + NexusModels.splitSelection(value).model + '.' : 'pick a model above.';
            toast(p.name + ' connected — ' + using, 'ok');
          }
        } finally {
          save.disabled = false;
          save.textContent = 'Save & connect';
        }
      });
      foot.appendChild(save);
    }
    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'ghost';
    fetchBtn.textContent = 'Fetch models';
    fetchBtn.addEventListener('click', async () => {
      const r = await nexus.fetchModels(p.id);
      toast(r.ok ? p.name + ': ' + r.fetched.length + ' model(s).' : 'Fetch failed: ' + r.error, r.ok ? 'ok' : 'error');
      state = await nexus.getState();
      invalidateProviderStatus(p.id);
      renderProviders();
      paintModelPicker();
    });
    foot.appendChild(fetchBtn);
    if (p.config.hasKey) {
      const clear = document.createElement('button');
      clear.className = 'ghost';
      clear.textContent = 'Clear key';
      clear.addEventListener('click', async () => {
        await nexus.saveProvider(p.id, { apiKey: '' });
        toast(p.name + ' key cleared.', 'ok');
        state = await nexus.getState();
        invalidateProviderStatus(p.id);
        renderProviders();
        paintModelPicker();
      });
      foot.appendChild(clear);
    }
    card.appendChild(foot);
    grid.appendChild(card);
  }
}

/* ================================================================== */
/* Settings tab                                                       */
/* ================================================================== */

function renderSettings() {
  $('#systemPrompt').value = state.settings.systemPrompt || '';
  $('#tempSlider').value = state.settings.temperature ?? 0.7;
  $('#tempVal').textContent = String(state.settings.temperature ?? 0.7);
  $('#maxTokens').value = state.settings.maxTokens || '';
  $('#themeSelect').value = state.settings.theme || 'dark';
  syncThemeToggle();
  $('#aboutLine').textContent = state.brand.APP_NAME + ' v' + state.version + ' — free and open source, running entirely on this PC.';
  const dp = $('#dataPathLine');
  if (dp) dp.textContent = appInfo && appInfo.dataDir ? 'Data folder: ' + appInfo.dataDir : '';
  const rs = $('#resetStatus');
  if (rs) rs.textContent = '';
  const bgPill = $('#bgPill');
  if (bgPill) {
    const on = state.settings.runInBackground === true;
    bgPill.textContent = on ? 'On' : 'Off';
    bgPill.className = 'badge ' + (on ? 'ok' : '');
  }
  renderBackgroundSetting();
  renderSsh();
}

/**
 * Persist a settings patch and confirm it. Every control on this tab saves
 * instantly — which used to happen with no feedback at all.
 */
async function saveSetting(patch) {
  try {
    state.settings = await nexus.updateSettings(patch);
    // state.settings is replaced wholesale, so the header chip repaints too —
    // a stale model name must never survive a settings write.
    paintModelPicker();
    flashSaved($('#settingsSaved'));
    return true;
  } catch (e) {
    toast('Could not save settings: ' + ((e && e.message) || e), 'error');
    return false;
  }
}

function bindSettings() {
  $('#systemPrompt').addEventListener('change', e => saveSetting({ systemPrompt: e.target.value }));
  $('#tempSlider').addEventListener('input', e => { $('#tempVal').textContent = e.target.value; });
  $('#tempSlider').addEventListener('change', e => saveSetting({ temperature: Number(e.target.value) }));
  $('#maxTokens').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    saveSetting({ maxTokens: Number.isFinite(v) && v > 0 ? v : null });
  });
  $('#themeSelect').addEventListener('change', async e => {
    await saveSetting({ theme: e.target.value });
    applyTheme(e.target.value);
    syncThemeToggle();
  });
  const resetBtn = $('#resetSettingsBtn');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (!confirm('Restore the default settings? Theme, temperature, system prompt and skills go back to how the app shipped. Your API keys and chats are kept.')) return;
    if (resetBtn.disabled) return;
    resetBtn.disabled = true;
    try {
      const r = await nexus.resetSettings();
      if (!r || !r.ok) throw new Error((r && r.error) || 'reset failed');
      state.settings = r.settings;
      state = await nexus.getState();
      applyTheme(state.settings.theme);
      await loadSkills();
      invalidateProviderStatus();
      renderSettings();
      paintModelPicker();
      renderMessages();
      const rs = $('#resetStatus');
      if (rs) rs.textContent = 'Defaults restored.';
      toast('Settings restored to defaults — your API keys and chats were kept.', 'ok');
    } catch (e) {
      toast('Could not restore defaults: ' + ((e && e.message) || e), 'error');
    } finally {
      resetBtn.disabled = false;
    }
  });
  $('#openDataBtn').addEventListener('click', () => nexus.openDataFolder());
  $('#bgOnBtn').addEventListener('click', () => setBackgroundMode(true, false));
  $('#bgOffBtn').addEventListener('click', () => setBackgroundMode(false, false));
  $('#exportBtn').addEventListener('click', async () => {
    const r = await nexus.exportData();
    if (r.ok) toast('Exported to ' + r.filePath, 'ok');
    else if (!r.canceled) toast('Export failed.', 'error');
  });
  $('#importBtn').addEventListener('click', async () => {
    const r = await nexus.importData();
    if (r.ok) {
      state = await nexus.getState();
      invalidateProviderStatus(); // everything may have changed
      await refreshConversations();
      renderMessages();
      renderProviders();
      paintModelPicker(); // imported keys may have changed what is on the list
      toast('Import complete.', 'ok');
    } else if (!r.canceled) {
      toast('Import failed: ' + (r.error || 'unknown'), 'error');
    }
  });
  // The section links are anchors, not tabs: every panel is on the page and
  // the link scrolls to one. Mark the section you jumped to, so the current
  // one is announced rather than only scrolled to.
  const sections = $$('.settings-nav a');
  if (sections.length) {
    const markSection = (link) => sections.forEach(a => {
      if (a === link) a.setAttribute('aria-current', 'true');
      else if (a.removeAttribute) a.removeAttribute('aria-current');
    });
    sections.forEach(a => a.addEventListener('click', () => markSection(a)));
    markSection(sections[0]);
  }
  bindSsh();
}

/* ================================================================== */
/* SSH: saved hosts, the runner, the file browser and the self-test   */
/* ================================================================== */

/* Hosts live in settings (saved through the normal whitelist) and are
 * addressed by id everywhere — the renderer never hands the main process
 * a host string, only a row the user picked. Every path and command is
 * validated again on the other side of the bridge. */

let sshSelectedId = null;   // id of the chosen host row
let sshEditing = false;     // the form edits that host instead of starting a new one
let sshListedDir = '';      // last directory the browser resolved
let sshSelectedFile = null; // { name, path } of the highlighted row
let sshFileCache = [];      // last listing, for the filter box
let sshStatusById = {};     // id -> { score, ok, ms, at } from the last self-test
let sshHistoryById = {};    // id -> [command, …] newest last, capped
let sshHistoryIdx = -1;     // recall position inside the current host history
let sshPrereqOk = null;     // null = unchecked, true/false after ssh -V

function sshHosts() {
  const list = state.settings.sshHosts;
  return Array.isArray(list) ? list : [];
}

function sshSelectedHost() {
  return sshHosts().find(h => h && h.id === sshSelectedId) || null;
}

/** Buttons that need a chosen host (or a chosen file) go enabled or not. */
function updateSshButtons() {
  const have = !!sshSelectedHost();
  const file = have && !!sshSelectedFile;
  for (const id of ['sshRunBtn', 'sshListBtn', 'sshHomeBtn', 'sshUpBtn', 'sshTestBtn', 'sshForgetKeyBtn', 'sshRemoveHostBtn']) {
    const el = $('#' + id);
    if (el) el.disabled = !have;
  }
  for (const id of ['sshPreviewBtn', 'sshDownloadBtn', 'sshCopyPreviewBtn']) {
    const el = $('#' + id);
    if (el) el.disabled = !file;
  }
  const outText = ($('#sshOut') && $('#sshOut').textContent) || '';
  const copyOut = $('#sshCopyOutBtn');
  if (copyOut) copyOut.disabled = !outText.trim();
  const clearOut = $('#sshClearOutBtn');
  if (clearOut) clearOut.disabled = !outText;
  const filter = $('#sshFilter');
  if (filter) filter.disabled = !sshFileCache.length;
  const title = $('#sshFormTitle');
  if (title) title.textContent = sshEditing && have ? 'Edit host' : 'New host';
}

function renderSsh() {
  const hostList = $('#sshHostList');
  if (!hostList) return;
  const hosts = sshHosts();
  if (sshSelectedId && !sshSelectedHost()) sshSelectedId = null;
  const count = $('#sshCount');
  if (count) count.textContent = hosts.length + (hosts.length === 1 ? ' host' : ' hosts');
  hostList.textContent = '';
  if (!hosts.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No hosts yet — fill in the form below and press “Save host”.';
    hostList.appendChild(empty);
  }
  for (const h of hosts) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ssh-host-row' + (h.id === sshSelectedId ? ' on' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(h.id === sshSelectedId));
    const name = document.createElement('span');
    name.className = 'ssh-host-name';
    name.textContent = h.label || h.host;
    const dest = document.createElement('span');
    dest.className = 'ssh-host-dest';
    dest.textContent = (h.user ? h.user + '@' : '') + h.host + (h.port && Number(h.port) !== 22 ? ':' + h.port : '');
    row.appendChild(name);
    row.appendChild(dest);
    const st = sshStatusById[h.id];
    if (st && typeof st.score === 'number') {
      const badge = document.createElement('span');
      badge.className = 'badge ssh-score ' + (st.score >= 80 ? 'good' : st.score >= 50 ? 'warn' : 'bad');
      badge.textContent = String(st.score);
      badge.title = 'Self-test ' + st.score + ' / 100';
      row.appendChild(badge);
    }
    row.title = (h.label || h.host) + ' — ' + ((h.user ? h.user + '@' : '') + h.host);
    row.addEventListener('click', () => selectSshHost(h.id));
    hostList.appendChild(row);
  }
  updateSshButtons();
}

/** Explain whether the system client exists before anything else runs. */
async function sshCheckPrereq() {
  const line = $('#sshPrereqLine');
  if (!line || typeof nexus.sshPrereq !== 'function') return;
  line.textContent = 'Checking for the OpenSSH client…';
  try {
    const r = await nexus.sshPrereq();
    if (r && r.ok) {
      sshPrereqOk = true;
      line.textContent = r.version ? 'OpenSSH ready — ' + r.version : 'OpenSSH ready.';
    } else {
      sshPrereqOk = false;
      line.textContent = (r && r.error) || 'OpenSSH (ssh) was not found — install it to use this panel.';
    }
  } catch (e) {
    sshPrereqOk = false;
    line.textContent = 'Could not check for ssh: ' + ((e && e.message) || e);
  }
}

/** Pick a saved host: fill the form with it and clear the old run output. */
function selectSshHost(id) {
  sshSelectedId = id;
  sshEditing = true;
  const h = sshSelectedHost();
  if (h) {
    $('#sshLabel').value = h.label || '';
    $('#sshHost').value = h.host || '';
    $('#sshUser').value = h.user || '';
    $('#sshPort').value = h.port && Number(h.port) !== 22 ? h.port : '';
    $('#sshKey').value = h.keyFile || '';
  }
  const err = $('#sshFormError');
  if (err) err.textContent = '';
  sshHistoryIdx = -1;
  renderSshHistory();
  clearSshOutputs();
  renderSsh();
}

/** Start a fresh host: empty form, nothing selected, outputs cleared. */
function newSshHost() {
  sshSelectedId = null;
  sshEditing = false;
  for (const [id, v] of [['sshLabel', ''], ['sshHost', ''], ['sshUser', ''], ['sshPort', ''], ['sshKey', '']]) {
    const el = $('#' + id);
    if (el) el.value = v;
  }
  const err = $('#sshFormError');
  if (err) err.textContent = '';
  clearSshOutputs();
  renderSsh();
  const host = $('#sshHost');
  if (host) host.focus();
}

/** Split a pasted "user@host:port" target so the boxes fill themselves. */
function parseSshHostBox(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^ssh:\/\//i, '');
  if (!s) return null;
  let user = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) { user = s.slice(0, at).trim(); s = s.slice(at + 1).trim(); }
  let host = s;
  let port = '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 0) {
      const rest = host.slice(end + 1);
      host = host.slice(1, end);
      const m = rest.match(/^:(\d{1,5})$/);
      if (m) port = m[1];
    }
  } else if ((host.match(/:/g) || []).length === 1) {
    const i = host.indexOf(':');
    if (/^\d{1,5}$/.test(host.slice(i + 1))) { port = host.slice(i + 1); host = host.slice(0, i); }
  }
  return { host: host.toLowerCase(), user, port };
}

function clearSshOutputs() {
  sshListedDir = '';
  sshSelectedFile = null;
  sshFileCache = [];
  const filter = $('#sshFilter');
  if (filter) filter.value = '';
  for (const [id, text] of [
    ['sshOut', ''], ['sshPreview', ''], ['sshFindings', ''], ['sshConfig', ''],
    ['sshNote', ''], ['sshFileStatus', ''], ['sshRunStatus', ''], ['sshEffective', ''],
    ['sshLastTest', '']
  ]) { const el = $('#' + id); if (el) el.textContent = text; }
  const score = $('#sshScore');
  if (score) { score.textContent = 'not run'; score.className = 'badge'; }
  const files = $('#sshFiles');
  if (files) { files.textContent = ''; files.classList.add('hidden'); }
  const crumbs = $('#sshCrumbs');
  if (crumbs) crumbs.textContent = '';
  updateSshButtons();
}

/** Disable a button while a bounded SSH call runs; state comes back after. */
async function sshBusy(btn, label, fn) {
  if (!btn || btn.disabled) return;
  const old = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast('SSH: ' + ((e && e.message) || e), 'error');
  } finally {
    btn.textContent = old;
    updateSshButtons();
  }
}

async function saveSshHost() {
  const errEl = $('#sshFormError');
  const showErr = (m) => { if (errEl) errEl.textContent = m || ''; };
  showErr('');
  // The host box accepts a pasted target; explicit boxes win when both exist.
  const pasted = parseSshHostBox($('#sshHost').value);
  let host = ($('#sshHost').value || '').trim().toLowerCase();
  let user = ($('#sshUser').value || '').trim();
  let portRaw = ($('#sshPort').value || '').trim();
  if (pasted && (pasted.host || pasted.user || pasted.port)) {
    host = pasted.host || host;
    if (!user && pasted.user) { user = pasted.user; $('#sshUser').value = user; }
    if (!portRaw && pasted.port) { portRaw = pasted.port; $('#sshPort').value = portRaw; }
    $('#sshHost').value = host;
  }
  if (host.startsWith('[') && host.endsWith(']') && host.length > 2) host = host.slice(1, -1);
  if (!host) { showErr('Enter a host name or IP address.'); return; }
  if (host.startsWith('-') || /\s/.test(host) || host.includes('@')) { showErr('That does not look like a host name or IP address.'); return; }
  if (user && !/^[A-Za-z0-9_][A-Za-z0-9._\-]{0,63}$/.test(user)) { showErr('User names use letters, digits, dot, underscore and dash.'); return; }
  let port = 22;
  if (portRaw) {
    port = parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) { showErr('Port must be between 1 and 65535.'); return; }
  }
  const entry = {
    id: (sshEditing && sshSelectedId) ? sshSelectedId : 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: ($('#sshLabel').value || '').trim().slice(0, 64) || host,
    host,
    user,
    port,
    keyFile: ($('#sshKey').value || '').trim().slice(0, 512)
  };
  // Same address twice is one host wearing two labels — point at it instead.
  const hosts = sshHosts().slice();
  const dupe = hosts.find(h => h && h.id !== entry.id
    && String(h.host || '').toLowerCase() === entry.host
    && String(h.user || '') === entry.user && Number(h.port) === Number(entry.port));
  if (dupe) {
    selectSshHost(dupe.id);
    toast('That host is already saved.', 'info');
    return;
  }
  const i = hosts.findIndex(h => h && h.id === entry.id);
  if (i >= 0) hosts[i] = entry; else hosts.push(entry);
  if (await saveSetting({ sshHosts: hosts })) {
    sshSelectedId = entry.id;
    sshEditing = true;
    renderSsh();
    toast('Host saved.', 'ok');
  }
}

async function removeSshHost() {
  const h = sshSelectedHost();
  if (!h) return;
  if (!confirm('Remove “' + (h.label || h.host) + '” from the saved list? Nothing changes on the machine itself.')) return;
  const hosts = sshHosts().filter(x => x && x.id !== h.id);
  if (await saveSetting({ sshHosts: hosts })) {
    sshSelectedId = null;
    sshEditing = false;
    clearSshOutputs();
    renderSsh();
  }
}

function sshHistory() {
  const h = sshSelectedHost();
  if (!h) return [];
  const list = sshHistoryById[h.id];
  return Array.isArray(list) ? list : [];
}

function sshPushHistory(cmd) {
  const h = sshSelectedHost();
  if (!h) return;
  const list = sshHistoryById[h.id] || (sshHistoryById[h.id] = []);
  if (list[list.length - 1] !== cmd) list.push(cmd);
  while (list.length > 30) list.shift();
  sshHistoryIdx = -1;
  renderSshHistory();
}

function renderSshHistory() {
  const dl = $('#sshCmdList');
  if (!dl) return;
  dl.textContent = '';
  for (const cmd of sshHistory().slice(-15).reverse()) {
    const opt = document.createElement('option');
    opt.value = cmd;
    dl.appendChild(opt);
  }
}

function sshRecall(dir) {
  const hist = sshHistory();
  if (!hist.length) return;
  if (sshHistoryIdx < 0) sshHistoryIdx = dir > 0 ? 0 : hist.length - 1;
  else sshHistoryIdx = Math.min(hist.length - 1, Math.max(0, sshHistoryIdx + dir));
  const input = $('#sshCmd');
  if (input) { input.value = hist[sshHistoryIdx] || ''; input.focus(); }
}

async function runSshCommand() {
  const host = sshSelectedHost();
  if (!host) { toast('Pick a saved host first.', 'error'); return; }
  const input = $('#sshCmd');
  const cmd = (input && input.value) || '';
  if (!cmd.trim()) { toast('Type a command to run.', 'error'); return; }
  const timeoutEl = $('#sshTimeout');
  const timeoutMs = timeoutEl ? Math.min(600000, Math.max(5000, parseInt(timeoutEl.value, 10) || 30000)) : 30000;
  const out = $('#sshOut');
  const status = $('#sshRunStatus');
  await sshBusy($('#sshRunBtn'), 'Running…', async () => {
    if (status) status.textContent = 'Running on ' + host.host + '…';
    out.textContent = 'Running on ' + host.host + '…';
    const r = await nexus.sshRun(host.id, cmd, timeoutMs);
    if (!r || !r.ok) {
      out.textContent = '! ' + ((r && r.error) || 'The command failed to start.');
      if (status) status.textContent = 'Failed to start.';
      updateSshButtons();
      return;
    }
    sshPushHistory(cmd.trim());
    let text = '$ ' + cmd.trim() + '\n';
    if (r.stdout) text += r.stdout;
    if (r.stderr) text += (r.stdout ? '\n' : '') + '[stderr]\n' + r.stderr;
    if (r.hint && r.code !== 0) text += '\nHint: ' + r.hint;
    if (r.truncated) text += '\n… output truncated …';
    text += '\n— exit ' + r.code + (r.timedOut ? ' (timed out)' : '') + ' · ' + r.ms + ' ms';
    out.textContent = text;
    if (status) status.textContent = 'Exit ' + r.code + ' · ' + r.ms + ' ms' + (r.timedOut ? ' · timed out' : '');
    updateSshButtons();
  });
}

function sshFormatBytes(n) {
  if (n === null || n === undefined) return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let u = 0;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + ' ' + units[u];
}

function sshFormatMtime(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '';
  try { return new Date(v).toISOString().slice(0, 16).replace('T', ' '); }
  catch { return ''; }
}

/** Clickable breadcrumbs for the resolved directory (" / var / log"). */
function renderSshCrumbs() {
  const box = $('#sshCrumbs');
  if (!box) return;
  box.textContent = '';
  const dir = sshListedDir || '';
  if (!dir) return;
  const parts = dir.split('/').filter(Boolean);
  const mk = (label, target, last) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ssh-crumb' + (last ? ' on' : '');
    b.textContent = label;
    if (!last) b.addEventListener('click', () => { $('#sshPath').value = target; sshListDir(); });
    else b.disabled = true;
    box.appendChild(b);
  };
  mk('/', '/', parts.length === 0);
  let acc = '';
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'ssh-crumb-sep';
    sep.textContent = ' / ';
    box.appendChild(sep);
    acc += '/' + p;
    mk(p, acc, i === parts.length - 1);
  });
}

/** Hide rows the filter box does not match; count what survives. */
function sshApplyFilter() {
  const files = $('#sshFiles');
  const status = $('#sshFileStatus');
  if (!files) return;
  const q = (($('#sshFilter') && $('#sshFilter').value) || '').trim().toLowerCase();
  let shown = 0;
  for (const row of files.querySelectorAll('.ssh-file-row')) {
    const name = String(row.dataset.name || '').toLowerCase();
    const keep = !q || name.includes(q);
    row.classList.toggle('hidden', !keep);
    if (keep) shown++;
  }
  if (status && q) status.textContent = shown + ' of ' + sshFileCache.length + ' match';
  else if (status && sshFileCache.length) status.textContent = sshFileCache.length + (sshFileCache.length === 1 ? ' entry' : ' entries');
}

/** One browser row: icon, name, and size/date when the far side reported them. */
function sshFileRow(e, files, status) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ssh-file-row';
  row.dataset.name = e.name || '';
  row.setAttribute('role', 'option');
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.textContent = e.dir ? '▸' : '·';
  const name = document.createElement('span');
  name.className = 'ssh-file-name';
  name.textContent = e.name;
  row.appendChild(ic);
  row.appendChild(name);
  const metaBits = [];
  if (!e.dir && (e.size === 0 || e.size)) metaBits.push(sshFormatBytes(e.size));
  const mt = sshFormatMtime(e.mtime);
  if (mt) metaBits.push(mt);
  if (metaBits.length) {
    const meta = document.createElement('span');
    meta.className = 'ssh-file-meta';
    meta.textContent = metaBits.join(' · ');
    row.appendChild(meta);
  }
  const open = async () => {
    if (e.dir) {
      $('#sshPath').value = e.path;
      await sshListDir();
    } else {
      sshSelectedFile = e;
      for (const other of files.querySelectorAll('.ssh-file-row')) other.classList.remove('on');
      row.classList.add('on');
      row.setAttribute('aria-selected', 'true');
      if (status) status.textContent = e.name;
      updateSshButtons();
    }
  };
  row.addEventListener('click', open);
  row.addEventListener('dblclick', open);
  return row;
}

/** List the remote directory in #sshPath ('' = login home). */
async function sshListDir() {
  const host = sshSelectedHost();
  if (!host) { toast('Pick a saved host first.', 'error'); return; }
  const files = $('#sshFiles');
  const status = $('#sshFileStatus');
  await sshBusy($('#sshListBtn'), 'Listing…', async () => {
    const r = await nexus.sshList(host.id, $('#sshPath').value);
    if (!r || !r.ok) {
      sshFileCache = [];
      if (status) status.textContent = (r && r.error) || 'Listing failed.';
      if (files) files.classList.add('hidden');
      renderSshCrumbs();
      updateSshButtons();
      return;
    }
    sshListedDir = r.dir || '';
    $('#sshPath').value = sshListedDir || $('#sshPath').value;
    sshSelectedFile = null;
    sshFileCache = Array.isArray(r.entries) ? r.entries : [];
    files.textContent = '';
    files.classList.remove('hidden');
    renderSshCrumbs();
    if (!sshFileCache.length) {
      if (status) status.textContent = 'Nothing here — the path may not exist.';
    } else if (status) {
      status.textContent = sshFileCache.length + (sshFileCache.length === 1 ? ' entry' : ' entries')
        + (r.truncated ? ' (truncated)' : '');
    }
    for (const e of sshFileCache) files.appendChild(sshFileRow(e, files, status));
    sshApplyFilter();
    updateSshButtons();
  });
}

function sshUpDir() {
  const cur = ($('#sshPath').value || '').trim() || sshListedDir || '';
  if (!cur) return;
  if (cur === '/') return;
  const parent = cur.replace(/\/[^/]+$/, '');
  $('#sshPath').value = parent ? parent : '/';
  sshListDir();
}

function sshHomeDir() {
  $('#sshPath').value = '';
  sshListDir();
}

async function sshPreviewFile() {
  const host = sshSelectedHost();
  const file = sshSelectedFile;
  if (!host || !file) return;
  const out = $('#sshPreview');
  const status = $('#sshFileStatus');
  await sshBusy($('#sshPreviewBtn'), 'Reading…', async () => {
    const r = await nexus.sshRead(host.id, file.path);
    if (!r || !r.ok) { out.textContent = '! ' + ((r && r.error) || 'Could not read the file.'); return; }
    if (r.binary) {
      out.textContent = 'Binary file — ' + r.bytes + ' bytes. Preview skipped.';
      if (status) status.textContent = file.name + ' — binary, ' + r.bytes + ' bytes';
      updateSshButtons();
      return;
    }
    let text = r.text;
    const shown = text.length > 200000;
    if (shown) text = text.slice(0, 200000);
    out.textContent = text + (shown || r.truncated ? '\n… truncated …' : '');
    if (status) status.textContent = file.name + ' — ' + r.bytes + ' bytes read';
    updateSshButtons();
  });
}

async function sshDownloadFile() {
  const host = sshSelectedHost();
  const file = sshSelectedFile;
  if (!host || !file) return;
  const status = $('#sshFileStatus');
  await sshBusy($('#sshDownloadBtn'), 'Saving…', async () => {
    const r = await nexus.sshSave(host.id, file.path, file.name);
    if (!r || !r.ok) { toast('Save failed: ' + ((r && r.error) || 'unknown'), 'error'); return; }
    if (status) status.textContent = 'Saved as ' + r.savedAs;
    toast('Saved to the workspace as ' + r.savedAs + '.', 'ok');
  });
}

async function sshCopyText(text, emptyNote, doneNote) {
  if (!text) { toast(emptyNote, 'info'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(doneNote, 'ok');
  } catch {
    toast('Copy failed — select the text and copy it manually.', 'error');
  }
}

async function runSshSelfTest() {
  const host = sshSelectedHost();
  if (!host) { toast('Pick a saved host first.', 'error'); return; }
  const scoreEl = $('#sshScore');
  const findingsEl = $('#sshFindings');
  const noteEl = $('#sshNote');
  const cfgEl = $('#sshConfig');
  const effEl = $('#sshEffective');
  const lastEl = $('#sshLastTest');
  await sshBusy($('#sshTestBtn'), 'Testing…', async () => {
    scoreEl.textContent = '…';
    findingsEl.textContent = '';
    noteEl.textContent = '';
    cfgEl.textContent = '';
    if (effEl) effEl.textContent = '';
    if (lastEl) lastEl.textContent = '';
    const r = await nexus.sshTest(host.id);
    if (!r || !r.ok) {
      scoreEl.textContent = 'failed';
      scoreEl.className = 'badge ssh-score bad';
      const row = document.createElement('div');
      row.className = 'finding bad';
      const t = document.createElement('strong');
      t.textContent = '✕ ' + ((r && r.error) || 'The self-test could not run.');
      row.appendChild(t);
      findingsEl.appendChild(row);
      return;
    }
    sshStatusById[host.id] = { score: r.score, ms: null, at: Date.now() };
    renderSsh();
    scoreEl.textContent = r.score + ' / 100';
    scoreEl.className = 'badge ssh-score ' + (r.score >= 80 ? 'good' : r.score >= 50 ? 'warn' : 'bad');
    if (lastEl) lastEl.textContent = 'checked just now';
    if (effEl && r.effective) {
      const bits = [];
      if (r.effective.user) bits.push(r.effective.user + '@');
      bits.push(r.effective.hostname || host.host);
      if (r.effective.port && String(r.effective.port) !== '22') bits.push(':' + r.effective.port);
      const keys = Array.isArray(r.effective.identityfile) ? r.effective.identityfile : [];
      effEl.textContent = 'Effective: ' + bits.join('') + (keys.length ? ' — key ' + keys[0] : '');
    }
    for (const f of r.findings || []) {
      const row = document.createElement('div');
      row.className = 'finding ' + (f.level || '');
      const t = document.createElement('strong');
      t.textContent = (f.level === 'bad' ? '✕ ' : f.level === 'warn' ? '! ' : '✓ ') + (f.title || '');
      row.appendChild(t);
      const d = document.createElement('div');
      d.textContent = f.detail || '';
      row.appendChild(d);
      if (f.fix) {
        const fx = document.createElement('span');
        fx.className = 'fx';
        fx.textContent = 'Fix: ' + f.fix;
        row.appendChild(fx);
      }
      findingsEl.appendChild(row);
    }
    noteEl.textContent = r.note || '';
    cfgEl.textContent = r.config || '';
    updateSshButtons();
  });
}

function bindSsh() {
  const saveBtn = $('#sshSaveHostBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveSshHost);
  const newBtn = $('#sshNewHostBtn');
  if (newBtn) newBtn.addEventListener('click', newSshHost);
  const rm = $('#sshRemoveHostBtn');
  if (rm) rm.addEventListener('click', removeSshHost);
  const run = $('#sshRunBtn');
  if (run) run.addEventListener('click', runSshCommand);
  const cmdInput = $('#sshCmd');
  if (cmdInput) cmdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSshCommand();
    else if (e.key === 'ArrowUp') { e.preventDefault(); sshRecall(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sshRecall(1); }
  });
  const copyOut = $('#sshCopyOutBtn');
  if (copyOut) copyOut.addEventListener('click', async () => {
    await sshCopyText(($('#sshOut') && $('#sshOut').textContent) || '', 'Nothing to copy yet — run a command first.', 'Output copied.');
  });
  const clearOut = $('#sshClearOutBtn');
  if (clearOut) clearOut.addEventListener('click', () => {
    const out = $('#sshOut');
    if (out) out.textContent = '';
    const st = $('#sshRunStatus');
    if (st) st.textContent = '';
    updateSshButtons();
  });
  const list = $('#sshListBtn');
  if (list) list.addEventListener('click', sshListDir);
  const pathInput = $('#sshPath');
  if (pathInput) pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') sshListDir(); });
  const up = $('#sshUpBtn');
  if (up) up.addEventListener('click', sshUpDir);
  const home = $('#sshHomeBtn');
  if (home) home.addEventListener('click', sshHomeDir);
  const filter = $('#sshFilter');
  if (filter) filter.addEventListener('input', sshApplyFilter);
  const pv = $('#sshPreviewBtn');
  if (pv) pv.addEventListener('click', sshPreviewFile);
  const dl = $('#sshDownloadBtn');
  if (dl) dl.addEventListener('click', sshDownloadFile);
  const copyPv = $('#sshCopyPreviewBtn');
  if (copyPv) copyPv.addEventListener('click', async () => {
    await sshCopyText(($('#sshPreview') && $('#sshPreview').textContent) || '', 'Nothing to copy yet — preview a file first.', 'Preview copied.');
  });
  const test = $('#sshTestBtn');
  if (test) test.addEventListener('click', runSshSelfTest);
  const copy = $('#sshCopyCfgBtn');
  if (copy) copy.addEventListener('click', async () => {
    const cfg = $('#sshConfig');
    const text = (cfg && cfg.textContent) || '';
    await sshCopyText(text, 'Run the self-test first — it produces the block.', 'Host block copied.');
  });
  const forget = $('#sshForgetKeyBtn');
  if (forget) forget.addEventListener('click', async () => {
    const host = sshSelectedHost();
    if (!host) return;
    if (!confirm('Forget the saved host key for “' + host.host + '”? The next connection from anywhere on this machine will ask again.')) return;
    await sshBusy(forget, 'Forgetting…', async () => {
      const r = await nexus.sshForgetKey(host.id);
      if (r && r.ok) toast('Host key forgotten.', 'ok');
      else toast('Could not forget the key: ' + ((r && r.error) || 'unknown'), 'error');
    });
  });
  updateSshButtons();
  sshCheckPrereq();
}

/* ================================================================== */
/* Assistant (tools): settings, permission prompt, activity rows       */
/* ================================================================== */

/**
 * One tool call as a collapsible row in the conversation: what was called,
 * how it ended, and the output if you want to read it. Built with DOM nodes
 * and textContent — a file's contents end up in here.
 */
function toolMessageEl(m) {
  const meta = (m && m.meta) || {};
  const wrap = document.createElement('details');
  wrap.className = 'msg tool';

  const head = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = meta.tool || 'tool';
  const state = document.createElement('span');
  const ok = meta.ok === true;
  const denied = meta.denied === true;
  state.className = 'tool-state ' + (ok ? 'ok' : denied ? 'denied' : 'err');
  state.textContent = ok ? 'done' : denied ? 'declined' : 'failed';
  head.appendChild(name);
  head.appendChild(state);
  wrap.appendChild(head);

  const pre = document.createElement('pre');
  pre.className = 'tool-output';
  pre.textContent = String(m.content || '');
  wrap.appendChild(pre);

  if (m.ts) {
    const t = document.createElement('span');
    t.className = 'msg-time';
    t.textContent = new Date(m.ts).toLocaleTimeString();
    wrap.appendChild(t);
  }
  return wrap;
}

async function loadAgent() {
  try {
    agentState = await nexus.agentInfo();
  } catch {
    agentState = null;
  }
  renderAgent();
  updateToolsToggle();
  renderSshDest(lastDestConv); // the line under the composer shows the workspace
}

function renderAgent() {
  const a = agentState;
  const pill = $('#agentPill');
  if (!pill || !a) return;
  const ready = a.enabled === true && a.workspaceOk === true;
  pill.textContent = ready ? 'On' : (a.enabled ? 'Needs a folder' : 'Off');
  pill.className = 'badge ' + (ready ? 'ok' : '');

  const line = $('#agentWorkspaceLine');
  if (line) {
    line.textContent = a.workspace
      ? (a.workspaceOk ? 'Workspace: ' + a.workspace : 'That folder is gone — choose another one.')
      : 'No workspace chosen yet.';
  }
  const toggle = $('#agentToggleBtn');
  if (toggle) toggle.textContent = a.enabled ? 'Turn tools off' : 'Turn tools on';
  const reads = $('#agentReadsBtn');
  if (reads) reads.textContent = 'Ask before reads: ' + (a.askBeforeReads ? 'on' : 'off');
  const grants = $('#agentGrantsBtn');
  if (grants) grants.textContent = 'Remember write approvals: ' + (a.allowSessionGrants ? 'on' : 'off');
  const net = $('#agentNetBtn');
  if (net) net.textContent = 'Network tools: ' + (a.allowNetwork ? 'on' : 'off');
  const steps = $('#agentSteps');
  if (steps) steps.value = String(a.maxSteps || 12);

  const host = $('#agentToolList');
  if (host && Array.isArray(a.catalog)) {
    host.innerHTML = '';
    const groups = [
      ['read', 'Reads — run without asking, listed in the chat'],
      ['write', 'Writes — ask every time (rememberable)'],
      ['danger', 'Careful — ask every time, never remembered']
    ];
    for (const [risk, label] of groups) {
      const tools = a.catalog.filter(t => t.risk === risk);
      if (!tools.length) continue;
      const lineEl = document.createElement('div');
      lineEl.className = 'tool-catalog-row';
      const head = document.createElement('span');
      head.className = 'tool-catalog-head ' + risk;
      head.textContent = label;
      lineEl.appendChild(head);
      const names = document.createElement('span');
      names.className = 'tool-catalog-names';
      names.textContent = tools.map(t => t.name).join(' · ');
      lineEl.appendChild(names);
      host.appendChild(lineEl);
    }
    if (a.grants && a.grants.length) {
      const remembered = document.createElement('div');
      remembered.className = 'tool-catalog-row';
      remembered.textContent = 'Remembered for this session: ' + a.grants.join(', ');
      host.appendChild(remembered);
    }
  }
}

function updateToolsToggle(conv) {
  const btn = $('#toolsToggleBtn');
  if (!btn) return;
  const c = conv === undefined ? lastDestConv : conv;
  const remote = !!(c && c.sshHostId);
  const ready = !!(agentState && agentState.enabled && (agentState.workspaceOk || remote));
  btn.classList.toggle('hidden', !ready);
  btn.textContent = toolsOn ? (remote ? 'Tools on · SSH' : 'Tools on') : 'Tools off';
  btn.classList.toggle('on', toolsOn);
  // It is a switch, not a label: say which state it is in, not just show it.
  if (btn.setAttribute) btn.setAttribute('aria-pressed', String(toolsOn));
  btn.title = toolsOn
    ? (remote
      ? 'The assistant may use tools on the connected host — it still asks before anything changes.'
      : 'The assistant may use tools on the workspace — it still asks before anything changes.')
    : 'Let the assistant use tools in this chat.';
}

/* ------------------------------------------------------------------ */
/* Chat SSH destination — a cluster in the composer, under the input   */
/* ------------------------------------------------------------------ */

/* Hosts live in settings; the chat only stores the id + folder. Resolve
 * here for display, so a host renamed in Settings renames itself in chats. */
let lastDestConv = null;
/* Live reachability per chat: convId -> { ok, at }. A stored destination is
 * only a claim until a listing proves the host answers — the pill shows
 * Checking… then flips to Connected or Not reached. Entries live 60s so
 * opening a chat does not probe on every repaint. */
let sshLiveByConv = {};
let sshVerifying = {};
const SSH_LIVE_TTL_MS = 60000;

function sshDestFor(conv) {
  if (!conv || !conv.sshHostId) return null;
  const list = state && state.settings && Array.isArray(state.settings.sshHosts)
    ? state.settings.sshHosts : [];
  const host = list.find(h => h && h.id === conv.sshHostId) || null;
  return { host, base: conv.sshPath || '' };
}

function sshCheckFresh(atMs) {
  return Number.isFinite(atMs) && (Date.now() - atMs < SSH_LIVE_TTL_MS);
}

/** A stored check counts only while fresh — otherwise the host is reasked. */
function sshStoredFresh(conv) {
  if (!conv || conv.sshOk !== true || !conv.sshCheckedAt) return false;
  const at = Date.parse(conv.sshCheckedAt);
  return sshCheckFresh(at);
}

/** The line under the composer: badge, name, then where the chat works. */
function renderSshDest(conv) {
  lastDestConv = conv || null;
  const dot = $('#sshDestDot');
  const badge = $('#sshDestBadge');
  const btn = $('#sshDestBtn');
  const loc = $('#sshDestText');
  if (!dot || !badge || !btn || !loc) return;
  // One painter for every state, so the line never half-updates: dot class,
  // badge mark, button name, location text, and what the button explains.
  const paint = (cls, mark, name, where, opts = {}) => {
    dot.className = 'ssh-dest-dot' + (cls ? ' ' + cls : '');
    badge.textContent = mark;
    btn.textContent = name + ' ▾';
    btn.disabled = opts.disabled === true;
    btn.title = opts.controlTitle || 'Attach this chat to a saved SSH host, or detach it.';
    loc.textContent = where;
    loc.title = opts.whereTitle || where;
  };
  const localWhere = sshLocalWhere();
  if (!conv) {
    paint('', '⌂', 'This PC', localWhere || 'no workspace folder',
      { disabled: true, controlTitle: 'Start a chat first, then attach it to a host.' });
    return;
  }
  const dest = sshDestFor(conv);
  if (!dest) {
    paint('', '⌂', 'This PC', localWhere || 'no workspace folder');
    return;
  }
  if (!dest.host) {
    paint('warn', '?', 'Choose host', 'saved host removed — pick again');
    return;
  }
  const label = dest.host.label || dest.host.host;
  const folder = dest.base || '~';
  const mark = sshBadgeInitial(label);
  const live = sshLiveByConv[conv.id];
  if (live && sshCheckFresh(live.at)) {
    paint(live.ok ? 'on' : 'bad', mark, label, live.ok ? folder : folder + ' · not reached');
    return;
  }
  if (sshStoredFresh(conv)) {
    paint('on', mark, label, folder);
    return;
  }
  paint('checking', mark, label, folder + ' · checking…');
  verifySshDest(conv);
}

/** First alphanumeric of a label, uppercased — the badge mark. */
function sshBadgeInitial(label) {
  const m = String(label || '').match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '?';
}

/** Where local tools run: the validated workspace, if one is set. */
function sshLocalWhere() {
  const w = (agentState && agentState.workspace)
    || (state && state.settings && state.settings.agent && state.settings.agent.workspace)
    || '';
  return String(w || '');
}

/**
 * Prove the host answers by listing the folder through the same channel
 * Connect uses — reusing setSsh refreshes the stored check on success and
 * leaves it alone on failure (the pill still says Not reached). Silent by
 * design: the pill is the whole report.
 */
async function verifySshDest(conv) {
  if (!conv || !conv.id || !conv.sshHostId) return;
  if (sshVerifying[conv.id]) return;
  sshVerifying[conv.id] = true;
  try {
    const r = await nexus.setConversationSsh(conv.id, conv.sshHostId, conv.sshPath || '');
    sshLiveByConv[conv.id] = { ok: !!(r && r.ok), at: Date.now() };
    if (r && r.ok && currentConvId === conv.id) {
      // Stored sshOk/checkedAt are fresh now — repaint from the record so
      // the next open trusts it without probing again.
      const fresh = await nexus.getConversation(conv.id).catch(() => null);
      if (fresh && currentConvId === conv.id) {
        renderSshDest(fresh);
        updateToolsToggle(fresh);
        return;
      }
    }
  } catch {
    sshLiveByConv[conv.id] = { ok: false, at: Date.now() };
  } finally {
    delete sshVerifying[conv.id];
  }
  if (currentConvId === conv.id) {
    const c = (lastDestConv && lastDestConv.id === conv.id) ? lastDestConv : conv;
    renderSshDest(c);
  }
}

function openSshDest() {
  if (!currentConvId) { toast('Start a chat first, then attach it to a host.', 'info'); return; }
  const sel = $('#sshDestHost');
  const pathInput = $('#sshDestPath');
  const err = $('#sshDestError');
  if (err) err.textContent = '';
  if (sel) {
    sel.textContent = '';
    const list = state && state.settings && Array.isArray(state.settings.sshHosts)
      ? state.settings.sshHosts : [];
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No saved hosts — add one in Settings → SSH';
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const h of list) {
        const opt = document.createElement('option');
        opt.value = h.id;
        opt.textContent = (h.label || h.host) + ' — ' + ((h.user ? h.user + '@' : '') + h.host);
        sel.appendChild(opt);
      }
    }
    const conv = lastDestConv;
    if (conv && conv.sshHostId) sel.value = conv.sshHostId;
  }
  if (pathInput) pathInput.value = (lastDestConv && lastDestConv.sshPath) || '';
  const modal = $('#sshDestModal');
  if (modal) {
    modal.classList.remove('hidden');
    if (sel && !sel.disabled) sel.focus();
  }
}

function closeSshDest() {
  const modal = $('#sshDestModal');
  if (modal) modal.classList.add('hidden');
}

async function connectSshDest() {
  const sel = $('#sshDestHost');
  const pathInput = $('#sshDestPath');
  const err = $('#sshDestError');
  const hostId = (sel && !sel.disabled && sel.value) || '';
  if (!hostId) { if (err) err.textContent = 'Save a host in Settings → SSH first.'; return; }
  const btn = $('#sshDestConnectBtn');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
  try {
    const r = await nexus.setConversationSsh(currentConvId, hostId, (pathInput && pathInput.value) || '');
    if (!r || !r.ok) {
      if (err) err.textContent = (r && r.error) || 'Could not reach that folder.';
      return;
    }
    closeSshDest();
    sshLiveByConv[currentConvId] = { ok: true, at: Date.now() };
    await refreshConversations();
    await renderMessages();
    toast('Connected — tools will run there when they are on.', 'ok');
  } catch (e) {
    if (err) err.textContent = 'Connection failed: ' + ((e && e.message) || e);
  } finally {
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}

async function disconnectSshDest() {
  if (!currentConvId) return;
  try {
    const r = await nexus.setConversationSsh(currentConvId, null, '');
    if (!r || !r.ok) { toast((r && r.error) || 'Could not detach.', 'error'); return; }
    delete sshLiveByConv[currentConvId];
    closeSshDest();
    await refreshConversations();
    await renderMessages();
    toast('Detached — tools run on this PC again.', 'ok');
  } catch (e) {
    toast('Could not detach: ' + ((e && e.message) || e), 'error');
  }
}

function bindSshDest() {
  const open = $('#sshDestBtn');
  if (open) open.addEventListener('click', openSshDest);
  const cancel = $('#sshDestCancelBtn');
  if (cancel) cancel.addEventListener('click', closeSshDest);
  const go = $('#sshDestConnectBtn');
  if (go) go.addEventListener('click', connectSshDest);
  const off = $('#sshDestDisconnectBtn');
  if (off) off.addEventListener('click', disconnectSshDest);
  const modal = $('#sshDestModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeSshDest(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden') && !pendingTool) closeSshDest();
  });
}

/* ------------------------------------------------------------------ */
/* Permission prompt — the only way a tool ever gets to run            */
/* ------------------------------------------------------------------ */

function showToolAsk(request) {
  if (!request) return;
  // The loop runs calls one at a time, but a denied call can be followed
  // immediately by another ask. Queue instead of overwriting: an overwritten
  // request would leave the main process waiting until its timeout.
  if (pendingTool) {
    toolQueue.push(request);
    return;
  }
  pendingTool = request;
  const summary = $('#toolSummary');
  const detail = $('#toolDetail');
  const preview = $('#toolPreview');
  const badge = $('#toolRiskBadge');
  const always = $('#toolAlwaysBtn');
  if (summary) summary.textContent = request.summary || request.name || '';
  if (detail) detail.textContent = request.detail || '';
  if (preview) preview.textContent = request.preview || '';
  if (preview) preview.classList.toggle('hidden', !request.preview);
  if (badge) {
    badge.textContent = request.risk === 'danger'
      ? 'careful — never remembered'
      : (request.risk === 'write' ? 'changes files — asks every time' : 'reads');
    badge.className = 'badge ' + (request.risk === 'danger' ? 'tool-danger' : (request.risk === 'write' ? 'tool-write' : 'tool-read'));
  }
  // "Allow for this session" only exists where remembering is safe.
  if (always) always.classList.toggle('hidden', request.canRemember !== true);
  const modal = $('#toolModal');
  // Remember the opener only for the first prompt of a run: a queued one
  // would otherwise point focus back at a button this dialog just hid.
  if (modal && modal.classList.contains('hidden') && !toolReturnTo) {
    toolReturnTo = stashReturnFocus(modal);
  }
  if (modal) modal.classList.remove('hidden');
  const deny = $('#toolDenyBtn');
  if (deny) deny.focus();
}

async function answerTool(decision) {
  const request = pendingTool;
  if (!request) return;
  pendingTool = null;
  const modal = $('#toolModal');
  if (modal) modal.classList.add('hidden');
  try {
    await nexus.answerTool(request.id, decision);
  } catch {
    toast('Could not answer that prompt — treating it as denied.', 'error');
  }
  // Answer whatever was waiting behind this one.
  if (toolQueue.length) { showToolAsk(toolQueue.shift()); return; }
  const back = toolReturnTo;
  toolReturnTo = null;
  handBackFocus(back);
}

function bindAgent() {
  nexus.onToolAsk(showToolAsk);
  // Results are already persisted in the conversation; re-read and redraw.
  nexus.onToolResult((p) => { if (p && p.conversationId === currentConvId) renderMessages(); });

  const deny = $('#toolDenyBtn');
  const allow = $('#toolAllowBtn');
  const always = $('#toolAlwaysBtn');
  if (deny) deny.addEventListener('click', () => answerTool('deny'));
  if (allow) allow.addEventListener('click', () => answerTool('allow'));
  if (always) always.addEventListener('click', () => answerTool('always'));
  // Escape denies, like every other dialog in the app.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pendingTool) { e.preventDefault(); answerTool('deny'); }
  });

  const toggle = $('#toolsToggleBtn');
  if (toggle) toggle.addEventListener('click', () => {
    toolsOn = !toolsOn;
    updateToolsToggle();
    toast(toolsOn ? 'Tools on for this chat.' : 'Tools off for this chat.');
  });

  const save = async (patch) => {
    await nexus.updateSettings({ agent: patch }).catch(() => {});
    await loadAgent();
  };
  const on = $('#agentToggleBtn');
  if (on) on.addEventListener('click', () => save({ enabled: !(agentState && agentState.enabled) }));
  const ws = $('#agentWorkspaceBtn');
  if (ws) ws.addEventListener('click', async () => {
    const r = await nexus.setAgentWorkspace().catch(() => null);
    if (!r) return;
    if (r.canceled) return;
    if (!r.ok) { toast(r.error || 'Could not use that folder.', 'error'); return; }
    await loadAgent();
    toast('Workspace: ' + (agentState && agentState.workspace));
  });
  const reads = $('#agentReadsBtn');
  if (reads) reads.addEventListener('click', () => save({ askBeforeReads: !(agentState && agentState.askBeforeReads) }));
  const grants = $('#agentGrantsBtn');
  if (grants) grants.addEventListener('click', () => save({ allowSessionGrants: !(agentState && agentState.allowSessionGrants) }));
  const net = $('#agentNetBtn');
  if (net) net.addEventListener('click', () => save({ allowNetwork: !(agentState && agentState.allowNetwork) }));
  const steps = $('#agentSteps');
  if (steps) steps.addEventListener('change', () => {
    const n = Math.max(1, Math.min(25, parseInt(steps.value, 10) || 12));
    steps.value = String(n);
    save({ maxSteps: n });
  });
  const clear = $('#agentClearBtn');
  if (clear) clear.addEventListener('click', async () => {
    const r = await nexus.clearAgentGrants().catch(() => null);
    await loadAgent();
    toast(r && r.cleared ? 'Forgot ' + r.cleared + ' remembered approval(s).' : 'Nothing was remembered.', 'ok');
  });
}

/* ================================================================== */
/* Bots tab — 24/7 background task runners                            */
/* ================================================================== */

let bots = [];
let currentBotId = null;         // which bot's pane is open (auto-selected on load)
let editingBotId = null;
let botBusy = {};
let botSending = false;
function botIntervalLabel(sec) {
  sec = Number(sec);
  if (sec < 120) return 'every minute';
  if (sec < 3600) return 'every ' + Math.round(sec / 60) + ' min';
  if (sec < 86400) return 'every ' + (sec / 3600) + 'h';
  if (sec === 86400) return 'daily';
  if (sec < 604800) return 'every ' + Math.round(sec / 86400) + 'd';
  if (sec === 604800) return 'weekly';
  return 'every ' + Math.round(sec / 604800) + 'w';
}

/** Relative "last active" time for the bot list, like a chat app ("now", "5m"). */
function botRelTime(bot) {
  const ts = bot.lastRunAt || bot.updatedAt;
  if (!ts) return 'now';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function botNextIn(nextRunAt) {
  if (!nextRunAt) return 'soon';
  const s = Math.max(0, Math.round((Date.parse(nextRunAt) - Date.now()) / 1000));
  if (s < 5) return 'any second now';
  if (s < 60) return 'in ' + s + 's';
  if (s < 3600) return 'in ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + 'h';
  return 'in ' + Math.round(s / 86400) + 'd';
}

/**
 * Providers a bot may use — every provider registered in the app; the model
 * choices follow the provider's own configuration.
 */
function botProviderOptions() {
  return state.providers;
}

function populateBotProviders() {
  const sel = $('#botProvider');
  const opts = botProviderOptions();
  const prev = sel.value;
  sel.innerHTML = '';
  if (!opts.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No providers yet — add one in the Providers tab';
    o.disabled = true; o.selected = true;
    sel.appendChild(o);
  } else {
    for (const p of opts) {
      const o = document.createElement('option');
      o.value = p.id;
      const usable = providerUsable(p);
      o.textContent = p.name + (usable ? '' : ' (needs setup)');
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  }
  populateBotModels();
}

function populateBotModels() {
  const sel = $('#botModel');
  const p = state.providers.find(x => x.id === $('#botProvider').value);
  const prev = sel.value;
  sel.innerHTML = '';
  const models = p ? [...new Set([...((p.config && p.config.models) || []), ...(p.defaultModels || [])])] : [];
  if (!models.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Default model'; o.selected = true;
    sel.appendChild(o);
    return;
  }
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function bindBots() {
  $('#botProvider').addEventListener('change', populateBotModels);
  $('#newBotBtn').addEventListener('click', () => openBotModal(false));
  $('#botModalCancelBtn').addEventListener('click', closeBotModal);
  $('#botSubmitBtn').addEventListener('click', submitBotForm);
  $('#botSendBtn').addEventListener('click', sendBotMessage);
  $('#botInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBotMessage(); }
  });
  $('#botInput').addEventListener('input', () => {
    const el = $('#botInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  });
  // Close the bot kebab menu on any outside click / Escape; Escape also
  // dismisses the bot modal (the first-launch background prompt is modal and
  // must be answered, so it stays).
  document.addEventListener('click', e => {
    const menu = $('#botMenu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hideBotMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      hideBotMenu();
      const sb = $('#botSubmitBtn');
      if (sb && sb.disabled) return;
      closeBotModal();
    }
  });
}

async function loadBots(quiet) {
  try {
    const r = await nexus.listBots();
    if (!r.ok) throw new Error(r.error || 'Failed to load bots.');
    bots = r.bots || [];
    if (!currentBotId || !bots.some(b => b.id === currentBotId)) {
      // First load, or the open bot was deleted — show the first bot, else none.
      currentBotId = bots.length ? bots[0].id : null;
    }
    const lbl = $('#botCountLabel');
    const n = bots.length;
    if (lbl) lbl.textContent = n ? `(${n})` : '';
    renderBotList();
    renderBotHeader();
    await loadBotChat(true);
  } catch (e) {
    if (!quiet) toast('Could not load bots: ' + e.message, 'error');
  }
}

function currentBot() {
  return bots.find(b => b.id === currentBotId) || null;
}

/* Sidebar filters: a growing list gets a search box and chips,
 * each carrying a count so "what needs attention?" is answerable at a glance. */
const BOT_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'paused', label: 'Paused' },
  { id: 'errors', label: 'Errors' }
];

function botMatchesFilter(bot, filter) {
  switch (filter) {
    case 'running': return bot.status === 'running';
    case 'paused': return bot.status !== 'running';
    case 'errors': return bot.lastStatus === 'error';
    default: return true;
  }
}

function botMatchesQuery(bot, q) {
  if (!q) return true;
  return (bot.name + ' ' + bot.task).toLowerCase().includes(q);
}

function renderBotFilters() {
  const host = $('#botFilters');
  if (!host) return;
  const items = bots;
  host.innerHTML = '';
  for (const f of BOT_FILTERS) {
    const n = items.filter(b => botMatchesFilter(b, f.id)).length;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip' + (botFilter === f.id ? ' active' : '');
    chip.textContent = f.label + ' ' + n;
    chip.setAttribute('aria-pressed', String(botFilter === f.id));
    chip.addEventListener('click', () => { botFilter = f.id; renderBotList(); });
    host.appendChild(chip);
  }
}

/**
 * Group the visible workers so a big fleet stays readable: anything that errored
 * first, then paused, then the healthy runners — each sorted by next run.
 */
function botGroups(items) {
  const byNextRun = (a, b) => Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0);
  return [
    { id: 'attention', label: 'Needs attention', items: items.filter(b => b.lastStatus === 'error').sort(byNextRun) },
    { id: 'paused', label: 'Paused', items: items.filter(b => b.lastStatus !== 'error' && b.status !== 'running').sort(byNextRun) },
    { id: 'running', label: 'Running', items: items.filter(b => b.lastStatus !== 'error' && b.status === 'running').sort(byNextRun) }
  ].filter(g => g.items.length);
}

function renderBotList() {
  const list = $('#botList');
  if (!list) return;
  renderBotFilters();
  list.innerHTML = '';
  const all = bots;
  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'bot-empty';
    const t = document.createElement('div');
    t.className = 'bot-empty-t';
    t.textContent = 'No bots yet';
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Create one with + — give it a task and a schedule, and it runs while the app is open.';
    empty.appendChild(t);
    empty.appendChild(hint);
    list.appendChild(empty);
    return;
  }
  const shown = all.filter(b => botMatchesFilter(b, botFilter) && botMatchesQuery(b, botQuery));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'bot-group-empty muted';
    empty.textContent = botQuery ? 'No bots match “' + botQuery + '”.' : 'No bots in this filter.';
    list.appendChild(empty);
    return;
  }
  const groups = botGroups(shown);
  for (const g of groups) {
    // Headers only earn their space when more than one group is on screen.
    if (groups.length > 1) {
      const head = document.createElement('div');
      head.className = 'bot-group-head';
      const label = document.createElement('span');
      label.textContent = g.label;
      const count = document.createElement('span');
      count.textContent = String(g.items.length);
      head.appendChild(label);
      head.appendChild(count);
      list.appendChild(head);
    }
    for (const bot of g.items) list.appendChild(botRow(bot));
  }
}

function botRow(bot) {
  const item = document.createElement('div');
  item.className = 'conv-item bot-item' + (bot.id === currentBotId ? ' active' : '');
  // The row carries the open click (so its hover padding is not a dead band);
  // the inner wrapper keeps the focus, role and the kebab's sibling — never
  // nested inside another control.
  const openEl = document.createElement('div');
  openEl.className = 'conv-open';
  openEl.tabIndex = 0;
  openEl.setAttribute('role', 'button');
  openEl.setAttribute('aria-label', 'Open bot: ' + bot.name);
  if (bot.id === currentBotId) openEl.setAttribute('aria-current', 'true');
    // Status dot, like a chat app: live while the schedule runs.
    const avatar = document.createElement('span');
    avatar.className = 'bot-avatar'; // wing mark, not emoji — one bot identity everywhere
    const main = document.createElement('span');
    main.className = 'conv-title';
    main.title = bot.name + '\n' + bot.task;
    const nameRow = document.createElement('span');
    nameRow.className = 'bot-name-row';
    const dot = document.createElement('span');
    dot.className = 'bot-dot ' + (bot.status === 'running' ? 'running' : 'paused');
    dot.title = bot.status === 'running' ? 'Running' : 'Paused';
    dot.setAttribute('aria-label', bot.status === 'running' ? 'Running' : 'Paused');
    nameRow.appendChild(dot);
    nameRow.appendChild(document.createTextNode(bot.name));
    main.appendChild(nameRow);
    const sub = document.createElement('span');
    sub.className = 'bot-item-sub';
    sub.textContent = (bot.status === 'running' ? 'Runs ' + botIntervalLabel(bot.intervalSec) + ' · ' + botNextIn(bot.nextRunAt) : 'Paused') + (bot.lastStatus === 'error' ? ' · error' : '');
    main.appendChild(sub);
    const time = document.createElement('span');
    time.className = 'bot-time';
    time.textContent = botRelTime(bot);
    openEl.appendChild(avatar);
    openEl.appendChild(main);
    openEl.appendChild(time);
    // Kebab (⋮) menu, top-right of each bot card: Run now / Pause / Edit / Delete.
    const kebab = document.createElement('button');
    kebab.className = 'bot-kebab';
    kebab.type = 'button';
    kebab.title = 'Bot actions';
    kebab.setAttribute('aria-label', bot.name + ' actions');
    kebab.setAttribute('aria-haspopup', 'menu');
    kebab.setAttribute('aria-expanded', 'false');
    kebab.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
    kebab.addEventListener('click', e => {
      e.stopPropagation();
      openBotMenu(bot, kebab);
    });
  const open = () => selectBot(bot.id);
  item.addEventListener('click', open);
  openEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); open(); }
  });
  item.appendChild(openEl);
  item.appendChild(kebab);
  return item;
}

function bindBotToolbar() {
  const search = $('#botSearch');
  if (search) search.addEventListener('input', () => { botQuery = search.value.trim().toLowerCase(); renderBotList(); });
}

/* --- bot kebab menu --- */
let botMenuAnchor = null;   // kebab that opened the menu — carries aria-expanded

function hideBotMenu() {
  $('#botMenu').classList.add('hidden');
  if (botMenuAnchor) {
    botMenuAnchor.setAttribute('aria-expanded', 'false');
    botMenuAnchor = null;
  }
}

function openBotMenu(bot, anchor) {
  hideBotMenu();   // resets the previous anchor's aria-expanded on the way past
  const menu = $('#botMenu');
  menu.innerHTML = '';
  const running = bot.status === 'running';
  const botId = bot.id;
  const items = [
    { label: 'Run now', act: () => botAction('run', botId) },
    { label: running ? 'Pause' : 'Resume', act: () => botAction('toggle', botId) },
    { label: 'Edit', act: () => openBotModal(true, botId) },
    { label: 'Delete bot', act: () => botAction('del', botId), danger: true }
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'bot-menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { hideBotMenu(); it.act(); });
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  botMenuAnchor = anchor;
  if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  // Position below the kebab, right-aligned to it, clamped to the viewport.
  const r = anchor.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  requestAnimationFrame(() => {
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = '';
  });
}

function selectBot(id) {
  currentBotId = id;
  renderBotList();
  renderBotHeader();
  loadBotChat(false);
}

/**
 * The bots pane when no bot is open. Hiding the pane instead left a blank
 * right-hand panel that looked broken, so the slot always carries one card:
 * what a bot is, and (with no bots yet) the button that makes the first one.
 * Built from DOM nodes — copy is text, never markup.
 */
function renderBotEmptyState() {
  const box = $('#botMessages');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const logo = document.createElement('span');
  logo.className = 'logo';
  const title = document.createElement('h1');
  title.textContent = bots.length ? 'No bot selected' : 'Create your first bot';
  const line = document.createElement('p');
  line.className = 'muted small';
  line.textContent = 'A bot is a named task that runs on a schedule — give it one and the results land here while the app is open.';
  empty.appendChild(logo);
  empty.appendChild(title);
  empty.appendChild(line);
  if (!bots.length) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'primary';
    create.textContent = 'Create a bot';
    create.addEventListener('click', () => openBotModal(false));
    empty.appendChild(create);
  }
  box.appendChild(empty);
}

function renderBotHeader() {
  const bot = currentBot();
  const has = !!bot;
  $('#botTaskLine').classList.toggle('hidden', !has);
  $('#botComposer').classList.toggle('hidden', !has);
  if (!bot) { renderBotEmptyState(); return; }
  // Status panel: status pill, schedule, next run.
  const task = $('#botTaskLine');
  task.innerHTML = '';
  const top = document.createElement('div');
  top.className = 'task-top';
  const name = document.createElement('span');
  name.className = 'card-title';
  name.textContent = bot.name;
  const pills = document.createElement('span');
  pills.className = 'task-pills';
  const st = document.createElement('span');
  st.className = 'badge ' + (bot.status === 'running' ? 'ok' : '');
  st.textContent = bot.status === 'running' ? 'Running' : 'Paused';
  pills.appendChild(st);
  // Skills attached to this bot (app-wide ones apply anyway and are not listed).
  const ownSkills = Array.isArray(bot.skills) ? bot.skills : [];
  if (ownSkills.length && skillsState) {
    const known = ownSkills
      .map(id => (skillsState.skills || []).find(s => s.id === id))
      .filter(Boolean)
      .map(s => s.name);
    if (known.length) {
      const sk = document.createElement('span');
      sk.className = 'skill-badge';
      sk.title = 'Skills: ' + known.join(', ');
      sk.textContent = known.length === 1 ? known[0] : known.length + ' skills';
      pills.appendChild(sk);
    }
  }
  top.appendChild(name);
  top.appendChild(pills);
  const meta = document.createElement('div');
  meta.className = 'task-meta muted';
  meta.textContent = `${botIntervalLabel(bot.intervalSec)} · next ${botNextIn(bot.nextRunAt)}${bot.runCount ? ` · ${bot.runCount} runs` : ''}${bot.lastRunAt ? ` · last ${new Date(bot.lastRunAt).toLocaleString()}` : ''}`;
  const taskLabel = document.createElement('span');
  taskLabel.className = 'card-label';
  taskLabel.textContent = 'Task';
  const taskText = document.createElement('span');
  taskText.className = 'card-text';
  taskText.textContent = bot.task;
  task.appendChild(top);
  task.appendChild(meta);
  task.appendChild(taskLabel);
  task.appendChild(taskText);
  const input = $('#botInput');
  if (input && document.activeElement !== input) {
    input.placeholder = 'Tell your bot what to do — “run every 30 min”, “pause until Monday”, “do it now”… (Enter to send)';
  }
}

function botMsgNearBottom() {
  const box = $('#botMessages');
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 80;
}

async function loadBotChat(quiet) {
  const bot = currentBot();
  const box = $('#botMessages');
  if (!bot) { renderBotEmptyState(); return; }
  try {
    const r = await nexus.botChat(bot.id);
    if (!r.ok) throw new Error(r.error || 'Failed.');
    renderBotMessages(r.messages || [], true);
  } catch (e) {
    if (!quiet) toast('Could not load chat: ' + e.message, 'error');
  }
}

/* Turn-grouped message rendering: one .turn per speaker change, bot avatar
   once at the top of each bot turn, timestamps on their own mono line.
   Assistant text is painted through markdown.js (headings, lists, code);
   user text stays plain, and the turn keeps a Copy action outside .msg.
   Also guards against the duplicate-message data bug by dropping consecutive
   assistant messages with identical text. */
function renderTurnMessages(box, messages) {
  let turn = null;
  let turnBody = null;
  let turnRaw = null;        // the assistant turn's source text, for Copy
  let prevRole = null;
  let prevAssistantText = null;
  for (const m of messages) {
    if (m.role === 'action') {
      // Tool result chips — what the bot did to itself (schedule, task, …).
      const chip = document.createElement('div');
      chip.className = 'msg action';
      chip.textContent = m.content;
      box.appendChild(chip);
      continue;
    }
    if (m.role === 'tool') {
      // A tool call the assistant made, and what came back.
      box.appendChild(toolMessageEl(m));
      continue;
    }
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (role === 'assistant' && m.content === prevAssistantText) continue; // dedupe
    if (role === 'assistant') prevAssistantText = m.content; else prevAssistantText = null;
    if (role !== prevRole || !turn) {
      turn = document.createElement('div');
      turn.className = 'turn ' + role;
      if (role === 'assistant') {
        const av = document.createElement('span');
        av.className = 'turn-avatar';
        turn.appendChild(av);
      }
      const body = document.createElement('div');
      body.className = 'turn-body';
      turn.appendChild(body);
      turnBody = body;
      turnRaw = role === 'assistant' ? [] : null;
      if (turnRaw) turn.appendChild(turnActions(turnRaw));
      box.appendChild(turn);
      prevRole = role;
    }
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'user') {
      div.textContent = m.content;
    } else {
      renderMarkdownBlocks(div, m.content);
      if (turnRaw) turnRaw.push(m.content == null ? '' : String(m.content));
    }
    if (m.ts) {
      const t = document.createElement('span');
      t.className = 'msg-time';
      t.textContent = new Date(m.ts).toLocaleString();
      div.appendChild(t);
    }
    turnBody.appendChild(div);
  }
}

function renderBotMessages(messages, keepScroll) {
  const box = $('#botMessages');
  const stick = !keepScroll || botMsgNearBottom();
  box.innerHTML = '';
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div>Say hello below — and watch this space: every time your bot does its scheduled task, the result lands here.</div>';
    box.appendChild(empty);
    return;
  }
  renderTurnMessages(box, messages);
  if (stick) box.scrollTop = box.scrollHeight;
}

async function sendBotMessage() {
  const bot = currentBot();
  if (!bot || botSending) return;
  const input = $('#botInput');
  const sendBtn = $('#botSendBtn');
  const text = input.value.trim();
  if (!text) return;
  const botId = bot.id;
  botSending = true;
  input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  input.value = '';
  input.style.height = 'auto';
  // Optimistic user bubble + thinking indicator while the bot replies.
  const box = $('#botMessages');
  box.querySelector('.empty-state')?.remove();
  const mine = document.createElement('div');
  mine.className = 'msg user streak';
  mine.textContent = text;
  box.appendChild(mine);
  const thinking = document.createElement('div');
  thinking.className = 'msg assistant pending';
  thinking.textContent = 'Drafting reply…';
  box.appendChild(thinking);
  box.scrollTop = box.scrollHeight;
  try {
    const r = await nexus.botSend(botId, text);
    // Switched bots mid-flight: refresh list quietly, keep new view intact.
    if (currentBotId !== botId) { await loadBots(true); return; }
    if (!r.ok && !r.messages) throw new Error(r.error || 'Failed.');
    if (r.error) toast(r.error, 'error');
    renderBotMessages(r.messages || [], false);
    await loadBots(true);
  } catch (e) {
    if (currentBotId !== botId) { await loadBots(true).catch(() => {}); return; }
    thinking.textContent = '! ' + e.message;
    thinking.className = 'msg error';
  } finally {
    botSending = false;
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function botAction(act, id = currentBotId) {
  const bot = bots.find(b => b.id === id) || null;
  if (!bot || botBusy[bot.id]) return;
  if (act === 'del') {
    if (!confirm(`Delete "${bot.name}"? Its chat and history go with it.`)) return;
  }
  botBusy[bot.id] = true;
  try {
    let r;
    if (act === 'del') r = await nexus.removeBot(bot.id);
    else if (act === 'toggle') {
      r = await nexus.setBotStatus(bot.id, bot.status === 'running' ? 'paused' : 'running');
    } else if (act === 'run') {
      r = await nexus.runBot(bot.id);
      if (r.ok) toast('Bot run finished — the result lands in its chat.', 'ok');
    }
    if (!r.ok) throw new Error(r.error || 'Request failed.');
    if (act === 'del' && id === currentBotId) currentBotId = null;
    await loadBots(true);
    await loadBotChat(false);
  } catch (e) {
    toast(e.message, 'error');
    if (/provider/i.test(e.message)) activateTab('providers');
  } finally {
    botBusy[bot.id] = false;
    renderBotHeader();
  }
}

function openBotModal(edit, editId) {
  const bot = edit ? (editId ? bots.find(b => b.id === editId) || null : currentBot()) : null;
  // Only the first open of a run owns a return address: the Escape handler
  // closes this dialog even when it is already closed.
  const dlg = $('#botModal');
  if (dlg && dlg.classList.contains('hidden')) botReturnTo = stashReturnFocus(dlg);
  editingBotId = bot ? bot.id : null;
  $('#botModalTitle').textContent = bot ? 'Edit bot — ' + bot.name : 'New bot';
  $('#botName').value = bot ? bot.name : '';
  $('#botTask').value = bot ? bot.task : '';
  populateBotProviders();
  if (bot && bot.providerId) $('#botProvider').value = bot.providerId;
  populateBotModels();
  if (bot && bot.model) $('#botModel').value = bot.model;
  $('#botInterval').value = bot ? String(bot.intervalSec) : '3600';
  renderBotSkillPicker(bot);
  $('#botSubmitBtn').textContent = bot ? 'Save changes' : 'Create bot';
  $('#botFormError').textContent = '';
  $('#botModal').classList.remove('hidden');
  $('#botName').focus();
}

function closeBotModal() {
  const modal = $('#botModal');
  const wasOpen = modal && !modal.classList.contains('hidden');
  editingBotId = null;
  if (modal) modal.classList.add('hidden');
  // Escape calls this unconditionally, so only hand focus back if it was up.
  if (wasOpen) {
    const back = botReturnTo;
    botReturnTo = null;
    handBackFocus(back);
  }
}

/* --- per-bot skills picker --- */

/** Skills a bot carries on top of the app-wide ones (ids validated server-side). */
function renderBotSkillPicker(bot) {
  const host = $('#botSkillPicker');
  const hint = $('#botSkillHint');
  if (!host) return;
  const attached = new Set(Array.isArray(bot && bot.skills) ? bot.skills : []);
  const all = skillsState && Array.isArray(skillsState.skills) ? skillsState.skills : [];
  const global = (skillsState && skillsState.activeSkills) || [];
  host.innerHTML = '';
  if (!all.length) {
    const none = document.createElement('div');
    none.className = 'muted small';
    none.textContent = 'Skills are unavailable right now.';
    host.appendChild(none);
    if (hint) hint.textContent = '';
    return;
  }
  for (const s of all) {
    const on = attached.has(s.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skill-pick' + (on ? ' on' : '');
    btn.setAttribute('aria-pressed', String(on));
    btn.dataset.skillId = s.id;
    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = s.name;
    if (global.includes(s.id)) {
      const g = document.createElement('span');
      g.className = 'skill-badge global';
      g.textContent = 'Always on';
      name.appendChild(g);
    }
    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = s.blurb;
    meta.appendChild(name);
    meta.appendChild(desc);
    btn.appendChild(meta);
    btn.addEventListener('click', () => {
      const isOn = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', String(isOn));
    });
    host.appendChild(btn);
  }
  if (hint) hint.textContent = global.length
    ? 'Your ' + global.length + ' app-wide skill' + (global.length === 1 ? '' : 's') + ' apply to every bot — attach extras here for this one only.'
    : 'Pick skills for this bot, or switch some on app-wide on the Skills tab.';
}

/** Skill ids ticked in the modal. Globally active ones are applied anyway. */
function botModalSkillIds() {
  return $$('#botSkillPicker .skill-pick.on')
    .map(b => b.dataset.skillId)
    .filter(Boolean);
}

async function submitBotForm() {
  const errEl = $('#botFormError');
  const name = $('#botName').value.trim();
  const task = $('#botTask').value.trim();
  const providerId = $('#botProvider').value;
  const model = $('#botModel').value || null;
  const intervalSec = parseInt($('#botInterval').value, 10);
  const skills = botModalSkillIds();
  if (!name || !task) { errEl.textContent = 'Give your bot a name and describe its task.'; return; }
  if (!providerId) { errEl.textContent = 'Pick a provider — add one in the Providers tab first.'; return; }
  const allowedIntervals = [60, 300, 900, 3600, 21600, 86400, 604800];
  if (!allowedIntervals.includes(intervalSec)) { errEl.textContent = 'Pick a valid repeat interval.'; return; }
  errEl.textContent = '';
  $('#botSubmitBtn').disabled = true;
  try {
    let r;
    if (editingBotId) {
      r = await nexus.updateBot(editingBotId, { name, task, intervalSec, providerId, model, skills });
    } else {
      r = await nexus.createBot({ name, task, intervalSec, providerId, model, skills });
    }
    if (!r.ok) throw new Error(r.error || 'Failed to save bot.');
    const wasEdit = !!editingBotId;
    const savedId = editingBotId || (r.bot && r.bot.id);
    closeBotModal();
    $('#botName').value = '';
    $('#botTask').value = '';
    toast(wasEdit ? 'Bot updated.' : 'Bot created — say hello, its first scheduled run lands here within seconds.', 'ok');
    await loadBots(true);
    if (savedId) selectBot(savedId);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    $('#botSubmitBtn').disabled = false;
  }
}

/* ================================================================== */
/* Skills & plugins (prompt-level capabilities)                       */
/* ================================================================== */

const SKILLS_NOTE = 'Skills are text instructions added to the model’s system prompt — nothing is downloaded and no code runs. They apply to your chats and to any bot that has them attached.';

async function loadSkills() {
  try {
    skillsState = await nexus.skillsState();
  } catch {
    skillsState = null; // skills unavailable — the rest of the app still works
  }
  renderSkills();
}

/** Flash a "Saved" pill so instant-save switches feel confirmed. */
function flashSaved(el) {
  if (!el) return;
  el.classList.add('on');
  clearTimeout(el._savedTimer);
  el._savedTimer = setTimeout(() => el.classList.remove('on'), 1600);
}

async function saveSkills(patch) {
  try {
    const r = await nexus.setSkills(patch);
    if (!r.ok) throw new Error(r.error || 'Could not save skills.');
    skillsState = { ...(skillsState || {}), ...r };
    renderSkills();
    flashSaved($('#skillsSaved'));
    return true;
  } catch (e) {
    toast('Could not save skills: ' + ((e && e.message) || e), 'error');
    return false;
  }
}

/** Turn a whole pack on/off. Individually enabled members are folded away, so
 *  switching a pack off can't leave a stray skill behind. */
function setPluginEnabled(packId, on) {
  if (!skillsState) return;
  const pack = (skillsState.plugins || []).find(p => p.id === packId);
  if (!pack) return;
  const plugins = new Set(skillsState.enabledPlugins || []);
  const skills = new Set(skillsState.enabledSkills || []);
  for (const sid of pack.skills) skills.delete(sid);
  if (on) plugins.add(packId); else plugins.delete(packId);
  saveSkills({ plugins: [...plugins], skills: [...skills] });
}

/** Turn one skill on/off. Whenever the skill belongs to an enabled pack, the
 *  pack is dropped and its other members are kept on explicitly — otherwise the
 *  pack would keep the skill active and the individual switch would bounce back. */
function setSkillEnabled(skillId, on) {
  if (!skillsState) return;
  const pack = (skillsState.plugins || []).find(p => (p.skills || []).includes(skillId));
  let plugins = [...(skillsState.enabledPlugins || [])];
  const skills = new Set(skillsState.enabledSkills || []);
  if (pack && plugins.includes(pack.id)) {
    plugins = plugins.filter(id => id !== pack.id);
    for (const sid of pack.skills) if (sid !== skillId) skills.add(sid);
  }
  if (on) skills.add(skillId); else skills.delete(skillId);
  saveSkills({ plugins, skills: [...skills] });
}

function renderSkills() {
  const grid = $('#pluginGrid');
  const listEl = $('#skillList');
  if (!grid || !listEl) return;
  const note = $('#skillsNote');
  if (note) note.textContent = SKILLS_NOTE;
  grid.innerHTML = '';
  listEl.innerHTML = '';
  if (!skillsState) {
    const msg = document.createElement('div');
    msg.className = 'empty-panel';
    msg.textContent = 'Skills are unavailable right now.';
    listEl.appendChild(msg);
    return;
  }
  const active = skillsState.activeSkills || [];
  const enabledPacks = skillsState.enabledPlugins || [];
  const packFor = id => (skillsState.plugins || []).find(p => p.id === id);

  // --- packs ---
  for (const p of skillsState.plugins || []) {
    const on = enabledPacks.includes(p.id);
    const card = document.createElement('div');
    card.className = 'card plugin-card';
    const head = document.createElement('div');
    head.className = 'plugin-head';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'plugin-name';
    name.textContent = p.name;
    const tagline = document.createElement('p');
    tagline.className = 'plugin-tagline';
    tagline.textContent = p.tagline || '';
    info.appendChild(name);
    info.appendChild(tagline);
    const side = document.createElement('div');
    side.className = 'plugin-side';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (on ? 'ok' : '');
    badge.textContent = on ? 'On' : 'Off';
    const toggle = document.createElement('label');
    toggle.className = 'skill-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.setAttribute('aria-label', 'Enable ' + p.name);
    box.addEventListener('change', () => setPluginEnabled(p.id, box.checked));
    toggle.appendChild(box);
    toggle.appendChild(document.createTextNode('Enable'));
    side.appendChild(badge);
    side.appendChild(toggle);
    head.appendChild(info);
    head.appendChild(side);
    card.appendChild(head);
    const count = document.createElement('p');
    count.className = 'muted small';
    count.textContent = p.skillCount + ' skill' + (p.skillCount === 1 ? '' : 's');
    card.appendChild(count);
    grid.appendChild(card);
  }

  // --- every skill ---
  const q = skillQuery;
  const list = (skillsState.skills || []).filter(s => !q
    || (s.name + ' ' + s.blurb + ' ' + s.category + ' ' + s.id).toLowerCase().includes(q));
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-panel';
    empty.textContent = 'No skills match “' + skillQuery + '”.';
    listEl.appendChild(empty);
  }
  for (const s of list) {
    const on = active.includes(s.id);
    const row = document.createElement('div');
    row.className = 'skill-row' + (on ? '' : ' off');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.setAttribute('aria-label', 'Enable ' + s.name);
    box.addEventListener('change', () => setSkillEnabled(s.id, box.checked));
    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.appendChild(document.createTextNode(s.name));
    const cat = document.createElement('span');
    cat.className = 'skill-badge';
    cat.textContent = s.category;
    name.appendChild(cat);
    if (on) {
      const tag = document.createElement('span');
      tag.className = 'skill-badge global';
      tag.textContent = 'Active';
      name.appendChild(tag);
    }
    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    const pack = packFor(s.plugin);
    desc.textContent = s.blurb + (pack ? ' · ' + pack.name : '');
    meta.appendChild(name);
    meta.appendChild(desc);
    row.appendChild(box);
    row.appendChild(meta);
    listEl.appendChild(row);
  }

  const sum = $('#skillsSummary');
  if (sum) {
    sum.textContent = active.length
      ? active.length + ' skill' + (active.length === 1 ? '' : 's') + ' active — used by chats and by every bot that has them attached.'
      : 'No skills active — chats and bots use your system prompt only.';
  }
}

function bindSkills() {
  const search = $('#skillSearch');
  if (search) search.addEventListener('input', () => { skillQuery = search.value.trim().toLowerCase(); renderSkills(); });
}

/* ================================================================== */
/* Intro / onboarding — first launch only (settings.introDone)        */
/* ================================================================== */
/* ---------------- updates ----------------
 * The pill in the sidebar's bottom-left is permanent: it shows the running
 * version, turns into an install action once a newer official release has
 * been verified available, and carries the download progress. The launch
 * popup is a one-time nudge per release version — "Later" (or Escape)
 * remembers the version, so the same update never interrupts again.
 * All the deciding happens in the main process; the renderer only paints. */

let updateInfo = null;   // verified decision from update:check, null = up to date
let updateBusy = false;

function paintUpdatePill() {
  const pill = $('#updatePill');
  const text = $('#updatePillText');
  if (!pill || updateBusy) return;
  if (updateInfo && updateInfo.updateAvailable) {
    pill.classList.add('available');
    pill.title = 'Install version ' + updateInfo.latest;
    text.textContent = 'v' + updateInfo.latest + ' · Install';
  } else {
    pill.classList.remove('available');
    pill.title = 'Check for updates';
    text.textContent = appInfo && appInfo.version ? 'v' + appInfo.version : 'Updates';
  }
}

async function checkForUpdates(atLaunch) {
  let info;
  try { info = await nexus.updateCheck(); } catch { return; }
  if (!info) return;
  // Source checkout / CI: no install to replace, so nothing to install.
  if (info.skipped) {
    if (!atLaunch) {
      // Send them to where the real builds live instead of a dead end.
      try { await nexus.updateOpenRelease(); } catch { /* no browser at hand */ }
      toast('Updates are installed only in the packaged app — opened the releases page instead.', 'info');
    }
    return;
  }
  updateInfo = info.updateAvailable ? info : null;
  paintUpdatePill();
  if (atLaunch) { maybePromptUpdate(); return; }
  if (!info.checked) toast('Could not reach GitHub to check for updates.', 'warn');
  else if (!info.updateAvailable) toast('You are on the latest version (v' + info.current + ').', 'ok');
  // An update found by a manual check paints itself on the pill.
}

function maybePromptUpdate() {
  if (!updateInfo || !updateInfo.updateAvailable) return;
  if (!state.settings.introDone) return;                          // first-run intro owns the screen
  const bg = $('#bgModal');
  if (bg && !bg.classList.contains('hidden')) return;             // background-mode prompt is up
  if (helpIsOpen()) return;                                       // the guide owns Escape
  if (state.settings.dismissedUpdate === updateInfo.latest) return; // asked once for this version
  const modal = $('#updateModal');
  if (!modal.classList.contains('hidden')) return;
  updateReturnTo = stashReturnFocus(modal);
  $('#updateModalBody').textContent = 'Version ' + updateInfo.latest
    + ' is ready to install — you are on ' + updateInfo.current + '.';
  modal.classList.remove('hidden');
  // The install is the point of the prompt, so that is where focus lands.
  const install = $('#updateInstallBtn');
  if (install && install.focus) install.focus();
}

function closeUpdateModal() {
  const modal = $('#updateModal');
  const wasOpen = !modal.classList.contains('hidden');
  modal.classList.add('hidden');
  if (wasOpen) {
    const back = updateReturnTo;
    updateReturnTo = null;
    handBackFocus(back);
  }
}

async function dismissUpdateModal() {
  closeUpdateModal();
  if (!updateInfo) return;
  try {
    // Persisted per version: the next release prompts again, this one never does.
    state.settings = await nexus.updateSettings({ dismissedUpdate: updateInfo.latest });
  } catch { /* next launch will ask again */ }
}

async function runUpdateInstall() {
  if (updateBusy) return;
  updateBusy = true;
  const pill = $('#updatePill');
  const text = $('#updatePillText');
  pill.classList.add('busy');
  text.textContent = 'Starting…';
  let res = null;
  try { res = await nexus.updateInstall(); } catch { res = null; }
  if (res && res.ok) { text.textContent = 'Installing…'; return; } // app is on its way out
  updateBusy = false;
  pill.classList.remove('busy');
  paintUpdatePill();
  if (res && res.reason === 'unsupported') {
    await nexus.updateOpenRelease();
    toast('This build installs from the release page — opened in your browser.', 'info');
  } else if (res && res.reason === 'cancelled') {
    /* the native dialog already said it */
  } else if (res && (res.reason === 'checksum' || res.reason === 'no-checksums')) {
    toast('The update could not be verified, so it was not installed. Get it from the release page instead.', 'warn');
  } else if (res && res.reason === 'download') {
    toast('The update download failed — try again.', 'warn');
  } else if (res && res.reason === 'no-update') {
    updateInfo = null;
    paintUpdatePill();
  } else {
    toast('The update could not be started.', 'warn');
  }
}

function setUpdateProgress({ phase, percent } = {}) {
  if (!updateBusy) return;
  $('#updatePillText').textContent = phase === 'download'
    ? 'Downloading… ' + (percent || 0) + '%'
    : phase === 'verify' ? 'Verifying…' : 'Installing…';
}

function bindUpdates() {
  $('#updatePill').addEventListener('click', () => {
    if (updateBusy) return;
    if (updateInfo && updateInfo.updateAvailable) runUpdateInstall();
    else checkForUpdates(false);
  });
  $('#updateInstallBtn').addEventListener('click', () => { closeUpdateModal(); runUpdateInstall(); });
  $('#updateLaterBtn').addEventListener('click', dismissUpdateModal);
  if (nexus.onUpdateProgress) nexus.onUpdateProgress(setUpdateProgress);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = $('#updateModal');
    if (modal.classList.contains('hidden')) return;
    if (!$('#toolModal').classList.contains('hidden')) return;   // permission prompt keeps Escape
    dismissUpdateModal();                                        // Escape = Later, never a trap
  });
}

function maybeShowIntro(done) {
  const finish = () => {
    const el = $('#intro');
    if (el) el.classList.add('hidden');
    if (done) done();
  };
  if (!state.settings.introDone) {
    const intro = $('#intro');
    if (!intro) { finish(); return; }
    introReturnTo = stashReturnFocus(intro);
    intro.classList.remove('hidden');
    const openPrimary = $('#introNextBtn');
    if (openPrimary && openPrimary.focus) openPrimary.focus();
    const showStep = (n) => {
      $('#introStep1').classList.toggle('on', n === 1);
      $('#introStep2').classList.toggle('on', n === 2);
      // The primary action of the step on screen is where Tab starts.
      const primary = $(n === 1 ? '#introNextBtn' : '#introDoneBtn');
      if (primary && primary.focus) primary.focus();
    };
    $('#introNextBtn').addEventListener('click', () => showStep(2));
    const closeIntro = async (gotoProviders) => {
      if (intro.classList.contains('hidden')) return;   // already answered
      try { state.settings = await nexus.updateSettings({ introDone: true }); } catch { /* already shown */ }
      // Hand focus back before the next overlay opens — done() chains the
      // background prompt, which stashes whatever is focused right now.
      const back = introReturnTo;
      introReturnTo = null;
      handBackFocus(back);
      if (!back && !gotoProviders && $('#input')) $('#input').focus();
      finish();
      if (gotoProviders) activateTab('providers');
    };
    $('#introDoneBtn').addEventListener('click', () => closeIntro(false));
    $('#introProvidersBtn').addEventListener('click', () => closeIntro(true));
    $('#introSkipBtn').addEventListener('click', () => closeIntro(false));
    // Escape = the skipping action, wired on the dialog itself (focus lives
    // inside it) and inert the moment it is hidden.
    intro.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (intro.classList.contains('hidden')) return;
      e.preventDefault();
      closeIntro(false);
    });
  } else {
    finish();
  }
}

/* ================================================================== */
/* Background mode — first-launch prompt + Settings toggle            */
/* ================================================================== */
function maybeShowBackgroundPrompt() {
  if (state.settings.runInBackground !== null && state.settings.runInBackground !== undefined) return;
  const modal = $('#bgModal');
  bgReturnTo = stashReturnFocus(modal);
  modal.classList.remove('hidden');
  // The answer is written asynchronously, so one flag keeps a fast second
  // Escape (or a click straight after) from submitting the choice twice.
  let answered = false;
  const answer = (on) => {
    if (answered) return;
    answered = true;
    setBackgroundMode(on, true);
  };
  $('#bgYesBtn').addEventListener('click', () => answer(true), { once: true });
  $('#bgNoBtn').addEventListener('click', () => answer(false), { once: true });
  // Declining is the negative action, so it is the one that takes focus —
  // and the dialog would otherwise be a keyboard dead end.
  const decline = $('#bgNoBtn');
  if (decline && decline.focus) decline.focus();
  modal.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (answered || modal.classList.contains('hidden')) return;
    e.preventDefault();
    answer(false);
  });
}

async function setBackgroundMode(on, fromPrompt) {
  state.settings = await nexus.updateSettings({ runInBackground: on });
  if (fromPrompt) {
    $('#bgModal').classList.add('hidden');
    const back = bgReturnTo;
    bgReturnTo = null;
    handBackFocus(back);
  }
  renderBackgroundSetting();
  toast(on
    ? 'Background mode on — closing the window keeps your bots working.'
    : 'Background mode off — bots run only while the app is open.', 'ok');
  if (fromPrompt) maybePromptUpdate();   // the update nudge was waiting its turn
}

function renderBackgroundSetting() {
  const on = state.settings.runInBackground === true;
  $('#bgOnBtn').className = on ? 'primary' : 'ghost';
  $('#bgOffBtn').className = !on ? 'primary' : 'ghost';
  $('#bgStatus').textContent = on ? 'On — app stays in the tray on close' : 'Off — app quits on close';
}

/* ================================================================== */
/* Help window                                                        */
/*                                                                    */
/* One window instead of a paragraph under every heading: each `?`     */
/* opens this dialog on its own topic, and F1 opens the whole guide.   */
/* ================================================================== */

const HELP_TOPICS = [
  {
    id: 'welcome',
    group: 'Start here',
    kicker: 'Local by design',
    title: 'Welcome to NexusChat Open',
    lead: 'One desktop app for chat and scheduled bots — everything runs on this PC, with your own provider key.',
    bullets: [
      'Free and open source: no accounts, no subscriptions, no servers — the app never phones home.',
      'You bring your own key: OpenAI, xAI, Anthropic, Gemini, Mistral, Groq, DeepSeek, OpenRouter, Nous… or Ollama for fully local models.',
      'Chats stream live; bots run on schedule while the window is open (or in the tray).',
      'Your keys are encrypted at rest and stay on this machine.'
    ],
    footer: 'The Skills tab tunes how models answer; the Help chip (or F1) brings you back here.'
  },
  {
    id: 'chat',
    group: 'Start here',
    kicker: 'Chat & models',
    title: 'Chat and models',
    lead: 'Every conversation runs on a model you pick, with a key you own.',
    bullets: [
      'New chat starts a fresh conversation. The sidebar keeps every chat and removes one with its ✕ button.',
      'Under the composer, one line names where the chat works — This PC or a saved host, then the folder. Green means the host just answered. Connect attaches the chat; tools then run on that host when they are on.',
      'The picker above the composer opens a searchable list of every model you have set up — type a few letters, move with the arrow keys, press Enter to choose. The header line above the chat always shows who is answering.',
      'The refresh button next to it re-reads the list whenever a provider adds new models.',
      'Regenerate replays the last answer; Stop cuts a reply short while it is still streaming.',
      'Enter sends, Shift + Enter adds a line, and Ctrl + N starts a new chat from anywhere.'
    ],
    footer: 'The app calls the provider straight from this PC — nothing routes through anyone else.'
  },
  {
    id: 'generation',
    group: 'Chat',
    kicker: 'System prompt & temperature',
    title: 'System prompt, temperature and tokens',
    lead: 'Settings → Generation shapes how every reply is written.',
    bullets: [
      'Default system prompt — standing instructions prepended to each new chat.',
      'Temperature — 0 keeps answers focused and repeatable, 2 is wild. 0.7 ships as the default.',
      'Max tokens — leave it blank and the provider picks the limit.'
    ]
  },
  {
    id: 'bots',
    group: 'Bots',
    kicker: 'Scheduled workers',
    title: 'How bots work',
    lead: 'A bot is a named task that runs on a schedule and reports back in its own chat.',
    bullets: [
      'Each bot runs its task every interval you pick — from every minute to weekly — and posts the result in its chat window.',
      'Bots run while NexusChat is open; with “Run in background” on, they keep going while the window sits in the tray.',
      'Talk to a bot in its chat: ask about its last run, or say “run every 15 minutes”, “pause for now” or “do it now” and it applies the change itself.',
      'Run now / Pause / Edit / Delete live in the ⋮ menu on each bot card.',
      'Bots survive restarts and catch up on missed runs.'
    ],
    footer: 'Every bot uses a provider you configured — its results land in the bot chat, not your conversations.'
  },
  {
    id: 'bot-form',
    group: 'Bots',
    kicker: 'New bot',
    title: 'Creating a bot',
    lead: 'Name it, give it a task, choose when it runs — everything else happens in the bot chat.',
    bullets: [
      'Bot name — unique, shown in the sidebar.',
      'Task — the instruction it runs every time, sent to the model as the message.',
      'Provider & model — which model answers this bot.',
      'Repeat every — from every minute to weekly.',
      'Skills for this bot — extra instruction blocks on top of the app-wide ones.'
    ],
    footer: 'The bot manages itself: say “run every 15 minutes”, “pause for now” or “do it now” in its chat and it applies the change.'
  },
  {
    id: 'background',
    group: 'Bots',
    kicker: 'Background & tray',
    title: 'Bots that keep running',
    lead: 'Bots only work while NexusChat is running.',
    bullets: [
      'Run in background — closing the window hides the app to the system tray and your bots keep working. Reopen it from the tray icon.',
      'Quit on close — the app exits completely when you close the window.'
    ],
    footer: 'Change it any time in Settings → Background.'
  },
  {
    id: 'skills',
    group: 'Skills',
    kicker: 'Packs for the prompt',
    title: 'Skills & plugins',
    lead: 'Skills are instruction blocks added to the system prompt of your chats and your bots.',
    bullets: [
      'A plugin is a pack of related skills — enable the whole pack, or switch individual skills on.',
      'Nothing is downloaded and no code runs: a skill is only text the model reads.',
      'The text is capped and stripped of anything that could act like a tool directive, so a skill can shape style but never hijack a bot.',
      'App-wide skills apply everywhere; a skill attached to one bot applies only in that bot.'
    ],
    footer: 'Enable packs on the Skills tab; attach extras to a single bot in its edit dialog.'
  },
  {
    id: 'providers',
    group: 'Keys & providers',
    kicker: 'Bring your own key',
    title: 'Providers and your keys',
    lead: 'NexusChat Open never sells model access. Paste a provider key in Providers and the app talks to that provider directly.',
    bullets: [
      'Every provider you add is available everywhere — chats and bots alike.',
      'Save & connect does the whole handover in one click: the key or URL is stored, the provider’s model list is fetched, and the composer switches to that model.',
      'The app calls the provider from this PC — nothing is routed through anyone else.',
      'Keys are encrypted at rest and stay on this machine.',
      'Local providers (Ollama, LM Studio) need no key at all — they answer from this PC and work with Wi-Fi off.',
      'Every provider’s base URL and model list are editable, so endpoints can be fixed without a new build.'
    ],
    footer: 'Pick a model in the composer’s searchable picker, and refresh the list whenever a provider adds new ones.'
  },
  {
    id: 'agent',
    group: 'Assistant',
    kicker: 'Tools on your machine',
    title: 'Letting the assistant use tools',
    lead: 'With tools on, the assistant can read and change files in one folder, run your commands, and — if you allow it — fetch a URL.',
    bullets: [
      'Turn tools on, then choose a workspace: exactly one folder. Every file tool stays inside it. ".." cannot climb out, and a symlink pointing elsewhere is refused.',
      'Or attach the chat to a saved SSH host instead: the bar under the chat names the host and folder, and the same tools run there — reads, edits, search, git and shell commands alike.',
      'Reads (read_file, list_dir, search_files, grep_files, file_info, diff_files, project_info, git_status/diff/log/show) run without a prompt and leave a row in the chat.',
      'Writes (write_file, edit_file, multi_edit, append_file, create_dir, move_file, copy_file, git stage/commit/branch) always ask first, with the change shown before you answer.',
      'Deletes, shell commands and network calls always ask too — and are never remembered, whatever you answer.',
      '“Allow for this session” is only offered for file writes, and only for the folder it names. “Forget remembered approvals” clears the lot.',
      'The Tools switch above the composer decides whether a chat may use them at all.',
      'Ask it to find, run or check something and it does the work itself, then shows the result in the chat — file tools stay in the workspace, and anything beyond it goes through a shell command you approve first.',
      'Tool output is text: nothing a file contains is ever executed.'
    ],
    footer: 'Tools stay off until you turn them on, and nothing is ever accepted automatically.'
  },
  {
    id: 'settings',
    group: 'Settings',
    kicker: 'What each section does',
    title: 'Settings at a glance',
    lead: 'Tune generation, appearance, background behaviour and data. Changes save the moment you make them.',
    bullets: [
      'Generation — system prompt, temperature, max tokens.',
      'Appearance — dark or light theme.',
      'Background — tray behaviour for your bots.',
      'Updates — the pill at the bottom of the chat sidebar shows your version; when a newer official release exists it installs it, checksum-verified.',
      'SSH — saved hosts, a command runner, a file browser and a connection self-test.',
      'Data — the portable data folder, chat backup and restore-defaults.'
    ],
    footer: 'Lost? Press F1 anywhere for this window.'
  },
  {
    id: 'ssh',
    group: 'Settings',
    kicker: 'Remote shells',
    title: 'SSH from the app',
    lead: 'Settings → SSH runs commands and reads files on machines you already reach with ssh — and the assistant can too, through its SSH tool.',
    bullets: [
      'Save a host (name, user, port, optional key file). The host box also takes user@host:port or ssh://user@host:port pastes. Only saved hosts are reachable — the assistant is asked before every call and can never type a host of its own.',
      'The line under each chat composer attaches it to a saved host and folder, and shows whether the host answers; the runner, browser and self-test here are where hosts are added and checked.',
      'The runner executes a command with your own ssh settings — your agent, keys and ~/.ssh/config all apply. Pick a timeout, recall past commands with Up/Down, and copy or clear the output. Output and exit status come back under the command with a hint when it fails.',
      'Browse lists a remote directory with sizes and dates; filter narrows it, breadcrumbs and Home/Up move around. Preview reads a file (binary files are detected, not dumped); Save to workspace copies it over with a size cap.',
      'Run self-test scores the connection 0–100 from the effective config, your known_hosts, key permissions and one read-only probe, and prints a Host block you can paste into ~/.ssh/config. The score stays on the host row.',
      'Passwordless only: passwords are never stored or sent, so password-only accounts cannot connect from here — add a key first, exactly as you would in a terminal.'
    ],
    footer: 'Everything runs through the OpenSSH client already on this machine — no bundled server, no background daemon.'
  },
  {
    id: 'data',
    group: 'Settings',
    kicker: 'Portable by design',
    title: 'Data, backup and reset',
    lead: 'Chats, bots, keys and settings live in one portable data folder on this PC.',
    bullets: [
      'Open data folder — where everything is stored. Copy it to move the app to another machine.',
      'Export chats writes a JSON backup; Import chats restores one.',
      'Restore default settings resets theme, temperature and skills. Your provider API keys and chats are kept.'
    ]
  },
  {
    id: 'shortcuts',
    group: 'Settings',
    kicker: 'Handy keys',
    title: 'Keyboard shortcuts',
    lead: 'Every shortcut, in one place.',
    bullets: [
      'Enter — send the message.',
      'Shift + Enter — new line in the composer.',
      'Ctrl + N — new chat.',
      'F1 — open or close this window.',
      'Esc — close a dialog, a menu or this window.',
      'Tab and the arrow keys — move around the controls and this topic list.'
    ]
  }
];


let helpTopicId = null;
let helpReturnTo = null;   // element focus returns to when the guide closes

function helpTopic(id) {
  return HELP_TOPICS.find(t => t.id === id) || null;
}

/** The topic menu: grouped buttons, the open topic marked. */
function renderHelpMenu() {
  const nav = $('#helpTopics');
  if (!nav) return;
  nav.textContent = '';
  let group = null;
  for (const t of HELP_TOPICS) {
    if (t.group !== group) {
      group = t.group;
      const head = document.createElement('div');
      head.className = 'help-group';
      head.textContent = group;
      nav.appendChild(head);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-topic' + (t.id === helpTopicId ? ' on' : '');
    btn.dataset.helpTopic = t.id;
    btn.textContent = t.kicker || t.title;
    btn.setAttribute('aria-current', String(t.id === helpTopicId));
    btn.addEventListener('click', () => showHelpTopic(t.id));
    nav.appendChild(btn);
  }
}

/** Paint one topic into the reading pane. Text only — never interpolated HTML. */
function showHelpTopic(id) {
  const topic = helpTopic(id) || HELP_TOPICS[0];
  helpTopicId = topic.id;
  const title = $('#helpTopicTitle');
  const body = $('#helpBody');
  if (!title || !body) return;
  title.textContent = topic.title;
  body.textContent = '';
  if (topic.lead) {
    const lead = document.createElement('p');
    lead.className = 'help-lead';
    lead.textContent = topic.lead;
    body.appendChild(lead);
  }
  for (const line of topic.lines || []) {
    const p = document.createElement('p');
    p.className = 'help-line';
    p.textContent = line;
    body.appendChild(p);
  }
  if (topic.bullets && topic.bullets.length) {
    const ul = document.createElement('ul');
    ul.className = 'help-bullets';
    for (const b of topic.bullets) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (topic.footer) {
    const note = document.createElement('p');
    note.className = 'help-note muted small';
    note.textContent = topic.footer;
    body.appendChild(note);
  }
  body.scrollTop = 0;
  $$('#helpTopics .help-topic').forEach(b => {
    const on = b.dataset.helpTopic === topic.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', String(on));
  });
}

function helpIsOpen() {
  const modal = $('#helpModal');
  return !!modal && !modal.classList.contains('hidden');
}

/** Open the guide window — optionally straight on one topic (? buttons, F1). */
function openHelp(id) {
  const modal = $('#helpModal');
  if (!modal) return;
  // Remember where the user came from so the window hands focus back.
  const active = document.activeElement;
  if (!helpIsOpen() && active && active !== modal) helpReturnTo = active;
  helpTopicId = null;
  renderHelpMenu();
  showHelpTopic(id || HELP_TOPICS[0].id);
  modal.classList.remove('hidden');
  const close = $('#helpCloseBtn');
  if (close && close.focus) close.focus();
}

function closeHelp() {
  const modal = $('#helpModal');
  if (modal) modal.classList.add('hidden');
  const back = helpReturnTo;
  helpReturnTo = null;
  if (back && back.focus) back.focus();
}

function bindHelp() {
  const modal = $('#helpModal');
  if (!modal) return;
  const close = $('#helpCloseBtn');
  const done = $('#helpDoneBtn');
  if (close) close.addEventListener('click', closeHelp);
  if (done) done.addEventListener('click', closeHelp);
  // Clicking the dimmed backdrop closes the window, like every other dialog.
  modal.addEventListener('click', e => { if (e.target === modal) closeHelp(); });
  // Every "?" in the shell opens this window on its own topic.
  $$('[data-help]').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    openHelp(el.dataset.help);
  }));
  // The topic menu behaves like a menu: the arrows walk the list.
  const nav = $('#helpTopics');
  if (nav) nav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = $$('#helpTopics .help-topic');
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
  });
  document.addEventListener('keydown', e => {
    // Escape closes the guide first; nothing behind it should react to it.
    if (e.key === 'Escape' && helpIsOpen()) {
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      closeHelp();
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault();
      if (helpIsOpen()) closeHelp();
      else openHelp(helpTopicId || HELP_TOPICS[0].id);
    }
  });
}

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */

function applyTheme(theme) {
  // Unknown or missing values fall back to dark — the shipped default and what
  // the theme dropdown shows — so the UI can never disagree with the setting.
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/* The top-bar toggle mirrors Settings → Appearance: same setting, one click.
 * The dropdown stays the source of truth for tests and screenshots; this
 * just flips it and keeps both controls saying the same thing. */
function currentTheme() {
  const doc = document.documentElement;
  const theme = doc && doc.dataset ? doc.dataset.theme : null;
  return theme === 'light' ? 'light' : 'dark';
}

function syncThemeToggle() {
  const btn = $('#themeToggleBtn');
  if (!btn) return;
  const theme = currentTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  const name = next === 'light' ? 'light' : 'dark';
  btn.title = 'Switch to ' + name + ' theme';
  if (btn.setAttribute) btn.setAttribute('aria-label', 'Switch to ' + name + ' theme');
  const label = $('#themeToggleLabel');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
}

async function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  syncThemeToggle();
  const sel = $('#themeSelect');
  if (sel) sel.value = next;
  await saveSetting({ theme: next });
  // saveSetting replaces state.settings wholesale — repaint from what stuck.
  applyTheme(state.settings.theme);
  syncThemeToggle();
}

function bindThemeToggle() {
  const btn = $('#themeToggleBtn');
  if (!btn) return;
  btn.addEventListener('click', toggleTheme);
  syncThemeToggle();
}

const MAX_TOASTS = 4;

function toast(message, kind = 'info') {
  const host = $('#toasts');
  // Cap the stack: a burst of failures (or a poll loop) must not bury the UI.
  while (host.children.length >= MAX_TOASTS) host.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

boot().catch(err => {
  console.error(err);
  document.body.textContent = '';
  const div = document.createElement('div');
  div.textContent = 'Failed to start: ' + String((err && err.message) || err);
  div.style.padding = '40px';
  div.style.fontFamily = 'sans-serif';
  div.style.color = '#888';
  document.body.appendChild(div);
});

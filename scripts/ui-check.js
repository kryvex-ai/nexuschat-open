'use strict';
/**
 * Live UI checks — the half of the app a headless `npm test` cannot reach.
 *
 * Boots nothing itself: it attaches to a running window through the Chrome
 * DevTools Protocol (the run-linux.sh "ui" mode starts one, on a throwaway
 * profile, and shuts it down again). It then does what a person would do —
 * switches tabs, opens Settings, asks the bridge a question — and reads what
 * the real renderer drew, plus round trips through preload, IPC and the main
 * process.
 *
 * Every check is an assertion about the DOM or an answer that came back over
 * IPC, so this either passes or it does not.
 *
 *   npm run ui:check
 *   NEXUS_CDP_PORT=9333 npm run ui:check   # if 9222 is taken
 */
const PORT = Number(process.env.NEXUS_CDP_PORT || 9222);
const BASE = 'http://127.0.0.1:' + PORT;
const EXPECTED_VERSION = require('../package.json').version;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  const shown = detail === undefined ? '' : '  — ' + String(detail).replace(/\s+/g, ' ').slice(0, 90);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + shown);
};

/** Wait for the app's window to announce itself on CDP. */
async function waitForPage(timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page;
    } catch { /* still booting, or not up yet */ }
    if (Date.now() > until) return null;
    await sleep(400);
  }
}

/** A minimal CDP client: send commands, collect events, evaluate in the page. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot reach the renderer')); });
  let seq = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      done(msg);
      return;
    }
    for (const fn of listeners.get(msg.method) || []) fn(msg.params);
  };
  const call = (method, params) => new Promise((res) => {
    const id = ++seq;
    waiting.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]);
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const r = reply.result || {};
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      throw new Error(String(ex.description || r.exceptionDetails.text || 'evaluate failed').split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  };
  return { call, evaluate, on, close: () => ws.close() };
}

(async () => {
  const page = await waitForPage(30000);
  if (!page) { console.log('FAIL  the app never appeared on CDP :' + PORT); process.exit(1); }
  const client = await attach(page.webSocketDebuggerUrl);

  // Anything the page throws while we poke at it is a failure of this run.
  await client.call('Runtime.enable');
  const crashes = [];
  client.on('Runtime.exceptionThrown', (p) => {
    const d = (p && p.exceptionDetails) || {};
    const ex = (d.exception && d.exception.description) || d.text || 'renderer exception';
    crashes.push(String(ex).split('\n')[0]);
  });

  const shell = JSON.parse(await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('#tabs .tab')].map(b => b.dataset.tab);
    return JSON.stringify({
      tabs,
      visibleViews: [...document.querySelectorAll('main > section, .view')]
        .filter(el => el.offsetParent !== null || el.classList.contains('active')).length,
      bridge: typeof nexus === 'object' && typeof nexus.send === 'function'
    });
  })()`));
  check('the shell drew its tabs', shell.tabs.length === 5, shell.tabs.join(','));
  check('the local-only tabs are on screen',
    ['chat', 'bots', 'skills', 'providers', 'settings'].every(t => shell.tabs.includes(t)), shell.tabs.join(','));
  check('no account tab', !shell.tabs.includes('account'));
  check('a view is on screen', shell.visibleViews >= 1, shell.visibleViews);
  check('the preload bridge is there', shell.bridge === true);

  // The window must be the build in package.json — a release that bumps the
  // version but boots the previous one is exactly the mistake worth catching.
  const running = JSON.parse(await client.evaluate(
    `(async () => JSON.stringify(await nexus.appInfo()))()`
  ));
  check('the running app is package.json\'s version', running.version === EXPECTED_VERSION,
    running.version + ' (package.json says ' + EXPECTED_VERSION + ')');

  // Settings: the surviving panels are drawn, the removed ones are gone.
  await client.evaluate(`document.querySelector('[data-tab="settings"]').click()`);
  await sleep(150);
  const settings = JSON.parse(await client.evaluate(`(() => {
    const g = (id) => document.getElementById(id);
    return JSON.stringify({
      generation: !!g('sec-generation'),
      appearance: !!g('sec-appearance'),
      background: !!g('sec-background'),
      data: !!g('sec-data'),
      agent: !!g('sec-agent'),
      mode: !!g('sec-mode'),
      ssh: !!g('sec-ssh')
    });
  })()`));
  check('the settings panels are there',
    settings.generation && settings.appearance && settings.background && settings.data && settings.agent,
    JSON.stringify(settings));
  check('no mode switch survives', settings.mode === false);
  check('no SSH panel survives', settings.ssh === false);

  // The page views must scroll themselves: body is overflow hidden, so a
  // view without its own scroller clips everything below the window edge —
  // which is how the Assistant panel became unreachable.
  const scroll = JSON.parse(await client.evaluate(`(() => {
    const v = document.querySelector('#view-settings.active');
    if (!v) return JSON.stringify({ missing: true });
    v.scrollTop = 120;
    const moved = v.scrollTop > 0;
    v.scrollTop = 0;
    return JSON.stringify({ overflowY: getComputedStyle(v).overflowY, moved });
  })()`));
  check('the settings page scrolls', scroll.overflowY === 'auto' && scroll.moved === true, JSON.stringify(scroll));

  // The assistant's own UI: the workspace panel and the permission prompt.
  const agentUi = JSON.parse(await client.evaluate(`(() => {
    const g = (id) => document.getElementById(id);
    const modal = g('toolModal');
    return JSON.stringify({
      panel: !!g('sec-agent'),
      workspace: !!g('agentWorkspaceBtn'),
      steps: !!g('agentSteps'),
      catalogue: !!g('agentToolList'),
      toggle: !!g('toolsToggleBtn'),
      modalHiddenAtBoot: modal ? modal.classList.contains('hidden') : false,
      deny: !!g('toolDenyBtn'),
      allow: !!g('toolAllowBtn'),
      always: !!g('toolAlwaysBtn')
    });
  })()`));
  check('the assistant panel is mounted', agentUi.panel && agentUi.workspace && agentUi.steps && agentUi.catalogue, JSON.stringify(agentUi));
  check('the permission prompt exists and starts hidden',
    agentUi.deny && agentUi.allow && agentUi.always && agentUi.modalHiddenAtBoot, JSON.stringify(agentUi));
  check('the composer carries the tools switch', agentUi.toggle === true);

  // The model picker, driven the way a person drives it: open, search, choose.
  const picker = JSON.parse(await client.evaluate(`(() => {
    const btn = document.getElementById('modelBtn');
    const pop = document.getElementById('modelPop');
    const search = document.getElementById('modelSearch');
    if (!btn || !pop || !search) return JSON.stringify({ missing: true });
    btn.click();
    const opened = !pop.classList.contains('hidden');
    const expanded = btn.getAttribute('aria-expanded');
    const all = [...pop.querySelectorAll('[role=option]')].map(o => o.textContent);
    const groups = [...pop.querySelectorAll('[role=group]')].map(g => g.getAttribute('aria-label'));
    search.value = 'hermes';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const filtered = [...pop.querySelectorAll('[role=option]')].map(o => o.textContent);
    const first = pop.querySelector('[role=option]');
    if (first) first.click();
    return JSON.stringify({
      opened, expanded, all, groups, filtered,
      closed: pop.classList.contains('hidden'),
      trigger: document.getElementById('modelBtn').textContent.replace(/\\s+/g, ' ').trim(),
      status: document.getElementById('chatStatus').textContent.trim()
    });
  })()`));
  check('the model dropdown opens as a listbox', picker.missing !== true && picker.opened && picker.expanded === 'true',
    picker.all ? picker.all.length + ' models' : JSON.stringify(picker));
  check('the list is grouped by provider', Array.isArray(picker.groups) && picker.groups.length > 0,
    picker.groups && picker.groups.join(', '));
  check('typing narrows the list to the matches',
    Array.isArray(picker.filtered) && picker.filtered.length > 0 &&
    picker.filtered.length <= picker.all.length && picker.filtered.every(t => /hermes/i.test(t)),
    picker.filtered && picker.filtered.join(', '));
  check('choosing closes it and labels the trigger and header',
    picker.closed === true && /hermes/i.test(picker.trigger) && /hermes/i.test(picker.status),
    picker.trigger + ' | ' + picker.status);

  // State: local-only shape, full provider list.
  const state = JSON.parse(await client.evaluate(`(async () => JSON.stringify(await nexus.getState()))()`));
  check('the state carries no mode/onlineUrl',
    state.settings && state.settings.mode === undefined && state.settings.onlineUrl === undefined,
    Object.keys(state.settings || {}).join(','));
  check('no online/license object survives', state.online === undefined && state.license === undefined);
  check('all local providers are on the list',
    Array.isArray(state.providers) && state.providers.every(p => p.id !== 'online') && state.providers.some(p => p.id === 'ollama'),
    (state.providers || []).length + ' providers');

  // The guide registry: surviving topics only, every chip resolves.
  const help = JSON.parse(await client.evaluate(`(() => {
    const topics = (typeof HELP_TOPICS !== 'undefined' ? HELP_TOPICS : []).map(t => t.id);
    const wanted = [...document.querySelectorAll('[data-help]')].map(el => el.dataset.help);
    return JSON.stringify({ topics, missing: wanted.filter(id => !topics.includes(id)) });
  })()`));
  check('the guide registry exists', help.topics.length > 0, help.topics.join(','));
  check('no removed topic survives',
    !help.topics.some(id => ['ssh', 'account', 'chief', 'cloud', 'update', 'mode'].includes(id)), help.topics.join(','));
  check('every guide chip resolves to a topic', help.missing.length === 0, help.missing.join(','));

  // The whole chain, live: renderer bridge -> preload -> ipcMain -> BotStore.
  const answer = JSON.parse(await client.evaluate(`(async () => JSON.stringify(
    await nexus.runBot('definitely-not-a-bot')
  ))()`));
  check('bots:run answers in the running app', answer && answer.ok === false, JSON.stringify(answer));
  check('…and says that bot is gone', /not found/i.test(String(answer && answer.error)), answer && answer.error);

  const bots = JSON.parse(await client.evaluate(`(async () => JSON.stringify(await nexus.listBots()))()`));
  check('bots:list answers', bots && bots.ok === true && Array.isArray(bots.bots),
    JSON.stringify(bots).slice(0, 60));

  // The agent surface answers over IPC too, and it starts switched off.
  const agent = JSON.parse(await client.evaluate(`(async () => JSON.stringify(await nexus.agentInfo()))()`));
  check('agent:info answers', !!agent && typeof agent.enabled === 'boolean', JSON.stringify(agent).slice(0, 60));
  check('tools are off until asked for', agent.enabled === false, 'enabled=' + agent.enabled);
  check('the toolset is the full one', Array.isArray(agent.catalog) && agent.catalog.length >= 20,
    (agent.catalog || []).length + ' tools');
  check('the risky tools ask every time',
    (agent.catalog || []).filter(t => t.needsAsk).length >= 10 &&
    (agent.catalog || []).filter(t => t.risk === 'danger' && t.needsAsk).every(t => t.risk === 'danger'),
    (agent.catalog || []).filter(t => t.risk === 'danger').map(t => t.name).join(', '));
  const grants = JSON.parse(await client.evaluate(`(async () => JSON.stringify(await nexus.clearAgentGrants()))()`));
  check('agent:clearGrants answers', grants && grants.ok === true, JSON.stringify(grants));

  // The update pill: it lives in the sidebar footer, stays honest in a source
  // run (no network, no install to replace) and the launch popup starts shut.
  const upd = JSON.parse(await client.evaluate(`(() => {
    const pill = document.getElementById('updatePill');
    const modal = document.getElementById('updateModal');
    return JSON.stringify({
      inSidebar: !!(pill && pill.closest('#sidebar')),
      text: pill ? pill.textContent.trim() : '',
      available: !!(pill && pill.classList.contains('available')),
      modalHidden: !!(modal && modal.classList.contains('hidden'))
    });
  })()`));
  check('the update pill sits in the sidebar footer', upd.inSidebar === true, upd.text);
  check('a source run never advertises an install', upd.available === false, upd.text);
  check('the update popup starts closed', upd.modalHidden === true);
  const updCheck = JSON.parse(await client.evaluate(`(async () => JSON.stringify(await nexus.updateCheck()))()`));
  check('update:check answers and stays offline in dev',
    !!updCheck && updCheck.skipped === true && updCheck.updateAvailable === false
      && typeof updCheck.current === 'string',
    JSON.stringify(updCheck));

  await sleep(200);
  check('nothing threw in the renderer', crashes.length === 0, crashes.join(' | '));

  client.close();
  const failed = results.filter(ok => !ok).length;
  console.log(failed
    ? '\n' + failed + ' of ' + results.length + ' live UI checks failed'
    : '\nall ' + results.length + ' live UI checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.message)); process.exit(1); });

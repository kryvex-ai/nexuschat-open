'use strict';

const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const { PROVIDERS } = require('../shared/providers');
const { SKILLS, PLUGINS, resolveSkillIds, composeSkillPrompt } = require('../shared/skills');
const brand = require('../shared/brand');
const { streamChat, listModels, testProvider } = require('./providers');
// Defensive: sanitizeError is landing in parallel — fall back until it exists.
// Normalized to always return a string (the landed shape may be an Error).
const sanitizeError = (e) => {
  const fn = require('./providers').sanitizeError || ((e2) => String((e2 && e2.message) || e2));
  const out = fn(e);
  return (out instanceof Error || (out && typeof out.message === 'string')) ? String(out.message) : String(out);
};
const { BotStore, BotRunner, validateBotInput, buildBotChatMessages, parseBotDirectives, applyBotDirectives, publicBot } = require('./bots');
const fs = require('node:fs');

// Generic chat line persisted on failure (never raw provider errors).
const BOT_FAIL_CHAT = 'Bot run failed — check the Providers tab / your connection and run again.';

// Bot ids are short uid strings — reject anything unexpected up front.
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128;
}

function initIpc(store) {
  let active = null; // { conversationId, abort, gen }
  let generation = 0; // every chat:send bumps this; stale loops stay silent

  const emit = (channel, payload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /* ---------------- app state ---------------- */

  ipcMain.handle('app:info', () => ({ name: brand.APP_NAME, version: app.getVersion(), platform: process.platform, dataDir: app.getPath('userData') }));

  ipcMain.handle('state:get', () => {
    const sums = store.providerSummaries();
    return {
      brand,
      version: app.getVersion(),
      platform: process.platform,
      settings: store.getSettings(),
      providers: PROVIDERS.map(p => ({ ...p, config: sums[p.id] || { enabled: true, hasKey: false, baseUrl: '', models: [] } }))
    };
  });

  /* ---------------- skills & plugins (prompt-level) ---------------- */

  /* A skill is prompt text and nothing else: enabling one appends its
   * instructions to the system prompt of chats and of the bots it is attached
   * to. Ids are validated against the shipped registry, so neither settings
   * nor bot records can smuggle arbitrary text into a prompt. */

  /** Skills active app-wide (enabled packs + individually enabled skills). */
  function globalSkillIds() {
    return resolveSkillIds(store.getSettings());
  }

  /** Skills for one bot: the app-wide set plus the bot's own attachments. */
  function skillsForBot(bot) {
    const own = Array.isArray(bot && bot.skills) ? bot.skills : [];
    return composeSkillPrompt([...globalSkillIds(), ...own]);
  }

  /** System prompt for a chat: the user's prompt plus the active skills. */
  function chatSystemPrompt(settings) {
    const parts = [];
    const base = settings && typeof settings.systemPrompt === 'string' ? settings.systemPrompt.trim() : '';
    if (base) parts.push(base);
    const skills = composeSkillPrompt(resolveSkillIds(settings));
    if (skills) parts.push(skills);
    return parts.join('\n\n');
  }

  /* ---------------- settings ---------------- */

  ipcMain.handle('settings:set', (_e, patch) => store.updateSettings(patch || {}));

  ipcMain.handle('settings:reset', () => ({ ok: true, settings: store.resetSettings() }));

  /* ---------------- skills ---------------- */

  ipcMain.handle('skills:state', () => {
    const settings = store.getSettings();
    const active = resolveSkillIds(settings);
    return {
      ok: true,
      plugins: PLUGINS,
      skills: SKILLS,
      enabledPlugins: Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins : [],
      enabledSkills: Array.isArray(settings.enabledSkills) ? settings.enabledSkills : [],
      activeSkills: active,
      promptChars: composeSkillPrompt(active).length
    };
  });

  ipcMain.handle('skills:set', (_e, patch = {}) => {
    const clean = {};
    if (patch && 'plugins' in patch) clean.enabledPlugins = patch.plugins;
    if (patch && 'skills' in patch) clean.enabledSkills = patch.skills;
    const settings = store.updateSettings(clean);
    const active = resolveSkillIds(settings);
    return {
      ok: true,
      enabledPlugins: settings.enabledPlugins,
      enabledSkills: settings.enabledSkills,
      activeSkills: active,
      promptChars: composeSkillPrompt(active).length
    };
  });

  /* ---------------- providers ---------------- */

  ipcMain.handle('providers:save', (_e, { id, cfg }) => {
    if (!PROVIDERS.some(p => p.id === id)) return { ok: false, error: 'Unknown provider ' + id };
    store.setProviderConfig(id, cfg || {});
    return { ok: true };
  });

  ipcMain.handle('providers:models', async (_e, { id }) => {
    try {
      const provider = PROVIDERS.find(p => p.id === id);
      if (!provider) throw new Error('Unknown provider ' + id);
      const pcfg = store.getProviderConfig(id);
      const models = await listModels(provider, pcfg);
      const merged = [...new Set([...(pcfg.models || []), ...models])];
      store.setProviderConfig(id, { models: merged });
      return { ok: true, models: merged, fetched: models };
    } catch (err) {
      console.error(err);
      return { ok: false, error: sanitizeError(err) };
    }
  });

  ipcMain.handle('providers:test', async (_e, { id }) => {
    const provider = PROVIDERS.find(p => p.id === id);
    if (!provider) return { ok: false, detail: 'Unknown provider ' + id };
    return testProvider(provider, store.getProviderConfig(id));
  });

  /* ---------------- chat ---------------- */

  ipcMain.handle('chat:send', async (_e, payload = {}) => {
    const { conversationId = null, text = '', regenerate = false, providerId, model } = payload;
    const settings = store.getSettings();

    if (active && !regenerate) return { ok: false, error: 'A response is already being generated — stop it first.' };

    // Validate on a transient basis first — no conversation is created and
    // no messages are popped until every check has passed.
    let conv = conversationId ? store.getConversation(conversationId) : null;
    if (regenerate) {
      if (!conv || !conv.messages.length) return { ok: false, error: 'Nothing to regenerate.' };
      const tail = [...conv.messages];
      while (tail.length && tail[tail.length - 1].role === 'assistant') tail.pop();
      if (!tail.length) return { ok: false, error: 'Nothing to regenerate.' };
    } else {
      if (!text || !String(text).trim()) return { ok: false, error: 'Empty message.' };
    }

    // Resolve provider + config. Every provider answers from this machine
    // with the user's own key — there is no server tier in this edition.
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return { ok: false, error: 'Unknown provider: ' + providerId };
    const pcfg = store.getProviderConfig(providerId);

    if (provider.requiresBaseUrl && !(pcfg.baseUrl || '').trim()) {
      return { ok: false, needProviders: true, error: 'Set the base URL for the custom provider in the Providers tab.' };
    }
    if (!provider.offline && !provider.requiresBaseUrl && !(pcfg.apiKey || '').trim()) {
      return { ok: false, needProviders: true, error: `Add your ${provider.name} API key in the Providers tab first.` };
    }

    const useModel = model || (pcfg.models && pcfg.models[0]) || provider.defaultModels[0];
    if (!useModel) {
      return { ok: false, needProviders: true, error: 'No model selected — add a model or press "Fetch models" in the Providers tab.' };
    }

    // All validations passed — now commit: create the conversation (if new)
    // and pop trailing assistant messages for a regenerate.
    if (!conv) conv = store.createConversation(regenerate ? 'Regenerated chat' : String(text).slice(0, 48) || 'New chat');
    if (regenerate) {
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
      store.saveConversations();
    }

    const userMessage = regenerate ? null : store.appendMessage(conv.id, { role: 'user', content: String(text) });
    conv = store.getConversation(conv.id);
    const history = conv.messages.map(m => ({ role: m.role, content: m.content }));
    const system = chatSystemPrompt(settings);
    const msgs = system ? [{ role: 'system', content: system }, ...history] : history;

    const abort = new AbortController();
    const gen = ++generation;
    const isCurrent = () => active && active.gen === gen;
    // Regenerate while a stream is still in flight (validation passed, so the
    // new send is committed): abort the old loop so its deltas can't
    // interleave with the new response. The gen tag makes a late old loop
    // stay silent even if its abort lands late.
    if (active) { try { active.abort.abort(); } catch { /* already gone */ } }
    active = { conversationId: conv.id, abort, gen };
    emit('chat:begin', { conversationId: conv.id });

    (async () => {
      let acc = '';
      try {
        for await (const delta of streamChat(provider, pcfg, {
          messages: msgs,
          model: useModel,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens || undefined,
          signal: abort.signal
        })) {
          acc += delta;
          if (isCurrent()) emit('chat:delta', { conversationId: conv.id, delta });
        }
        if (!isCurrent()) return; // superseded by a newer generation — stay silent
        const message = store.appendMessage(conv.id, {
          role: 'assistant', content: acc,
          meta: { provider: providerId, model: useModel }
        });
        store.updateConversation(conv.id, { providerId, model: useModel });
        emit('chat:done', { conversationId: conv.id, message, aborted: false });
      } catch (err) {
        if (!isCurrent()) return; // superseded — the new loop owns the UI now
        const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
        if (aborted) {
          const message = acc
            ? store.appendMessage(conv.id, { role: 'assistant', content: acc, meta: { provider: providerId, model: useModel, partial: true } })
            : null;
          emit('chat:done', { conversationId: conv.id, message, aborted: true });
        } else {
          console.error(err);
          emit('chat:error', { conversationId: conv.id, message: sanitizeError(err) });
        }
      } finally {
        if (isCurrent()) active = null;
      }
    })();

    return { ok: true, conversationId: conv.id, userMessage };
  });

  ipcMain.handle('chat:stop', () => {
    if (active) {
      try { active.abort.abort(); } catch { /* already gone */ }
      // Retire this generation so the late loop stays silent (isCurrent()
      // goes false) and the next send is not wrongly rejected.
      generation++;
      active = null;
      return true;
    }
    return false;
  });

  /* ---------------- bots (local background task runners) ---------------- */

  const botStore = new BotStore(app.getPath('userData'));

  /** Resolve provider + config + model for a bot (shared by runs + chat). */
  function resolveBot(bot) {
    const provider = PROVIDERS.find(p => p.id === bot.providerId);
    if (!provider) throw new Error('Unknown provider: ' + bot.providerId);
    const pcfg = store.getProviderConfig(provider.id);
    if (provider.requiresBaseUrl && !(pcfg.baseUrl || '').trim()) {
      throw new Error(`Set the base URL for ${provider.name} in the Providers tab.`);
    }
    if (!provider.offline && !provider.requiresBaseUrl && !(pcfg.apiKey || '').trim()) {
      throw new Error(`Add your ${provider.name} API key in the Providers tab.`);
    }
    const useModel = bot.model || (pcfg.models && pcfg.models[0]) || (provider.defaultModels && provider.defaultModels[0]);
    if (!useModel) throw new Error(`No model for ${provider.name} — press "Fetch models" in the Providers tab.`);
    return { provider, pcfg, useModel };
  }

  /** Execute one bot with the user's own provider key on this machine. */
  async function executeBot({ bot, messages }) {
    const { provider, pcfg, useModel } = resolveBot(bot);
    const settings = store.getSettings();
    let text = '';
    for await (const delta of streamChat(provider, pcfg, {
      messages, model: useModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens || 512
    })) text += delta;
    return text;
  }

  const botRunner = new BotRunner({
    store: botStore,
    executor: executeBot,
    onEvent: () => emit('bot:changed', {}),
    // Each run gets the app-wide skills plus the skills attached to that bot.
    skillsFor: bot => skillsForBot(bot)
  });
  botRunner.start();

  ipcMain.handle('bots:list', () => ({ ok: true, bots: botStore.list() }));

  ipcMain.handle('bots:create', async (_e, data = {}) => {
    const v = validateBotInput(data);
    if (!v.ok) return { ok: false, error: v.error };
    if (!v.providerId) return { ok: false, error: 'Pick which provider this bot runs with.' };
    if (v.name && botStore.list().some(b => String(b.name || '').toLowerCase() === String(v.name).toLowerCase())) {
      return { ok: false, error: 'A bot named "' + v.name + '" already exists — pick another name.' };
    }
    const provider = PROVIDERS.find(p => p.id === v.providerId);
    if (!provider) return { ok: false, error: 'Pick a provider for this bot (Providers tab).' };
    let bot;
    try {
      bot = botStore.create({
        name: v.name, task: v.task, intervalSec: v.intervalSec,
        providerId: v.providerId, model: v.model || null,
        skills: v.skills || []
      });
    } catch (err) {
      console.error(err);
      return { ok: false, error: sanitizeError(err) };
    }
    emit('bot:changed', {});
    // Fresh bots have nextRunAt = now, so the runner picks them up within seconds.
    return { ok: true, bot };
  });

  ipcMain.handle('bots:update', async (_e, { id, patch } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    const v = validateBotInput(patch || {}, true);
    if (!v.ok) return { ok: false, error: v.error };
    const clean = {};
    for (const k of ['name', 'task', 'intervalSec', 'providerId', 'model', 'skills']) {
      if (v[k] !== undefined) clean[k] = v[k];
    }
    // Fail fast on renames that would collide.
    if (clean.name && botStore.list().some(b => b.id !== id && String(b.name || '').toLowerCase() === String(clean.name).toLowerCase())) {
      return { ok: false, error: 'A bot named "' + clean.name + '" already exists — pick another name.' };
    }
    let updated;
    try {
      updated = botStore.update(id, clean);
    } catch (err) {
      console.error(err);
      return { ok: false, error: sanitizeError(err) };
    }
    emit('bot:changed', {});
    return { ok: true, bot: updated };
  });

  ipcMain.handle('bots:setStatus', async (_e, { id, status } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    if (status !== 'running' && status !== 'paused') return { ok: false, error: 'status must be "running" or "paused".' };
    const updated = botStore.setStatus(id, status);
    emit('bot:changed', {});
    return { ok: true, bot: updated };
  });

  ipcMain.handle('bots:remove', async (_e, { id } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    botStore.remove(id);
    emit('bot:changed', {});
    return { ok: true };
  });

  ipcMain.handle('bots:run', async (_e, { id } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    const run = await botRunner.runOne(id, true);
    if (!run) return { ok: false, error: 'Bot is already running.' };
    emit('bot:changed', {});
    return { ok: true, bot: publicBot(botStore.get(id)), run };
  });

  ipcMain.handle('bots:runs', async (_e, { id, limit } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    return { ok: true, runs: botStore.getRuns(id, Number(limit) || 20) };
  });

  /* Per-bot chat window: scheduled work lands here as bot messages and the
   * user talks to the bot here — everything happens in the chat. */

  ipcMain.handle('bots:chat', async (_e, { id } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    return { ok: true, messages: botStore.getChat(id) };
  });

  /** Reply in context: identity + recent chat history (not a scheduled run).
   *  The bot is an interactive agent here — its reply may contain tool
   *  directives ([[bot {...}]]) which are executed and recorded in the chat. */
  async function replyBot(bot, text) {
    const history = [...botStore.getChat(bot.id), { role: 'user', content: text }];
    const messages = buildBotChatMessages(bot, history, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', skillsForBot(bot));
    const { provider, pcfg, useModel } = resolveBot(bot);
    const settings = store.getSettings();
    let raw = '';
    for await (const delta of streamChat(provider, pcfg, {
      messages, model: useModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens || 512
    })) raw += delta;
    const { text: reply, actions } = parseBotDirectives(raw);
    return { reply: reply || '(empty reply)', actions };
  }

  /** Execute the bot's own tool directives and log each result in its chat. */
  async function runBotActions(bot, actions) {
    const { applied, errors } = applyBotDirectives(botStore, bot.id, actions);
    for (const line of applied) botStore.appendChat(bot.id, { role: 'action', content: '⚙ ' + line });
    for (const line of errors) botStore.appendChat(bot.id, { role: 'action', content: '⚠ ' + line });
    if (applied.some(s => /running the task now/.test(s))) {
      // Fire and forget — the result lands in this chat like any scheduled run.
      botRunner.runOne(bot.id, true).catch(() => {});
    }
    return { applied, errors };
  }

  ipcMain.handle('bots:send', async (_e, { id, text } = {}) => {
    if (!validId(id)) return { ok: false, error: 'Invalid bot id.' };
    const bot = botStore.get(id);
    if (!bot) return { ok: false, error: 'Bot not found.' };
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return { ok: false, error: 'Empty message.' };
    botStore.appendChat(id, { role: 'user', content: text });
    try {
      const { reply, actions } = await replyBot(bot, text);
      botStore.appendChat(id, { role: 'assistant', content: reply });
      if (actions && actions.length) {
        await runBotActions(bot, actions);
      }
      emit('bot:changed', {});
      return { ok: true, reply, messages: botStore.getChat(id) };
    } catch (err) {
      console.error(err);
      botStore.appendChat(id, { role: 'assistant', content: BOT_FAIL_CHAT });
      emit('bot:changed', {});
      return { ok: false, error: sanitizeError(err), messages: botStore.getChat(id) };
    }
  });

  /* ---------------- conversations ---------------- */

  ipcMain.handle('conversations:list', () => store.listConversations());
  ipcMain.handle('conversations:create', (_e, { title } = {}) => store.createConversation(title));
  ipcMain.handle('conversations:get', (_e, { id }) => store.getConversation(id));
  ipcMain.handle('conversations:rename', (_e, { id, title }) => store.updateConversation(id, { title }));
  ipcMain.handle('conversations:delete', (_e, { id }) => ({ ok: store.deleteConversation(id) }));

  /* ---------------- data ---------------- */

  ipcMain.handle('app:dataFolder', () => { shell.openPath(app.getPath('userData')); return true; });

  ipcMain.handle('app:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export chats & settings',
      defaultPath: brand.APP_NAME.toLowerCase().replace(/\s+/g, '-') + '-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const settings = store.getSettings();
    delete settings.providerConfigs; // never export secrets
    const data = { exportedAt: new Date().toISOString(), app: brand.APP_NAME, settings, conversations: store.conversations };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { ok: true, filePath };
  });

  ipcMain.handle('app:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import chats & settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      const { conversations } = store.importData(data || {});
      return { ok: true, imported: conversations };
    } catch (err) {
      console.error(err);
      return { ok: false, error: sanitizeError(err) };
    }
  });

  return { botStore, botRunner };
}

module.exports = { initIpc };

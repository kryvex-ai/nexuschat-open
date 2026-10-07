'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validSkillIds, pluginById } = require('../shared/skills');

/** Keep only ids of packs that actually ship with the app (deduped, ordered). */
function validPluginIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id) || !pluginById(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Fallback "cipher" used when Electron safeStorage is unavailable
 * (e.g. headless Linux without a keyring). Base64-obfuscation only.
 */
const PLAIN = {
  available: false,
  encrypt: p => 'plain1:' + Buffer.from(String(p), 'utf8').toString('base64'),
  decrypt: s => (typeof s === 'string' && s.startsWith('plain1:'))
    ? Buffer.from(s.slice(7), 'base64').toString('utf8')
    : String(s || '')
};

function isEncryptedToken(v) {
  return typeof v === 'string' && (v.startsWith('enc1:') || v.startsWith('plain1:'));
}

function defaultSettings() {
  return {
    theme: 'dark',
    temperature: 0.7,
    maxTokens: null,            // null = provider default
    systemPrompt: '',
    activeChatModel: null,      // 'providerId::model'
    runInBackground: null,      // null = never asked; true = tray on close; false = quit on close
    introDone: false,           // first-launch onboarding overlay
    enabledPlugins: [],         // skill packs with every skill switched on
    enabledSkills: [],          // individually switched-on skills (beyond packs)
    providerConfigs: {},        // id -> { enabled, apiKey(encrypted), baseUrl, models[] }
    agent: defaultAgentSettings()
  };
}

/**
 * The agent (tool) layer, all off or all safe by default: nothing runs until
 * the user turns it on, picks a workspace, and answers the prompts.
 */
function defaultAgentSettings() {
  return {
    enabled: false,
    workspace: null,            // absolute path; null = not chosen yet
    askBeforeReads: false,      // reads are logged, not asked — turn on to ask for those too
    allowSessionGrants: true,   // "allow for this session" on write tools
    allowNetwork: false,        // http_fetch stays off until asked for
    maxSteps: 12                // tool rounds per message (1..25)
  };
}

/** Merge an agent patch, ignoring anything of the wrong type or out of range. */
function agentSettings(patch = {}) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const k of ['enabled', 'askBeforeReads', 'allowSessionGrants', 'allowNetwork']) {
    if (k in patch && typeof patch[k] === 'boolean') out[k] = patch[k];
  }
  if ('workspace' in patch) {
    const w = patch.workspace == null || patch.workspace === '' ? null : String(patch.workspace).slice(0, 1024);
    out.workspace = w;
  }
  if ('maxSteps' in patch) {
    const n = Math.floor(Number(patch.maxSteps));
    if (Number.isFinite(n)) out.maxSteps = Math.min(25, Math.max(1, n));
  }
  return out;
}

/**
 * JSON-file persistence for settings and conversations.
 * `secure` is an injected crypto adapter ({ encrypt, decrypt }) so this
 * class stays pure and unit-testable without Electron.
 */
class Store {
  constructor(dir, secure) {
    this.dir = dir;
    this.secure = secure || PLAIN;
    this.settingsPath = path.join(dir, 'settings.json');
    this.convosPath = path.join(dir, 'conversations.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }
    this.settings = { ...defaultSettings(), ...this._read(this.settingsPath, {}) };
    if (!this.settings.providerConfigs) this.settings.providerConfigs = {};
    this.conversations = this._read(this.convosPath, []);
    if (!Array.isArray(this.conversations)) this.conversations = [];

  }

  _read(p, fallback) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return fallback; // missing file — first run
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt JSON (crash mid-write, disk issue): quarantine the file so
      // the app still starts, instead of silently resetting to defaults.
      try {
        const bak = p + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
          + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.bak';
        try { fs.copyFileSync(p, bak); } catch { /* best-effort */ }
        try { fs.chmodSync(bak, 0o600); } catch { /* best-effort */ }
        // Cap quarantine growth: keep at most 5 backups per directory.
        try {
          const d = path.dirname(p);
          const names = fs.readdirSync(d).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'));
          if (names.length > 5) {
            const ordered = names.map(n => {
              let t = 0;
              try { t = fs.statSync(path.join(d, n)).mtimeMs; } catch { /* keep 0 */ }
              return { n, t };
            }).sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
            for (let i = 0; i < ordered.length - 5; i++) {
              try { fs.unlinkSync(path.join(d, ordered[i].n)); } catch { /* best-effort */ }
            }
          }
        } catch { /* best-effort */ }
      } catch { /* best effort */ }
      return fallback;
    }
  }

  _write(p, value) {
    // Atomic write: crash mid-save leaves either the old file or the new
    // one — never a half-written JSON blob that wipes chats/keys on reboot.
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
  }

  /* ---------------- settings ---------------- */

  getSettings() { return { ...this.settings, providerConfigs: undefined }; }

  updateSettings(patch = {}) {
    const allowed = ['theme', 'temperature', 'maxTokens', 'systemPrompt', 'activeChatModel', 'runInBackground', 'introDone', 'enabledPlugins', 'enabledSkills', 'agent', 'dismissedUpdate'];
    const clean = {};
    for (const k of allowed) {
      if (!(k in patch)) continue;
      const v = patch[k];
      switch (k) {
        case 'theme':
          if (v === 'dark' || v === 'light') clean[k] = v;
          break;
        case 'agent':
          // Merged, not replaced: a partial patch must not wipe the workspace.
          clean[k] = { ...defaultAgentSettings(), ...(this.settings.agent || {}), ...agentSettings(v) };
          break;
        case 'enabledPlugins':
          clean[k] = validPluginIds(v);
          break;
        case 'enabledSkills':
          clean[k] = validSkillIds(v);
          break;
        case 'temperature': {
          const n = Number(v);
          if (Number.isFinite(n)) clean[k] = Math.min(2, Math.max(0, n));
          break;
        }
        case 'maxTokens': {
          if (v === null || v === '' || v === undefined) { clean[k] = null; break; }
          const n = Math.floor(Number(v));
          if (Number.isFinite(n) && n > 0) clean[k] = n;
          break;
        }
        case 'runInBackground':
          if (v === true || v === false || v === null) clean[k] = v;
          break;
        case 'introDone':
          if (v === true || v === false) clean[k] = v;
          break;
        case 'dismissedUpdate':
          // Only a version the app could actually have shown, or null to clear:
          // a stray value must never be able to mute future prompts.
          if (v === null || (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))) clean[k] = v;
          break;
        default:
          if (typeof v === 'string' || v === null) clean[k] = v;
      }
    }
    Object.assign(this.settings, clean);
    this.saveSettings();
    return this.getSettings();
  }

  saveSettings() { this._write(this.settingsPath, this.settings); }

  /**
   * Restore every preference to its shipped default. Provider keys/URLs and
   * models are deliberately kept: "restore defaults" must never silently
   * throw away the API keys the user pasted in.
   */
  resetSettings() {
    const kept = this.settings.providerConfigs || {};
    const introDone = this.settings.introDone === true;
    this.settings = { ...defaultSettings(), providerConfigs: kept, introDone };
    this.saveSettings();
    return this.getSettings();
  }

  /* ---------------- providers ---------------- */

  setProviderConfig(id, cfg = {}) {
    const cur = this.settings.providerConfigs[id] || { enabled: true, apiKey: '', baseUrl: '', models: [] };
    const next = { ...cur };
    if (typeof cfg.enabled === 'boolean') next.enabled = cfg.enabled;
    if (typeof cfg.baseUrl === 'string') next.baseUrl = cfg.baseUrl.trim();
    if (Array.isArray(cfg.models)) next.models = cfg.models.filter(Boolean);
    if (typeof cfg.apiKey === 'string') next.apiKey = cfg.apiKey === '' ? '' : this.secure.encrypt(cfg.apiKey);
    this.settings.providerConfigs[id] = next;
    this.saveSettings();
  }

  getProviderConfig(id) {
    const cur = this.settings.providerConfigs[id];
    if (!cur) return { enabled: true, apiKey: '', baseUrl: '', models: [] };
    return { ...cur, apiKey: cur.apiKey ? this.secure.decrypt(cur.apiKey) : '' };
  }

  /** Provider info safe to send to the renderer (never includes raw keys). */
  providerSummaries() {
    const out = {};
    for (const [id, cfg] of Object.entries(this.settings.providerConfigs)) {
      out[id] = { enabled: cfg.enabled !== false, hasKey: !!cfg.apiKey, baseUrl: cfg.baseUrl || '', models: cfg.models || [] };
    }
    return out;
  }

  /* ---------------- conversations ---------------- */

  createConversation(title) {
    const now = new Date().toISOString();
    const conv = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: (title || 'New chat').slice(0, 80),
      createdAt: now, updatedAt: now,
      providerId: null, model: null,
      messages: []
    };
    this.conversations.push(conv);
    this.saveConversations();
    return conv;
  }

  listConversations() {
    return [...this.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ messages, ...meta }) => ({ ...meta, messageCount: messages.length }));
  }

  getConversation(id) {
    return this.conversations.find(c => c.id === id) || null;
  }

  appendMessage(id, msg) {
    const conv = this.getConversation(id);
    if (!conv) return null;
    const m = { role: msg.role, content: msg.content, ts: new Date().toISOString() };
    if (msg.meta) m.meta = msg.meta;
    conv.messages.push(m);
    conv.updatedAt = new Date().toISOString();
    if (msg.role === 'user' && (conv.title === 'New chat' || !conv.title)) {
      conv.title = String(msg.content).slice(0, 48) || 'New chat';
    }
    this.saveConversations();
    return m;
  }

  updateConversation(id, patch) {
    const conv = this.getConversation(id);
    if (!conv) return null;
    for (const k of ['title', 'providerId', 'model', 'tools']) if (k in patch) conv[k] = patch[k];
    conv.updatedAt = new Date().toISOString();
    this.saveConversations();
    return conv;
  }

  deleteConversation(id) {
    const before = this.conversations.length;
    this.conversations = this.conversations.filter(c => c.id !== id);
    const removed = this.conversations.length !== before;
    if (removed) this.saveConversations();
    return removed;
  }

  saveConversations() { this._write(this.convosPath, this.conversations); }

  /* ---------------- import (validated — never trust a file) ---------------- */

  /**
   * Merge an exported backup into this store. Malformed entries are skipped,
   * never imported: a hand-edited or truncated export must not corrupt chats
   * or crash the renderer. Returns { conversations: n, settings: bool }.
   */
  importData(data = {}) {
    let conversations = 0;
    if (Array.isArray(data.conversations)) {
      const known = new Set(this.conversations.map(c => c && c.id));
      for (const c of data.conversations) {
        const clean = sanitizeImportedConversation(c);
        if (!clean || known.has(clean.id)) continue;
        known.add(clean.id);
        this.conversations.push(clean);
        conversations++;
      }
      if (conversations) this.saveConversations();
    }
    let settings = false;
    if (data.settings && typeof data.settings === 'object') {
      const { providerConfigs, ...rest } = data.settings; // provider keys are never imported
      const before = JSON.stringify(this.getSettings());
      this.updateSettings(rest); // whitelisted + type-checked
      settings = JSON.stringify(this.getSettings()) !== before;
    }
    return { conversations, settings };
  }
}

/**
 * Validate one imported conversation. Returns a clean copy or null.
 * Caps sizes so a hostile export can't blow up memory on load.
 */
function sanitizeImportedConversation(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.id !== 'string' || !c.id) return null;
  const messages = Array.isArray(c.messages) ? c.messages : [];
  const cleanMessages = [];
  for (const m of messages.slice(-2000)) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string') continue;
    const clean = { role: m.role, content: m.content.slice(0, 100000) };
    if (typeof m.ts === 'string') clean.ts = m.ts;
    if (m.meta && typeof m.meta === 'object') clean.meta = m.meta;
    cleanMessages.push(clean);
  }
  const iso = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
  const now = new Date().toISOString();
  return {
    id: c.id.slice(0, 64),
    title: typeof c.title === 'string' ? c.title.slice(0, 80) : 'Imported chat',
    createdAt: iso(c.createdAt, now),
    updatedAt: iso(c.updatedAt, now),
    providerId: typeof c.providerId === 'string' ? c.providerId.slice(0, 64) : null,
    model: typeof c.model === 'string' ? c.model.slice(0, 256) : null,
    messages: cleanMessages
  };
}

module.exports = { Store, PLAIN, defaultSettings, defaultAgentSettings, agentSettings, sanitizeImportedConversation, validPluginIds };

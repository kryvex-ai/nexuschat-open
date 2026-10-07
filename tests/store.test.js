'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Store, PLAIN, defaultSettings } = require('../src/main/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-store-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return new Store(dir, PLAIN);
}

test('default settings are local-only and free', () => {
  const s = defaultSettings();
  assert.equal('mode' in s, false, 'no online/offline mode');
  assert.equal('onlineUrl' in s, false, 'no server URL');
  assert.ok(Array.isArray(s.sshHosts), 'SSH hosts default to an empty list');
  assert.deepEqual(s.sshHosts, []);
  assert.equal(s.maxTokens, null);
  assert.equal(s.temperature, 0.7);
  assert.equal(s.theme, 'dark');
});

test('a fresh install carries no online or license state', () => {
  const st = tmpStore();
  const s = st.getSettings();
  assert.equal(s.mode, undefined);
  assert.equal(s.onlineUrl, undefined);
  assert.deepEqual(s.sshHosts, [], 'SSH hosts exist but start empty');
  assert.equal(s.providerConfigs, undefined, 'raw configs stay private to the store');
  assert.deepEqual(s.enabledPlugins, []);
  assert.deepEqual(s.enabledSkills, []);
});

test('settings round-trip and whitelist', () => {
  const store = tmpStore();
  store.updateSettings({ mode: 'online', onlineUrl: 'http://evil', theme: 'light', evil: 'nope' });
  const s = store.getSettings();
  assert.equal(s.mode, undefined, 'mode is not an allowed setting');
  assert.equal(s.onlineUrl, undefined, 'onlineUrl is not an allowed setting');
  assert.equal(s.theme, 'light');
  assert.equal('evil' in s, false);
  // persisted
  const store2 = new Store(store.dir, PLAIN);
  assert.equal(store2.getSettings().theme, 'light');
});

test('sshHosts round-trip through the whitelist, junk never wipes them', () => {
  const store = tmpStore();
  store.updateSettings({ sshHosts: [{ id: 'a1', label: 'Web', host: 'web.example', user: 'me', port: 2222, keyFile: '' }] });
  assert.equal(store.getSettings().sshHosts.length, 1);
  store.updateSettings({ sshHosts: 'nope' });
  assert.equal(store.getSettings().sshHosts.length, 1, 'a non-list patch is ignored, not applied');
  store.updateSettings({ sshHosts: [{ host: '-oProxyCommand=x' }, { id: 'b', host: 'good.example' }] });
  assert.equal(store.getSettings().sshHosts.length, 1, 'junk entries are dropped by the sanitizer');
  const raw = JSON.parse(fs.readFileSync(path.join(store.dir, 'settings.json'), 'utf8'));
  assert.equal(raw.sshHosts[0].host, 'good.example');
  const store2 = new Store(store.dir, PLAIN);
  assert.equal(store2.getSettings().sshHosts[0].id, 'b', 'persisted and reloaded');
});

test('provider config: apiKey encrypted at rest, summaries hide it', () => {
  const store = tmpStore();
  store.setProviderConfig('openai', { apiKey: 'sk-secret', models: ['gpt-4o-mini'] });
  const raw = JSON.parse(fs.readFileSync(path.join(store.dir, 'settings.json'), 'utf8'));
  assert.notEqual(raw.providerConfigs.openai.apiKey, 'sk-secret');
  assert.ok(raw.providerConfigs.openai.apiKey.startsWith('plain1:'));
  const sums = store.providerSummaries();
  assert.equal(sums.openai.hasKey, true);
  assert.equal('apiKey' in sums.openai, false);
  assert.deepEqual(sums.openai.models, ['gpt-4o-mini']);
  // decryption round-trip
  assert.equal(store.getProviderConfig('openai').apiKey, 'sk-secret');
  // clearing
  store.setProviderConfig('openai', { apiKey: '' });
  assert.equal(store.providerSummaries().openai.hasKey, false);
});

test('conversations: create, list (no messages leak), title from first user msg', () => {
  const store = tmpStore();
  const c = store.createConversation('New chat');
  store.appendMessage(c.id, { role: 'user', content: 'Hello there, this should become the title' });
  const list = store.listConversations();
  assert.equal(list.length, 1);
  assert.equal('messages' in list[0], false);
  assert.equal(list[0].messageCount, 1);
  assert.ok(list[0].title.startsWith('Hello there'));
  const full = store.getConversation(c.id);
  assert.equal(full.messages[0].role, 'user');
  store.updateConversation(c.id, { title: 'Renamed' });
  assert.equal(store.getConversation(c.id).title, 'Renamed');
  assert.equal(store.deleteConversation(c.id), true);
  assert.equal(store.listConversations().length, 0);
});

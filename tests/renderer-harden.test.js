'use strict';
// Static regression for renderer hardening: reads app.js + index.html as text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

test('boot failure uses textContent, not body.innerHTML', () => {
  assert.ok(!appJs.includes('document.body.innerHTML'), 'no body.innerHTML');
  assert.ok(appJs.includes('document.body.textContent'), 'body cleared via textContent');
  assert.ok(appJs.includes('Failed to start: '), 'error text preserved');
});

test('kebab does not hijack selection; botAction takes explicit id', () => {
  assert.ok(!appJs.includes('currentBotId = bot.id'), 'openBotMenu must not set selection');
  assert.ok(appJs.includes('async function botAction(act, id = currentBotId)'), 'botAction(act, id) signature');
  assert.ok(appJs.includes("botAction('run', botId)"), 'run passes id');
  assert.ok(appJs.includes("botAction('toggle', botId)"), 'toggle passes id');
  assert.ok(appJs.includes("botAction('del', botId)"), 'del passes id');
  assert.ok(appJs.includes('openBotModal(true, botId)'), 'edit passes id');
});

test('openBotModal resolves edit target from explicit id', () => {
  assert.ok(appJs.includes('function openBotModal(edit, editId)'), 'editId param');
  assert.ok(appJs.includes('bots.find(b => b.id === editId)'), 'lookup by editId');
});

test('sendBotMessage guards selection race and disables inputs', () => {
  assert.ok(appJs.includes('const botId = bot.id'), 'botId captured');
  assert.ok(appJs.includes('await nexus.botSend(botId, text)'), 'send uses captured id');
  assert.ok(appJs.includes('if (currentBotId !== botId)'), 'selection check after await');
  assert.ok(appJs.includes('await loadBots(true); return;'), 'quiet refresh on switch');
  assert.ok(appJs.includes('input.disabled = true'), 'input disabled');
  assert.ok(appJs.includes('sendBtn.disabled = true'), 'send button disabled');
  assert.ok(appJs.includes('input.disabled = false'), 'input restored');
});

test('interval offers Weekly and validates allowlist', () => {
  assert.ok(html.includes('<option value="604800">Weekly</option>'), 'Weekly option');
  assert.ok(appJs.includes('[60, 300, 900, 3600, 21600, 86400, 604800]'), 'allowlist');
  assert.ok(appJs.includes('.includes(intervalSec)'), 'allowlist check');
  assert.ok(appJs.includes('Pick a valid repeat interval.'), 'form error');
});

test('bot modal dialog semantics; Escape blocked while submitting', () => {
  const modal = html.match(/<div id="botModal"[^>]*>/)[0];
  assert.ok(modal.includes('role="dialog"'), 'role dialog');
  assert.ok(modal.includes('aria-modal="true"'), 'aria-modal');
  assert.ok(modal.includes('aria-labelledby="botModalTitle"'), 'labelledby');
  assert.ok(appJs.includes('if (sb && sb.disabled) return;'), 'Escape blocked when submit disabled');
});

test('polling skips when hidden, keeps bots-tab check', () => {
  assert.ok(appJs.includes('if (document.hidden) return;'), 'hidden check');
  assert.ok(appJs.includes("$('#view-bots').classList.contains('active')"), 'bots-tab check kept');
});

test('no optimistic toasts; one toast after RPC', () => {
  assert.ok(!appJs.includes('Bot is working on it'), 'no bot pre-toast');
  assert.ok(appJs.indexOf('nexus.runBot') < appJs.indexOf('Bot run finished'), 'bot toast after await');
  assert.ok(!appJs.includes('nexus.chiefCommand'), 'no chief RPC in this edition');
});

test('bot modal labels use for attributes', () => {
  for (const id of ['botName', 'botTask', 'botProvider', 'botModel', 'botInterval']) {
    assert.ok(html.includes(`for="${id}"`), `label for ${id}`);
  }
});

test('aria: toasts live region, dots, new bot button', () => {
  const toasts = html.match(/<div id="toasts"[^>]*>/)[0];
  assert.ok(toasts.includes('aria-live="polite"'), 'aria-live');
  assert.ok(toasts.includes('role="status"'), 'role status');
  assert.ok(appJs.includes("dot.title = bot.status"), 'list dot title');
  assert.ok(appJs.includes("setAttribute('aria-label'"), 'dots aria-label');
  const btn = html.match(/<button id="newBotBtn"[^>]*>/)[0];
  assert.ok(btn.includes('title="New bot"'), 'title kept');
  assert.ok(btn.includes('aria-label="New bot"'), 'aria-label');
});

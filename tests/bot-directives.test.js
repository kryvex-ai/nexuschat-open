'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BotStore, buildBotChatSystem, buildBotChatMessages,
  parseBotDirectives, applyBotDirectives, formatInterval
} = require('../src/main/bots');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuschat-bots-'));
  return new BotStore(dir);
}

function makeBot(store) {
  return store.create({ name: 'Testy', task: 'Say hi', intervalSec: 3600, runOn: 'pc', providerId: 'openai' });
}

test('parseBotDirectives extracts tool directives and strips them from the text', () => {
  const raw = [
    'Sure — I will run every 30 minutes from now on.',
    '[[bot {"action":"setInterval","intervalSec":1800}]]',
    'Anything else?',
    '[[bot {"action":"pause"}]]'
  ].join('\n');
  const { text, actions } = parseBotDirectives(raw);
  assert.strictEqual(actions.length, 2);
  assert.deepStrictEqual(actions[0], { action: 'setInterval', intervalSec: 1800 });
  assert.deepStrictEqual(actions[1], { action: 'pause' });
  assert.ok(text.includes('every 30 minutes'));
  assert.ok(!text.includes('[[bot'));
  assert.ok(!text.includes('Anything else?\n\n\n')); // no stray blank runs
});

test('parseBotDirectives keeps malformed directives visible and parses none', () => {
  const raw = 'oops [[bot {not json}]] and [[bot {"noaction":1}]]';
  const { text, actions } = parseBotDirectives(raw);
  assert.strictEqual(actions.length, 0);
  assert.ok(text.includes('[[bot {not json}]]'));
});

test('parseBotDirectives handles text without directives', () => {
  const { text, actions } = parseBotDirectives('just chatting\n');
  assert.strictEqual(text, 'just chatting');
  assert.strictEqual(actions.length, 0);
});

test('applyBotDirectives updates interval, task and status in the store', () => {
  const store = tmpStore();
  const bot = makeBot(store);
  const { applied, errors } = applyBotDirectives(store, bot.id, [
    { action: 'setInterval', intervalSec: 900 },
    { action: 'setTask', task: 'New task' },
    { action: 'pause' },
    { action: 'resume' }
  ]);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(applied.length, 4);
  const after = store.get(bot.id);
  assert.strictEqual(after.intervalSec, 900);
  assert.strictEqual(after.task, 'New task');
  assert.strictEqual(after.status, 'running');
});

test('applyBotDirectives clamps bad intervals and reports unknown actions', () => {
  const store = tmpStore();
  const bot = makeBot(store);
  const { applied, errors } = applyBotDirectives(store, bot.id, [
    { action: 'setInterval', intervalSec: 1 },       // below minimum -> error
    { action: 'explode' },                            // unknown -> error
    { action: 'setTask', task: '   ' }                // empty -> error
  ]);
  assert.strictEqual(applied.length, 0);
  assert.strictEqual(errors.length, 3);
  assert.strictEqual(store.get(bot.id).intervalSec, 3600); // unchanged
});

test('applyBotDirectives reports runNow without touching the store', () => {
  const store = tmpStore();
  const bot = makeBot(store);
  const before = store.get(bot.id).nextRunAt;
  const { applied, errors } = applyBotDirectives(store, bot.id, [{ action: 'runNow' }]);
  assert.strictEqual(errors.length, 0);
  assert.match(applied[0], /running the task now/);
  assert.strictEqual(store.get(bot.id).nextRunAt, before);
});

test('formatInterval renders human labels', () => {
  assert.strictEqual(formatInterval(60), 'every minute');
  assert.strictEqual(formatInterval(1800), 'every 30 min');
  assert.strictEqual(formatInterval(7200), 'every 2h');
  assert.strictEqual(formatInterval(86400), 'daily');
});

test('chat system prompt advertises the self-management tools', () => {
  const store = tmpStore();
  const bot = makeBot(store);
  const sys = buildBotChatSystem(bot, '2026-09-05 12:00 UTC');
  for (const tool of ['setInterval', 'setTask', '"action":"pause"', '"action":"resume"', 'runNow']) {
    assert.ok(sys.includes(tool), 'prompt should mention ' + tool);
  }
  // Chat history excludes app-recorded action entries.
  store.appendChat(bot.id, { role: 'user', content: 'hello' });
  store.appendChat(bot.id, { role: 'action', content: '⚙ schedule set to every 15 min' });
  const msgs = buildBotChatMessages(bot, store.getChat(bot.id), 'now');
  assert.ok(msgs.some(m => m.role === 'user' && m.content === 'hello'));
  assert.ok(!msgs.some(m => String(m.content).includes('⚙')));
});

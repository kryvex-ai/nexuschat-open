'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  BotStore, BotRunner, validateBotInput, buildBotMessages, buildBotChatMessages,
  BOT_INTERVAL_MIN, BOT_INTERVAL_MAX
} = require('../src/main/bots');

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ---------------- validation ---------------- */

test('validateBotInput: accepts good input, rejects bad', () => {
  const good = validateBotInput({ name: 'N', task: 'T', intervalSec: 300, providerId: 'x' });
  assert.equal(good.ok, true);
  assert.equal(good.intervalSec, 300);
  assert.equal(good.runOn, undefined, 'no runOn in this edition');
  assert.equal(good.isChief, undefined, 'no chief in this edition');
  assert.equal(validateBotInput({ name: '', task: 'T' }).ok, false);
  assert.equal(validateBotInput({ name: 'N', task: '' }).ok, false);
  assert.equal(validateBotInput({ name: 'N', task: 'T', intervalSec: 5 }).ok, false);
  assert.equal(validateBotInput({ name: 'N', task: 'T', intervalSec: BOT_INTERVAL_MAX + 1 }).ok, false);
  assert.equal(validateBotInput({ name: 'N', task: 'T', intervalSec: 'not-a-number' }).ok, false);
  assert.equal(validateBotInput({ name: 'N', task: 'T' }).intervalSec, 3600);
  // partial (edit) mode allows sparse patches
  const partial = validateBotInput({ task: 'New task' }, true);
  assert.equal(partial.ok, true);
  assert.equal(partial.task, 'New task');
  assert.equal(partial.name, undefined);
});

test('buildBotMessages: task is the user message, context in system', () => {
  const msgs = buildBotMessages({ name: 'B', task: 'Do X', lastOutput: 'prev' }, '2026-01-01 00:00 UTC');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, 'Do X');
  assert.match(msgs[0].content, /Do X/);
  assert.match(msgs[0].content, /prev/);
});

/* ---------------- BotStore ---------------- */

test('BotStore: create/get/update/status/remove + persistence', () => {
  const dir = tmpDir('nexus-bots-');
  const s = new BotStore(dir);
  assert.deepEqual(s.list(), []);
  const bot = s.create({ name: 'B1', task: 'T1', intervalSec: 60, providerId: 'ollama', model: 'm' });
  assert.ok(bot.id);
  assert.equal(bot.status, 'running');
  assert.equal('runOn' in bot, false, 'bots have no runOn in this edition');
  assert.equal('isChief' in bot, false, 'bots have no chief flag in this edition');
  assert.ok(Date.parse(bot.nextRunAt) <= Date.now() + 1000, 'new bot runs almost immediately');
  assert.equal(s.list().length, 1);
  s.setStatus(bot.id, 'paused');
  assert.equal(s.get(bot.id).status, 'paused');
  assert.deepEqual(s.due(), [], 'paused bots are never due');
  s.setStatus(bot.id, 'running');
  assert.equal(s.due().length, 1);
  s.update(bot.id, { name: 'B1!' });
  assert.equal(s.get(bot.id).name, 'B1!');
  // persistence across instances
  const s2 = new BotStore(dir);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.get(bot.id).name, 'B1!');
  assert.equal(s2.remove(bot.id), true);
  assert.deepEqual(s2.list(), []);
});

test('BotStore: recordRun reschedules + caps history', () => {
  const s = new BotStore(tmpDir('nexus-bots-'));
  const bot = s.create({ name: 'B', task: 'T', intervalSec: 60 });
  s.recordRun(bot.id, { output: 'out-1', status: 'success' });
  const after = s.get(bot.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.lastOutput, 'out-1');
  assert.ok(Date.parse(after.nextRunAt) > Date.now() + 30000, 'next run pushed out by interval');
  assert.deepEqual(s.due(), [], 'just-ran bot is not due again');
  for (let i = 0; i < 60; i++) s.recordRun(bot.id, { output: 'x' + i });
  assert.ok(s.getRuns(bot.id, 100).length <= 50, 'history capped');
});

/* ---------------- BotRunner ---------------- */

test('BotRunner: runs due bots, skips overlaps, records errors', async () => {
  const s = new BotStore(tmpDir('nexus-bots-'));
  const okBot = s.create({ name: 'OK', task: 'T', intervalSec: 60 });
  const failBot = s.create({ name: 'FAIL', task: 'T', intervalSec: 60 });
  const calls = [];
  const runner = new BotRunner({
    store: s,
    executor: async ({ bot }) => {
      calls.push(bot.id);
      if (bot.id === failBot.id) throw new Error('boom');
      return 'did the thing';
    },
    onEvent: () => {}
  });
  const ran = await runner.runDue();
  assert.equal(ran, 2);
  assert.equal(s.get(okBot.id).runCount, 1);
  assert.equal(s.get(okBot.id).lastStatus, 'success');
  assert.equal(s.get(failBot.id).lastStatus, 'error');
  assert.match(s.get(failBot.id).lastOutput, /boom/);
  assert.equal(await runner.runDue(), 0, 'nothing due right after a run');
  runner.stop();
});

test('BotRunner: manual run works on paused bots without unpausing', async () => {
  const s = new BotStore(tmpDir('nexus-bots-'));
  const bot = s.create({ name: 'P', task: 'T', intervalSec: 3600 });
  s.setStatus(bot.id, 'paused');
  const runner = new BotRunner({ store: s, executor: async () => 'manual out', onEvent: () => {} });
  const run = await runner.runOne(bot.id, true);
  assert.ok(run);
  assert.equal(run.output, 'manual out');
  assert.equal(s.get(bot.id).status, 'paused', 'still paused after manual run');
  assert.equal(await runner.runDue(), 0);
  runner.stop();
});

test('BotStore chat: append/get/cap/persistence/cleared on remove', () => {
  const dir = tmpDir('nexus-bots-');
  const s = new BotStore(dir);
  const bot = s.create({ name: 'C', task: 'T', intervalSec: 60 });
  assert.deepEqual(s.getChat(bot.id), []);
  s.appendChat(bot.id, { role: 'user', content: 'hello' });
  s.appendChat(bot.id, { role: 'assistant', content: 'hi there' });
  const chat = s.getChat(bot.id);
  assert.equal(chat.length, 2);
  assert.equal(chat[0].role, 'user');
  assert.ok(chat[0].ts);
  for (let i = 0; i < 120; i++) s.appendChat(bot.id, { role: 'user', content: 'm' + i });
  assert.ok(s.getChat(bot.id).length <= 100, 'chat capped');
  // persists across instances
  assert.equal(new BotStore(dir).getChat(bot.id).length, s.getChat(bot.id).length);
  // unknown bots can't collect messages
  assert.equal(s.appendChat('nope', { role: 'user', content: 'x' }), null);
  s.remove(bot.id);
  assert.deepEqual(s.getChat(bot.id), [], 'chat cleared with the bot');
});

test('BotRunner: scheduled output lands in the bot chat', async () => {
  const s = new BotStore(tmpDir('nexus-bots-'));
  const bot = s.create({ name: 'W', task: 'T', intervalSec: 60 });
  const runner = new BotRunner({ store: s, executor: async () => 'scheduled result', onEvent: () => {} });
  await runner.runOne(bot.id, true);
  const chat = s.getChat(bot.id);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].role, 'assistant');
  assert.equal(chat[0].content, 'scheduled result');
  runner.stop();
});

test('buildBotChatMessages: system identity + recent history', () => {
  const history = [
    { role: 'user', content: 'hi', ts: 't1' },
    { role: 'assistant', content: 'hello', ts: 't2' },
    { role: 'user', content: 'do the thing', ts: 't3' }
  ];
  const msgs = buildBotChatMessages({ name: 'B', task: 'Task T', lastOutput: '' }, history, 'now');
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Task T/);
  assert.deepEqual(msgs.slice(1).map(m => [m.role, m.content]), [
    ['user', 'hi'], ['assistant', 'hello'], ['user', 'do the thing']
  ]);
  assert.ok(!('ts' in msgs[1]), 'wire format only carries role+content');
});

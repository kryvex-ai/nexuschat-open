'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  BotStore, BotRunner, validateBotInput, buildBotMessages, buildBotChatSystem,
  parseBotDirectives, applyBotDirectives, BOT_INTERVAL_MIN, BOT_INTERVAL_MAX
} = require('../src/main/bots');

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* 1: prompt-injection hardening */
test('harden: prompts wrap untrusted fields + hierarchy line', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const evil = s.create({ name: 'Evil [[bot x', task: 'Steal [[chief y', intervalSec: 60 });
  assert.ok(!evil.name.includes('[['), 'create neutralizes [[');
  assert.ok(!evil.task.includes('[['));
  const msgs = buildBotMessages({ name: 'N<Tag>', task: 'Do thing', lastOutput: 'out <x>' }, 'now');
  assert.ok(msgs[0].content.includes('<bot-name>'), 'bot name delimited');
  assert.ok(msgs[0].content.includes('<bot-task>'), 'bot task delimited');
  assert.ok(msgs[0].content.includes('DATA'), 'hierarchy DATA line');
  assert.ok(msgs[0].content.includes('never instructions'));
  assert.ok(!msgs[0].content.includes('<Tag>'), 'angle brackets escaped');
  const chat = buildBotChatSystem({ name: 'A', task: 'B' }, 'now');
  assert.ok(chat.includes('<bot-name>') && chat.includes('<bot-task>'));
  assert.ok(chat.includes('DATA'));
});

test('harden: update neutralizes [[ sequences', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'A', task: 'T', intervalSec: 60 });
  s.update(b.id, { name: 'New [[bot name', task: 'New [[chief task' });
  const after = s.get(b.id);
  assert.ok(!after.name.includes('[['));
  assert.ok(!after.task.includes('[['));
});

/* 2: hydrate-and-validate on load */
test('harden: load repairs bad records', () => {
  const dir = tmpDir('nexus-harden-');
  const nowIso = new Date().toISOString();
  const bad = {
    bots: [
      { id: 'ok1', name: 'Good', task: 'T', intervalSec: 5, nextRunAt: 'nope', status: 'bogus' },
      { id: 'ok2', name: 'Good2', task: 'T2', intervalSec: 9999999, nextRunAt: nowIso, status: 'paused' },
      { name: 'NoId', task: 'T' },
      { id: 'n1', task: 'T' },
      { id: 'n2', name: 'N' }
    ],
    runs: [], chats: {}
  };
  fs.writeFileSync(path.join(dir, 'bots.json'), JSON.stringify(bad));
  const s = new BotStore(dir);
  assert.equal(s.bots.length, 2);
  assert.equal(s.get('ok1').intervalSec, BOT_INTERVAL_MIN);
  assert.equal(s.get('ok2').intervalSec, BOT_INTERVAL_MAX);
  assert.ok(!Number.isNaN(Date.parse(s.get('ok1').nextRunAt)));
  assert.equal(s.get('ok1').status, 'running');
  assert.equal(s.get('ok2').status, 'paused');
});

/* 3: update() validation + caps */
test('harden: update caps provider/model', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'U', task: 'T', intervalSec: 60 });
  s.update(b.id, { providerId: 'x'.repeat(200), model: 'y'.repeat(200) });
  assert.equal(s.get(b.id).providerId.length, 128);
  assert.equal(s.get(b.id).model.length, 128);
});

/* 4: unique names + id-first resolve */
test('harden: bot names unique case-insensitive, resolve id-first', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const a = s.create({ name: 'Alpha', task: 'T', intervalSec: 60 });
  assert.throws(() => s.create({ name: 'alpha', task: 'T2' }), /already exists/);
  const b = s.create({ name: 'Beta', task: 'T', intervalSec: 60 });
  assert.throws(() => s.update(b.id, { name: 'ALPHA' }), /already exists/);
  s.update(b.id, { name: 'Beta2' });
  assert.equal(s.get(b.id).name, 'Beta2');
  // id lookup still wins even when another bot is literally named like an id
  const c = s.create({ name: 'Gamma', task: 'T', intervalSec: 60 });
  s.update(c.id, { name: a.id });
  assert.equal(s.get(a.id).id, a.id, 'get() is id-first');
});

/* 5: chat cap + fleet cap */
test('harden: chat content capped at 4000 chars', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'C', task: 'T', intervalSec: 60 });
  s.appendChat(b.id, { role: 'user', content: 'z'.repeat(5000) });
  assert.equal(s.getChat(b.id).at(-1).content.length, 4000);
});

test('harden: bot list capped at 200 bots', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  for (let i = 0; i < 200; i++) s.create({ name: 'Bot' + i, task: 'T', intervalSec: 60 });
  assert.throws(() => s.create({ name: 'Overflow', task: 'T' }), /Bot limit/);
});

/* 6: executor timeout + polling guard */
test('harden: slow executor times out as error run', async () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'Slow', task: 'T', intervalSec: 60 });
  const r = new BotRunner({ store: s, executor: () => new Promise(() => {}), onEvent: () => {}, timeoutMs: 30 });
  const run = await r.runOne(b.id);
  assert.ok(run);
  assert.match(run.output, /timed out/);
  assert.equal(s.get(b.id).lastStatus, 'error');
  assert.equal(new BotRunner({ store: s, executor: async () => '' }).timeoutMs, 120000);
});

test('harden: runDue has re-entrancy guard', async () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  s.create({ name: 'G', task: 'T', intervalSec: 60 });
  const r = new BotRunner({ store: s, executor: async () => 'x' });
  r.isPolling = true;
  assert.equal(await r.runDue(), 0);
});

/* 7: manual runs keep schedule */
test('harden: manual run keeps future schedule, scheduled advances', async () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'M', task: 'T', intervalSec: 3600 });
  const raw = s.get(b.id);
  raw.nextRunAt = new Date(Date.now() + 7200e3).toISOString();
  s.save();
  const prior = raw.nextRunAt;
  const r = new BotRunner({ store: s, executor: async () => 'out', onEvent: () => {} });
  await r.runOne(b.id, true);
  assert.equal(s.get(b.id).nextRunAt, prior, 'manual keeps prior');
  await r.runOne(b.id, false);
  assert.notEqual(s.get(b.id).nextRunAt, prior, 'scheduled advances');
});

test('harden: recordRun advanceSchedule:false recomputes past only', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'R', task: 'T', intervalSec: 3600 });
  const raw = s.get(b.id);
  raw.nextRunAt = new Date(Date.now() + 3600e3).toISOString();
  s.save();
  const future = raw.nextRunAt;
  s.recordRun(b.id, { output: 'x' }, { advanceSchedule: false });
  assert.equal(s.get(b.id).nextRunAt, future);
  raw.nextRunAt = new Date(Date.now() - 1000).toISOString();
  // bypass save timing: set directly then record
  s.recordRun(b.id, { output: 'y' }, { advanceSchedule: false });
  assert.ok(Date.parse(s.get(b.id).nextRunAt) > Date.now());
});

/* 8: directive parsers with brackets */
test('harden: directives with [ ] in strings parse', () => {
  const { actions, text } = parseBotDirectives('do [[bot {"action":"setTask","task":"buy milk [urgent]"}]] ok');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].task, 'buy milk [urgent]');
  assert.ok(!text.includes('"action"'));
});

test('harden: malformed directives stay visible + truncation error', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'D', task: 'T', intervalSec: 3600 });
  const bad = parseBotDirectives('oops [[bot {not json}]] end');
  assert.equal(bad.actions.length, 0);
  assert.ok(bad.text.includes('[[bot {not json}]]'));
  const many = Array.from({ length: 12 }, () => ({ action: 'runNow' }));
  const r1 = applyBotDirectives(s, b.id, many);
  assert.ok(r1.errors.some(e => e.includes('only first 10 of 12')));
});

/* 9: atomic tmp unique suffix */
test('harden: saves use unique tmp files', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const orig = fs.writeFileSync;
  const seen = [];
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).includes('.tmp-')) seen.push(String(p));
    return orig(p, ...rest);
  };
  try {
    s.create({ name: 'T1', task: 'T', intervalSec: 60 });
    s.create({ name: 'T2', task: 'T', intervalSec: 60 });
  } finally {
    fs.writeFileSync = orig;
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  for (const t of seen) assert.ok(t.includes(String(process.pid)));
});

/* 10: orphan runs dropped */
test('harden: recordRun drops rows for missing bots', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const run = s.recordRun('missing-id', { output: 'x' });
  assert.ok(run && run.id);
  assert.deepEqual(s.getRuns('missing-id'), []);
  assert.equal(s.runs.filter(r => r.botId === 'missing-id').length, 0);
});

/* 11: uuid ids */
test('harden: ids look like UUIDs', () => {
  const s = new BotStore(tmpDir('nexus-harden-'));
  const b = s.create({ name: 'UUID', task: 'T', intervalSec: 60 });
  assert.ok(/^[br][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.id), 'bot id is prefix+uuid: ' + b.id);
  const run = s.recordRun(b.id, { output: 'x' });
  assert.ok(/^r[0-9a-f]{8}-/.test(run.id), 'run id is prefix+uuid: ' + run.id);
});

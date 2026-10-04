'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeError, assertOk } = require('../src/main/providers/index');
const { Store, PLAIN } = require('../src/main/store');

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function outOf(input) {
  const r = sanitizeError(input);
  return typeof r === 'string' ? r : String((r && r.message) || '');
}

/* (a) sanitizeError redacts secrets but preserves ordinary messages. */
test('sanitizeError redacts key patterns', () => {
  const sk = 'sk-abcDEF1234-_xyz';
  assert.ok(!outOf('key is ' + sk).includes(sk));
  assert.ok(outOf('key is ' + sk).includes('[redacted]'));
  assert.ok(!outOf('auth Bearer mysecrettoken123').includes('mysecrettoken123'));
  assert.ok(outOf('auth Bearer mysecrettoken123').includes('Bearer [redacted]'));
  assert.ok(!outOf('login failed apiKey: hunter2secret!').includes('hunter2secret!'));
  assert.ok(outOf('login failed apiKey: hunter2secret!').includes('[redacted]'));
  assert.ok(!outOf('got xoxb-1234567890-abcdef').includes('xoxb-1234567890-abcdef'));
  assert.ok(!outOf('token ghp_abcdef1234567890').includes('ghp_abcdef1234567890'));
  assert.ok(!outOf('token gsk_abcdef1234567890').includes('gsk_abcdef1234567890'));
  assert.ok(!outOf('reply key="supersecretvalue123" end').includes('supersecretvalue123'));
});

test('sanitizeError preserves ordinary messages', () => {
  for (const m of [
    'Request timed out after 30s',
    'HTTP 500 Internal Server Error',
    'ECONNREFUSED 127.0.0.1:8787',
    'Add your openai API key in the Providers tab',
    'Connected to Anthropic (beta: false)'
  ]) {
    assert.equal(outOf(m), m, 'should preserve: ' + m);
  }
  const e = sanitizeError(new Error('ECONNREFUSED with sk-abcDEF1234'));
  assert.ok(e instanceof Error);
  assert.ok(!e.message.includes('sk-abcDEF1234'));
  assert.ok(e.message.includes('[redacted]'));
});

/* (b) assertOk surfaces HTTP status while redacting echoed keys. */
test('assertOk redacts echoed key but keeps HTTP status', async () => {
  const raw = 'sk-abcDEF1234567890';
  const res = {
    ok: false, status: 400, statusText: 'Bad Request',
    text: async () => 'invalid apiKey: ' + raw
  };
  await assert.rejects(assertOk(res), err => {
    assert.ok(/HTTP 400/.test(err.message), 'keeps status: ' + err.message);
    assert.ok(!err.message.includes(raw), 'redacts echo');
    assert.ok(err.message.includes('[redacted]'));
    assert.equal(err.status, 400);
    return true;
  });
});

/* (c) no license/session state exists in this edition. */
test('no license state is stored at all', () => {
  const dir = tmpDir('nexus-secrets-lic-');
  const store = new Store(dir, PLAIN);
  store.updateSettings({ theme: 'light' });
  store.createConversation('hi');
  assert.equal(store.getLicense, undefined, 'the store has no license API');
  assert.equal(store.setLicense, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'license.json')), false, 'no license file is written');
  assert.deepEqual(
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(),
    ['conversations.json', 'settings.json'],
    'only settings and chats live on disk'
  );
});

/* (d) written files are owner-only. */
test('written files are 0600 (owner-only)', () => {
  const dir = tmpDir('nexus-secrets-perm-');
  const store = new Store(dir, PLAIN);
  store.updateSettings({ theme: 'light' });
  store.createConversation('hi');
  for (const f of ['settings.json', 'conversations.json']) {
    const mode = fs.statSync(path.join(dir, f)).mode & 0o777;
    assert.equal(mode & 0o077, 0, f + ' group/other bits set: ' + mode.toString(8));
  }
});

/* (e) corrupt quarantine caps .bak count at 5. */
test('corrupt quarantine keeps at most 5 backups', () => {
  const dir = tmpDir('nexus-secrets-quar-');
  const s = new Store(dir, PLAIN);
  s.updateSettings({ theme: 'light' });
  const target = path.join(dir, 'settings.json');
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(target, '{"broken": ' + i);
    new Store(dir, PLAIN); // each load quarantines
  }
  const baks = fs.readdirSync(dir).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'));
  assert.ok(baks.length <= 5, 'got ' + baks.length);
  assert.ok(baks.length >= 1, 'keeps at least one backup');
});

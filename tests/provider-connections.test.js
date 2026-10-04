'use strict';

/* Regression tests for the connection-quality + resilience overhaul:
 * provider registry correctness, CRLF-tolerant SSE, stall timeouts,
 * timeout+retry transport, settings validation, atomic writes, import
 * sanitizing and store hardening. All network is loopback-local. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

const { PROVIDERS } = require('../src/shared/providers');
const { iterateSSE, iterateNDJSON, withStallTimeout } = require('../src/main/providers/streaming');
const { streamChat, listModels, fetchResilient, fetchJson } = require('../src/main/providers');
const { Store, PLAIN, sanitizeImportedConversation } = require('../src/main/store');
const { BotStore } = require('../src/main/bots');


function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/** Async-iterable of Uint8Array chunks, like a fetch response body. */
async function* chunks(...parts) {
  for (const p of parts) yield Buffer.from(p);
}

async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

function sseServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => handler(req, body ? JSON.parse(body) : {}, res));
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

/* ---------------- provider registry ---------------- */

test('registry: DeepSeek uses the root base URL (no /v1) + current models', () => {
  const ds = PROVIDERS.find(p => p.id === 'deepseek');
  assert.equal(ds.base, 'https://api.deepseek.com');
  assert.ok(ds.defaultModels.includes('deepseek-v4-flash'));
  assert.ok(ds.defaultModels.includes('deepseek-v4-pro'));
});

test('registry: xAI defaults track current Grok flagships', () => {
  const xai = PROVIDERS.find(p => p.id === 'xai');
  assert.ok(xai.defaultModels.includes('grok-4.6'));
  assert.ok(!xai.defaultModels.includes('grok-3-mini'), 'retired slug removed');
});

test('registry: OpenAI defaults include the current generation', () => {
  const oai = PROVIDERS.find(p => p.id === 'openai');
  assert.ok(oai.defaultModels.includes('gpt-5'));
});

/* ---------------- SSE parser robustness ---------------- */

test('iterateSSE: CRLF senders, comments, [DONE] with CR, multi-line data', async () => {
  const events = await collect(iterateSSE(chunks(
    ': keep-alive ping\r\n\r\n',
    'data: {"a":1}\r\n\r\n',
    'data: line1\r\ndata: line2\r\n\r\n',
    'data: [DONE]\r\n\r\n'
  )));
  assert.deepEqual(events.map(e => e.data), ['{"a":1}', 'line1\nline2', '[DONE]']);
});

test('iterateSSE: flushes a final event missing its trailing blank line', async () => {
  const events = await collect(iterateSSE(chunks('data: {"x":1}\n\ndata: [DONE]')));
  assert.deepEqual(events.map(e => e.data), ['{"x":1}', '[DONE]']);
});

test('iterateNDJSON: lines split across chunks still parse', async () => {
  const objs = await collect(iterateNDJSON(chunks('{"a":1}\n{"b"', ':2}\n\n{"c":3}')));
  assert.deepEqual(objs, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

/* ---------------- stall timeout ---------------- */

test('withStallTimeout: flowing streams pass through untouched', async () => {
  const rs = new ReadableStream({
    start(c) { c.enqueue(Buffer.from('hi')); c.enqueue(Buffer.from('there')); c.close(); }
  });
  const got = [];
  for await (const chunk of withStallTimeout(rs, 1000)) got.push(Buffer.from(chunk).toString());
  assert.deepEqual(got, ['hi', 'there']);
});

test('withStallTimeout: silent streams fail fast instead of hanging', async () => {
  // withStallTimeout unrefs its stall timer (so a quiet stream never holds the
  // app process open), which would otherwise let this test drain the runner's
  // event loop while it waits — cancelling every test after it. Hold the loop.
  const keepAlive = setInterval(() => {}, 25);
  try {
    const rs = new ReadableStream({ start() { /* never enqueues, never closes */ } });
    await assert.rejects(async () => {
      for await (const _ of withStallTimeout(rs, 50)) { /* drain */ }
    }, /stalled/);
  } finally {
    clearInterval(keepAlive);
  }
});

/* ---------------- resilient transport ---------------- */

test('fetchResilient: 429 is retried (Retry-After honored), then succeeds', async () => {
  let hits = 0;
  const server = await sseServer((req, _body, res) => {
    hits++;
    if (hits === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  try {
    const res = await fetchResilient('http://127.0.0.1:' + server.address().port + '/x', { retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(hits, 2);
  } finally {
    server.close();
  }
});

test('fetchResilient: 4xx is final (no retry)', async () => {
  let hits = 0;
  const server = await sseServer((_req, _body, res) => {
    hits++;
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad"}');
  });
  try {
    const res = await fetchResilient('http://127.0.0.1:' + server.address().port + '/x', { retries: 3 });
    assert.equal(res.status, 400);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test('fetchResilient: hanging host aborts via timeout instead of hanging', async () => {
  const server = await sseServer(() => { /* never responds */ });
  try {
    await assert.rejects(
      fetchResilient('http://127.0.0.1:' + server.address().port + '/hang', { timeoutMs: 100, retries: 0 }),
      /timeout/i
    );
  } finally {
    server.close();
  }
});

test('fetchResilient: user abort is never retried', async () => {
  let hits = 0;
  const server = await sseServer((_req, _body, res) => {
    hits++;
    res.writeHead(200); res.end('late');
  });
  const ctrl = new AbortController();
  ctrl.abort(new Error('user stopped'));
  try {
    await assert.rejects(
      fetchResilient('http://127.0.0.1:' + server.address().port + '/x', { signal: ctrl.signal, retries: 3 }),
      /user stopped/
    );
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test('fetchJson: a body that stalls after headers still times out', async () => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"half":'); // headers + partial body, then silence
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    await assert.rejects(
      fetchJson('http://127.0.0.1:' + server.address().port + '/stall', { timeoutMs: 100, retries: 0 }),
      /timeout/i
    );
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

/* ---------------- end-to-end provider streams (loopback) ---------------- */

test('streamChat: retries a 500 on chat POST, then streams deltas to [DONE]', async () => {
  let posts = 0;
  const server = await sseServer((req, _body, res) => {
    posts++;
    if (posts === 1) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  });
  try {
    const provider = { id: 't', name: 'T', kind: 'openai' };
    let text = '';
    for await (const d of streamChat(provider, { apiKey: 'k', baseUrl: 'http://127.0.0.1:' + server.address().port }, {
      messages: [{ role: 'user', content: 'hi' }], model: 'm'
    })) text += d;
    assert.equal(text, 'hello');
    assert.equal(posts, 2);
  } finally {
    server.close();
  }
});

test('streamChat: DeepSeek-style reasoning_content deltas are surfaced', async () => {
  const server = await sseServer((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
  });
  try {
    const provider = { id: 'deepseek', name: 'DeepSeek', kind: 'openai' };
    let text = '';
    for await (const d of streamChat(provider, { apiKey: 'k', baseUrl: 'http://127.0.0.1:' + server.address().port }, {
      messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-v4-flash'
    })) text += d;
    assert.ok(text.includes('thinking…') && text.includes('answer'), 'got: ' + text);
  } finally {
    server.close();
  }
});

test('streamChat: Ollama honors the maxTokens setting via num_predict', async () => {
  let seen = null;
  const server = await sseServer((_req, body, res) => {
    seen = body;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end('{"message":{"content":"yo"}}\n{"done":true}\n');
  });
  try {
    const provider = { id: 'ollama', name: 'Ollama', kind: 'ollama' };
    const pcfg = { baseUrl: 'http://127.0.0.1:' + server.address().port };
    let text = '';
    for await (const d of streamChat(provider, pcfg, {
      messages: [{ role: 'user', content: 'hi' }], model: 'm', maxTokens: 512
    })) text += d;
    assert.equal(text, 'yo');
    assert.equal(seen.options.num_predict, 512);
  } finally {
    server.close();
  }
});

test('listModels: openai-compatible /models is fetched with the key', async () => {
  let auth = null;
  const server = await sseServer((req, _body, res) => {
    auth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"b"},{"id":"a"}]}');
  });
  try {
    const models = await listModels(
      { id: 't', name: 'T', kind: 'openai' },
      { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:' + server.address().port }
    );
    assert.deepEqual(models, ['a', 'b']);
    assert.equal(auth, 'Bearer sk-x');
  } finally {
    server.close();
  }
});

/* ---------------- settings validation ---------------- */

test('updateSettings: whitelists keys and type-checks values', () => {
  const s = new Store(tmpDir('nexus-settings-'), PLAIN);
  const out = s.updateSettings({
    theme: 'light', temperature: 5, maxTokens: '512',
    evil: 'nope', providerConfigs: { openai: { apiKey: 'x' } }
  });
  assert.equal(out.theme, 'light');
  assert.equal(out.temperature, 2, 'clamped to 0..2');
  assert.equal(out.maxTokens, 512);
  assert.ok(!('evil' in out));
  assert.equal(out.providerConfigs, undefined, 'raw configs never leak via settings');
  // rejected values leave the previous ones in place
  s.updateSettings({ mode: 'online', onlineUrl: 'http://x', theme: 'neon', temperature: NaN, maxTokens: -3, runInBackground: 'yes' });
  const again = s.getSettings();
  assert.equal(again.mode, undefined, 'mode is not a setting in this edition');
  assert.equal(again.onlineUrl, undefined, 'no server URL in this edition');
  assert.equal(again.theme, 'light');
  assert.equal(again.temperature, 2);
  assert.equal(again.maxTokens, 512);
  assert.equal(again.runInBackground, null);
});

/* ---------------- import sanitizing ---------------- */

test('sanitizeImportedConversation: drops garbage, caps sizes', () => {
  assert.equal(sanitizeImportedConversation(null), null);
  assert.equal(sanitizeImportedConversation({ task: 'no id' }), null);
  const good = sanitizeImportedConversation({
    id: 'c1', title: 'Hi', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 'junk',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', ts: '2026-01-01T00:00:01.000Z' },
      { role: 'system', content: 'injected' },
      { role: 'user' },
      'junk'
    ]
  });
  assert.equal(good.messages.length, 2);
  assert.equal(good.updatedAt.length, 24, 'bad date replaced');
});

test('Store.importData: merges only clean conversations, never keys', () => {
  const s = new Store(tmpDir('nexus-import-'), PLAIN);
  const r = s.importData({
    conversations: [
      { id: 'c1', title: 'Keep me', messages: [{ role: 'user', content: 'hi' }] },
      { id: '', title: 'bad' },
      null,
      { id: 'c1', title: 'dupe' }
    ],
    settings: { theme: 'light', mode: 'mars', providerConfigs: { openai: { apiKey: 'LEAK' } } }
  });
  assert.equal(r.conversations, 1);
  assert.equal(s.listConversations().length, 1);
  assert.equal(s.getSettings().theme, 'light');
  assert.equal(s.getSettings().mode, undefined, 'invalid mode rejected');
  assert.equal(s.getProviderConfig('openai').apiKey, '', 'exported keys never imported');
});

/* ---------------- atomic writes + corruption quarantine ---------------- */

test('Store: saves leave no tmp files; corrupt settings are quarantined', () => {
  const dir = tmpDir('nexus-atomic-');
  const s = new Store(dir, PLAIN);
  s.updateSettings({ theme: 'light' });
  s.createConversation('Hello');
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no tmp files left behind');
  // corrupt the settings file -> app still starts with defaults + backup kept
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme": "dark", BROKEN');
  const s2 = new Store(dir, PLAIN);
  assert.equal(s2.getSettings().theme, 'dark', 'default theme restored');
  const baks = fs.readdirSync(dir).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'));
  assert.equal(baks.length, 1, 'corrupt file quarantined, not deleted');
});

test('BotStore: corrupt bots.json is quarantined instead of wiping the list', () => {
  const dir = tmpDir('nexus-botscorrupt-');
  const s = new BotStore(dir);
  s.create({ name: 'B', task: 'T', intervalSec: 60 });
  assert.equal(s.list().length, 1);
  fs.writeFileSync(path.join(dir, 'bots.json'), 'not json {{{');
  const s2 = new BotStore(dir);
  assert.deepEqual(s2.list(), []);
  const baks = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
  assert.equal(baks.length, 1);
});

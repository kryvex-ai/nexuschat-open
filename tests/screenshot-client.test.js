'use strict';

/**
 * The CDP client behind scripts/screenshot.js, against a socket of our own.
 *
 * The tour drives a live window, so the failure it cannot survive is a
 * session that dies while a command is in flight: the old client parked that
 * promise forever, `tour()` never returned, `stopApp()` was never reached and
 * `--boot` walked away from an orphan Electron plus a `nexus-shot-*` profile
 * (AGENTS.md trap #3). Everything below is proved with a stub — no real
 * connection, no Electron — and covers the three ways a call must now end:
 * a reply, a dead session, and a server that simply never answers.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const shot = require('../scripts/screenshot.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'screenshot.js'), 'utf8');

/* ---------------- a stub WebSocket, just enough for attach() ---------------- */

class StubSocket {
  constructor(url) {
    StubSocket.last = this;
    this.url = url;
    this.sent = [];      // every frame write() pushed at the wire
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { if (this.onopen) this.onopen(); }
  reply(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
  drop() { if (this.onclose) this.onclose(); }
}

/**
 * attach() wires its socket handlers before it first yields, so the stub is
 * ready the moment the call returns.
 */
async function connect(opts) {
  const attaching = shot.attach('ws://127.0.0.1:9333/stub', { ...opts, WebSocket: StubSocket });
  const sock = StubSocket.last;
  assert.equal(typeof sock.onopen, 'function', 'attach wires the socket before it awaits it');
  sock.open();
  return { client: await attaching, sock };
}

const timeouts = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

/* ---------------- the module ---------------- */

test('requiring screenshot.js hands over the client without starting the tour', () => {
  assert.equal(typeof shot.attach, 'function');
  assert.equal(typeof shot.CALL_TIMEOUT, 'number');
  assert.match(source, /require\.main === module/, 'the tour runs only when the file is the entry point');
  assert.match(source, /module\.exports = \{ attach/, 'the client is exported for the tests');
});

test('the default CDP deadline is 30 seconds', () => {
  assert.equal(shot.CALL_TIMEOUT, 30000);
});

/* ---------------- a healthy round trip ---------------- */

test('a reply settles the call and clears it from the waiting map', async () => {
  const { client, sock } = await connect();
  const pending = client.call('Page.captureScreenshot', { format: 'png' });
  assert.equal(client.pending, 1, 'the call is tracked while it waits');
  assert.deepEqual(sock.sent, [{ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }]);
  sock.reply({ id: 1, result: { data: 'AAAA' } });
  const reply = await pending;
  assert.equal(reply.result.data, 'AAAA');
  assert.equal(client.pending, 0, 'the answered call is gone from the map');
});

test('a settled call clears its deadline timer', async () => {
  const baseline = timeouts();
  const { client, sock } = await connect();
  const pending = client.call('Runtime.enable', {}, 60000);
  assert.ok(timeouts() > baseline, 'the deadline is armed while the call waits');
  sock.reply({ id: 1, result: {} });
  await pending;
  await new Promise(r => setImmediate(r));
  assert.equal(client.pending, 0);
  assert.equal(timeouts(), baseline, 'a resolved call leaves no timer holding the process open');
});

/* ---------------- the session dies mid-call ---------------- */

test('a socket closing mid-call rejects every waiter and empties the map', async () => {
  const { client, sock } = await connect();
  const a = client.call('Page.captureScreenshot', {});
  const b = client.call('Runtime.evaluate', { expression: '1' });
  assert.equal(client.pending, 2);
  sock.drop();
  await assert.rejects(a, /CDP session closed/);
  await assert.rejects(b, /CDP session closed/);
  assert.equal(client.pending, 0, 'nothing is left waiting on a dead session');
});

test('a socket error mid-call rejects the waiter the same way', async () => {
  const { client, sock } = await connect();
  const pending = client.call('Runtime.enable');
  sock.onerror();
  await assert.rejects(pending, /CDP session closed/);
  assert.equal(client.pending, 0);
});

test('once the session is closed, later calls reject immediately', async () => {
  const { client, sock } = await connect();
  sock.drop();
  const sent = sock.sent.length;
  await assert.rejects(client.call('Runtime.enable'), /CDP session closed/);
  assert.equal(client.pending, 0);
  assert.equal(sock.sent.length, sent, 'a dead session is not written to');
  await assert.rejects(client.evaluate('1 + 1'), /CDP session closed/);
});

/* ---------------- the server never answers ---------------- */

test('a call nobody answers rejects with the method name at its deadline', async () => {
  const { client, sock } = await connect({ timeoutMs: 25 });
  await assert.rejects(client.call('Page.captureScreenshot'), /CDP timeout: Page.captureScreenshot/);
  assert.equal(client.pending, 0, 'the abandoned call is dropped from the map');
  // A reply that turns up after the deadline must not resurrect it.
  sock.reply({ id: 1, result: {} });
  assert.equal(client.pending, 0);
});

test('a per-call deadline overrides the client default', async () => {
  const { client } = await connect({ timeoutMs: 60000 });
  await assert.rejects(client.call('Foo.bar', {}, 20), /CDP timeout: Foo.bar/);
  assert.equal(client.pending, 0);
});

/* ---------------- the shape of a mid-tour drop ---------------- */

test('a session drop between steps unwinds the tour instead of hanging', async () => {
  const { client, sock } = await connect();
  const first = client.evaluate('1 + 1');
  sock.reply({ id: 1, result: { result: { value: 2 } } });
  assert.equal(await first, 2, 'the step before the drop ran normally');
  sock.drop();
  // Every later step rejects at once, so tour() throws, main() catches it
  // and stopApp() still runs — the script reports and exits.
  await assert.rejects(client.evaluate('2 + 2'), /CDP session closed/);
  assert.equal(client.pending, 0);
});

/* ---------------- how the run itself is fenced in ---------------- */

test('the run tears the app down on every path and keeps the old exit rule', () => {
  const mainBody = source.slice(source.indexOf('async function main'));
  assert.match(mainBody, /finally \{[\s\S]*?await stopApp\(bootApp\)/,
    'stopApp() sits in a finally, so a thrown tour still tears the app down');
  assert.match(mainBody, /setTimeout\(\(\) => \{[\s\S]*?process\.exit\(1\)/,
    'a watchdog guarantees the process exits even if the flow itself wedges');
  assert.match(mainBody, /process\.exit\(ran && images\.length >= 6 \? 0 : 1\)/,
    'the exit code still counts images, not skips');
});

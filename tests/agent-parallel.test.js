'use strict';

/**
 * Codex-style batching: independent reads in one reply run together, writes
 * stay sequential, identical calls in a batch run once. Same permission
 * semantics, same result order — fewer round-trips per turn.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { ToolHost, PermissionGate } = require('../src/main/tools');

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function allowHost(root) {
  return new ToolHost({ root, gate: new PermissionGate({ ask: async () => ({ decision: 'allow' }) }) });
}

/** A host whose executor is a scripted stub: records order + timing. */
function stubHost(script) {
  const root = tmpDir('agent-parallel-');
  const host = allowHost(root);
  const events = []; // { call, at, end }
  let executions = 0;
  host.invoke = async (call) => {
    executions++;
    const at = Date.now();
    events.push({ call: call.name + ':' + JSON.stringify(call.args), at, end: -1 });
    const out = await script(call, events.length - 1);
    events[events.length - 1].end = Date.now();
    return out;
  };
  return { host, events, executions: () => executions };
}

const okRead = (p) => ({ tool: 'read_file', risk: 'read', summary: 'Read ' + p, ok: true, result: 'content of ' + p });

test('invokeMany keeps result order across a mixed batch', async () => {
  const root = tmpDir('agent-parallel-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'world\n');
  const denyGate = new PermissionGate({ ask: async (req) => ({ decision: req.name === 'write_file' ? 'deny' : 'allow' }) });
  const host = new ToolHost({ root, gate: denyGate });
  const out = await host.invokeMany([
    { id: '1', name: 'read_file', args: { path: 'a.txt' } },
    { id: '2', name: 'write_file', args: { path: 'c.txt', content: 'x' } },
    { id: '3', name: 'read_file', args: { path: 'b.txt' } }
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(r => r.tool), ['read_file', 'write_file', 'read_file']);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].denied, true);
  assert.equal(out[2].ok, true);
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false, 'the denied write never ran');
});

test('invokeMany runs identical calls in a batch once', async () => {
  const { host, executions } = stubHost(async (call) => okRead(call.args.path));
  const out = await host.invokeMany([
    { id: '1', name: 'read_file', args: { path: 'a.txt' } },
    { id: '2', name: 'read_file', args: { path: 'a.txt' } },
    { id: '3', name: 'read_file', args: { path: 'b.txt' } }
  ]);
  assert.equal(executions(), 2, 'a.txt ran once, b.txt ran once');
  assert.equal(out.length, 3);
  assert.equal(out[0].result, out[1].result);
  assert.match(out[2].result, /b\.txt/);
});

test('invokeMany runs independent reads together, not one by one', async () => {
  const { host } = stubHost(async (call) => {
    await new Promise(r => setTimeout(r, 60));
    return okRead(call.args.path);
  });
  const started = Date.now();
  const out = await host.invokeMany([
    { id: '1', name: 'read_file', args: { path: 'a.txt' } },
    { id: '2', name: 'read_file', args: { path: 'b.txt' } },
    { id: '3', name: 'list_dir', args: {} }
  ]);
  const elapsed = Date.now() - started;
  assert.equal(out.length, 3);
  assert.ok(out.every(r => r.ok), 'all three ran');
  // Sequential would cost 3 × 60ms = 180ms; together it costs ~60ms.
  assert.ok(elapsed < 150, `three reads took ${elapsed}ms — they did not run together`);
});

test('invokeMany keeps writes sequential and after the reads before them', async () => {
  const seen = [];
  const { host, events } = stubHost(async (call) => {
    seen.push('start:' + call.name);
    await new Promise(r => setTimeout(r, 30));
    seen.push('end:' + call.name);
    return call.name === 'read_file' ? okRead(call.args.path)
      : { tool: call.name, risk: 'write', summary: call.name, ok: true, result: 'wrote' };
  });
  const out = await host.invokeMany([
    { id: '1', name: 'read_file', args: { path: 'a.txt' } },
    { id: '2', name: 'read_file', args: { path: 'b.txt' } },
    { id: '3', name: 'write_file', args: { path: 'c.txt', content: 'x' } },
    { id: '4', name: 'write_file', args: { path: 'd.txt', content: 'y' } }
  ]);
  assert.equal(out.length, 4);
  assert.ok(out.every(r => r.ok));
  // The two writes never overlap: second starts after the first ends.
  const writeStarts = events.filter(e => e.call.startsWith('write_file')).map(e => e.at);
  const writeEnds = events.filter(e => e.call.startsWith('write_file')).map(e => e.end);
  assert.ok(writeStarts[1] >= writeEnds[0], 'writes ran one at a time');
  // Both writes started after both reads finished.
  const readEnds = events.filter(e => e.call.startsWith('read_file')).map(e => e.end);
  assert.ok(writeStarts[0] >= Math.max(...readEnds), 'reads before a write finish first');
});

test('invokeMany stops early and returns what ran', async () => {
  const { host } = stubHost(async (call) => okRead(call.args.path));
  const none = await host.invokeMany(
    [{ id: '1', name: 'read_file', args: { path: 'a.txt' } }],
    { shouldStop: () => true });
  assert.deepEqual(none, []);
  // Stops between groups: the read runs, the write never starts.
  let calls = 0;
  const h2 = allowHost(tmpDir('agent-parallel-'));
  h2.invoke = async (call) => { calls++; return okRead('x'); };
  const out = await h2.invokeMany(
    [
      { id: '1', name: 'read_file', args: { path: 'a.txt' } },
      { id: '2', name: 'write_file', args: { path: 'b.txt', content: 'x' } }
    ],
    { shouldStop: () => calls >= 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'read_file');
});

test('invokeMany handles unknown tools in a batch without losing order', async () => {
  const root = tmpDir('agent-parallel-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  const host = allowHost(root);
  const out = await host.invokeMany([
    { id: '1', name: 'read_file', args: { path: 'a.txt' } },
    { id: '2', name: 'rm_rf_slash', args: {} },
    { id: '3', name: 'read_file', args: { path: 'b.txt' } }
  ]);
  // Unknown tools take the sequential path (risk unknown), reads batch around them.
  assert.equal(out.length, 3);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.match(out[1].error, /no tool called/);
  assert.equal(out[2].ok, true);
});

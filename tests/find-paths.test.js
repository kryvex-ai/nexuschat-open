'use strict';

/**
 * find_paths — search by NAME (files and folders), local and remote.
 *
 * search_files/grep_files only match file contents, so a folder sitting in
 * plain sight was invisible to the model. This tool closes that gap, and the
 * manual now says one reply may hold as many directives as the task needs.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../src/shared/tools');
const fsTools = require('../src/main/tools/fs');
const remote = require('../src/main/tools/ssh-remote');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-find-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function seed(root) {
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'x\n');
  fs.writeFileSync(path.join(root, 'src', 'components', 'Button.jsx'), 'x\n');
  fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'x\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x\n');
}

/* ---------------- registry ---------------- */

test('find_paths is a read tool with validated args', () => {
  const t = T.toolByName('find_paths');
  assert.ok(t, 'in the registry');
  assert.equal(t.risk, T.RISK.READ, 'reads run without asking');
  assert.equal(t.group, 'search');
  assert.equal(T.validateArgs(t, {}).ok, false, 'query is required');
  assert.equal(T.validateArgs(t, { query: 'btn' }).ok, true);
  assert.equal(T.validateArgs(t, { query: 'x', include_dirs: 'yes' }).ok, false, 'boolean enforced');
  assert.ok(T.manual().includes('find_paths'), 'the manual lists it');
  assert.ok(T.manual().includes('no per-reply limit'), 'batching is explicit');
  assert.match(T.callSummary(t, { query: 'btn' }), /btn/);
});

/* ---------------- local executor ---------------- */

test('local find_paths sees folders, not just file contents', async () => {
  const root = tmpRoot();
  seed(root);
  const dirs = await fsTools.run('find_paths', { query: 'comp' }, { root });
  assert.ok(dirs.includes('components'), 'the folder shows up:\n' + dirs);
  assert.ok(/dir\s+src\/components/.test(dirs), 'typed as a dir:\n' + dirs);
  const files = await fsTools.run('find_paths', { query: 'button' }, { root });
  assert.ok(files.includes('Button.jsx'), 'case-insensitive file match:\n' + files);
  const nodirs = await fsTools.run('find_paths', { query: 'src', include_dirs: false }, { root });
  assert.ok(!nodirs.split('\n').some(l => l.startsWith('dir')), 'dirs excluded:\n' + nodirs);
  const scoped = await fsTools.run('find_paths', { query: 'button', path: 'assets' }, { root });
  assert.match(scoped, /No paths matching/, 'scoped away:\n' + scoped);
  const skipped = await fsTools.run('find_paths', { query: 'dep' }, { root });
  assert.match(skipped, /No paths matching/, 'generated trees stay skipped:\n' + skipped);
  await assert.rejects(
    () => fsTools.run('find_paths', { query: 'x', path: '../outside' }, { root }), /workspace/i);
  await assert.rejects(
    () => fsTools.run('find_paths', { query: 'x', path: 'src/app.js' }, { root }), /not a directory/);
});

/* ---------------- remote executor (stubbed transport) ---------------- */

const HOST = { id: 'h1', label: 'Web', host: 'web.example', user: 'me', port: 22, keyFile: '' };

test('remote find_paths asks find for names, quoted and literal', async () => {
  const calls = [];
  const ssh = {
    async sshRun(host, command) {
      calls.push(command);
      if (/type d/.test(command)) return { code: 0, stdout: './docs\n', stderr: '', ms: 1 };
      return { code: 0, stdout: './docs/guide.txt\n', stderr: '', ms: 1 };
    }
  };
  const ctx = { remote: { host: HOST, base: '/home/me/app' }, ssh };
  const out = await remote.run('find_paths', { query: 'doc' }, ctx);
  assert.equal(calls.length, 2, 'dirs and files searched separately');
  assert.ok(calls.every(c => c.includes('-iname') && c.includes('/home/me/app')), 'name match under the base:\n' + calls.join('\n'));
  assert.ok(out.includes('dir') && out.includes('docs'), 'dirs first:\n' + out);
  assert.ok(out.indexOf('dir') < out.indexOf('guide.txt'), 'dirs before files');
});

test('remote find_paths keeps glob characters in the query literal', async () => {
  const calls = [];
  const ssh = {
    async sshRun(host, command) {
      calls.push(command);
      return { code: 0, stdout: '', stderr: '', ms: 1 };
    }
  };
  const ctx = { remote: { host: HOST, base: '' }, ssh };
  const out = await remote.run('find_paths', { query: "a*b it's" }, ctx);
  assert.ok(calls[0].includes('a\\*b'), 'the star stays literal:\n' + calls[0]);
  assert.match(out, /No paths matching/);
});

test('remote find_paths reports a missing folder instead of an empty match', async () => {
  const ssh = {
    async sshRun() {
      return { code: 1, stdout: '', stderr: 'find: ‘gone’: No such file or directory', ms: 1 };
    }
  };
  const ctx = { remote: { host: HOST, base: '/home/me/app' }, ssh };
  await assert.rejects(() => remote.run('find_paths', { query: 'x', path: 'gone' }, ctx), /failed|No such file/i);
  await assert.rejects(() => remote.run('find_paths', { query: 'x', path: '../../etc' }, ctx), /above|inside/i);
});

test('find_paths routes remotely when the chat is connected', async () => {
  const { ToolHost } = require('../src/main/tools');
  const { PermissionGate } = require('../src/main/tools/permissions');
  assert.ok(remote.isRemoteable('find_paths'), 'in the remote set');
  const ssh = {
    async sshRun() { return { code: 0, stdout: './a.txt\n', stderr: '', ms: 1 }; }
  };
  const gate = new PermissionGate({ ask: async () => ({ decision: 'allow' }) });
  const host = new ToolHost({ root: null, gate, sshHosts: () => [], remote: { host: HOST, base: '/srv/app', ssh } });
  const r = await host.invoke({ id: 'c1', name: 'find_paths', args: { query: 'a' } });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(r.result.includes('a.txt'));
});

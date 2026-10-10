'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sshShared = require('../src/shared/ssh');
const remote = require('../src/main/tools/ssh-remote');
const { Store, PLAIN, sanitizeImportedConversation } = require('../src/main/store');

/* ---------------- shared helpers ---------------- */

test('resolveRemote joins under the base and refuses escapes', () => {
  assert.equal(sshShared.resolveRemote('/home/deploy/app', 'src/a.js'), '/home/deploy/app/src/a.js');
  assert.equal(sshShared.resolveRemote('/home/deploy/app', './x'), '/home/deploy/app/x');
  assert.equal(sshShared.resolveRemote('/home/deploy/app', 'a/../b'), '/home/deploy/app/b');
  assert.equal(sshShared.resolveRemote('/home/deploy/app', '../etc'), null);
  assert.equal(sshShared.resolveRemote('/home/deploy/app', '/etc/passwd'), null);
  assert.equal(sshShared.resolveRemote('/home/deploy/app', '~/x'), null);
  assert.equal(sshShared.resolveRemote('/home/deploy/app', ''), null);
  assert.equal(sshShared.resolveRemote('', 'a/b'), '/a/b');
});

test('sanitizeSshDestination accepts detach and validates attach', () => {
  assert.deepEqual(sshShared.sanitizeSshDestination({ hostId: null }), { ok: true, clean: { hostId: null, path: '' } });
  const ok = sshShared.sanitizeSshDestination({ hostId: 'hABC123', path: '/home/u/app' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.clean, { hostId: 'hABC123', path: '/home/u/app' });
  const home = sshShared.sanitizeSshDestination({ hostId: 'h1', path: '' });
  assert.equal(home.ok, true);
  assert.equal(sshShared.sanitizeSshDestination({ hostId: 'bad id!' }).ok, false);
  assert.equal(sshShared.sanitizeSshDestination({ hostId: 'h1', path: 'relative' }).ok, false);
});

test('remoteNote names the host and folder', () => {
  const n = sshShared.remoteNote('Home server', '/home/u/app');
  assert.ok(n.includes('Home server') && n.includes('/home/u/app'));
  assert.ok(sshShared.remoteNote('H', '').includes('login home'));
});

/* ---------------- store ---------------- */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-remote-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return new Store(dir, PLAIN);
}

test('conversations carry an SSH destination, defaulting to local', () => {
  const s = tmpStore();
  const c = s.createConversation('Hi');
  assert.equal(c.sshHostId, null);
  assert.equal(c.sshPath, '');
  assert.equal(c.sshOk, null);
  s.updateConversation(c.id, { sshHostId: 'hABC', sshPath: '/home/u/app', sshOk: true, sshCheckedAt: '2026-01-01T00:00:00.000Z' });
  const full = s.getConversation(c.id);
  assert.equal(full.sshHostId, 'hABC');
  assert.equal(full.sshPath, '/home/u/app');
  assert.equal(full.sshOk, true);
  // Junk never sticks.
  s.updateConversation(c.id, { sshHostId: 'bad id!', sshPath: 'relative', sshOk: 'yes', sshCheckedAt: 'junk' });
  const after = s.getConversation(c.id);
  assert.equal(after.sshHostId, null);
  assert.equal(after.sshPath, '/home/u/app');
  assert.equal(after.sshOk, null);
  assert.equal(after.sshCheckedAt, null);
  // Detaching clears the check too.
  s.updateConversation(c.id, { sshHostId: 'hX' });
  s.updateConversation(c.id, { sshHostId: null });
  assert.equal(s.getConversation(c.id).sshOk, null);
});

test('imported conversations keep a valid destination and drop a hostile one', () => {
  const good = sanitizeImportedConversation({
    id: 'c9', title: 'T', messages: [],
    sshHostId: 'hValid1', sshPath: '/srv/app', sshOk: true, sshCheckedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(good.sshHostId, 'hValid1');
  assert.equal(good.sshPath, '/srv/app');
  const bad = sanitizeImportedConversation({
    id: 'c10', title: 'T', messages: [],
    sshHostId: '-oProxyCommand=x', sshPath: 'relative', sshOk: 'yes', sshCheckedAt: 'junk'
  });
  assert.equal(bad.sshHostId, null);
  assert.equal(bad.sshPath, '');
  assert.equal(bad.sshOk, null);
});

/* ---------------- ssh-remote routing set ---------------- */

test('only workspace tools go remote; the network tool stays local', () => {
  for (const name of ['read_file', 'list_dir', 'write_file', 'edit_file', 'run_command', 'git_status']) {
    assert.equal(remote.isRemoteable(name), true, name);
  }
  assert.equal(remote.isRemoteable('http_fetch'), false);
  assert.equal(remote.isRemoteable('ssh_exec'), false);
  assert.equal(remote.isRemoteable('nope'), false);
});

test('checkRel rejects escapes and absolute paths', () => {
  assert.equal(remote.checkRel('src/a.js'), 'src/a.js');
  assert.equal(remote.checkRel('./x'), 'x');
  assert.throws(() => remote.checkRel('/etc/passwd'), /relative/);
  assert.throws(() => remote.checkRel('../etc'), /above/);
  assert.throws(() => remote.checkRel(''), /required/);
  assert.equal(remote.checkRelDir(''), '');
  assert.equal(remote.checkRelDir('.'), '');
});

/* ---------------- ssh-remote execution with a stubbed runner ---------------- */

const HOST = { id: 'h1', label: 'Web', host: 'web.example', user: 'me', port: 22, keyFile: '' };

function stubSsh(over = {}) {
  return {
    calls: [],
    async sshRun(host, command, timeoutMs) {
      this.calls.push({ host, command, timeoutMs });
      if (over.sshRun) return over.sshRun(host, command, timeoutMs);
      return { code: 0, timedOut: false, ms: 5, stdout: '', stderr: '', truncated: false };
    },
    async sshList(host, p) {
      this.calls.push({ list: p });
      if (over.sshList) return over.sshList(host, p);
      return { dir: p || '/home/me', entries: [], truncated: false };
    },
    async sshRead(host, p) {
      this.calls.push({ read: p });
      if (over.sshRead) return over.sshRead(host, p);
      return { bytes: 11, truncated: false, binary: false, text: 'hello world' };
    }
  };
}

const ctxFor = (ssh, base = '/home/me/app') => ({ remote: { host: HOST, base }, ssh });

test('read_file numbers lines from the remote read', async () => {
  const ssh = stubSsh({
    async sshRun() {
      return { code: 0, timedOut: false, ms: 5, stdout: 'line one\nline two\n', stderr: '', truncated: false };
    }
  });
  const out = await remote.run('read_file', { path: 'notes.txt' }, ctxFor(ssh));
  assert.ok(out.includes('notes.txt') && out.includes('line one'));
  assert.ok(ssh.calls[0].command.includes('notes.txt'), 'the rel travels, quoted');
  assert.ok(ssh.calls[0].command.includes('/home/me/app'), 'under the connected folder');
});

test('read_file refuses traversal before any spawn', async () => {
  const ssh = stubSsh();
  await assert.rejects(() => remote.run('read_file', { path: '../../etc/passwd' }, ctxFor(ssh)), /above/);
  assert.equal(ssh.calls.length, 0, 'nothing spawned');
});

test('list_dir flat reuses the browser protocol with the base joined', async () => {
  const ssh = stubSsh({
    async sshList(host, p) {
      return { dir: '/home/me/app/sub', entries: [{ name: 'a.txt', dir: false, path: '/home/me/app/sub/a.txt', size: 12 }], truncated: false };
    }
  });
  const out = await remote.run('list_dir', { path: 'sub' }, ctxFor(ssh));
  assert.ok(out.includes('a.txt'));
  assert.ok(ssh.calls.some(c => c.list && String(c.list).includes('sub')), 'listed under the base');
});

test('write_file travels base64 and reports created vs replaced', async () => {
  const seen = [];
  const ssh = stubSsh({
    async sshRun(host, command) {
      seen.push(command);
      if (command.includes('EXISTS')) return { code: 0, stdout: 'NEW', stderr: '', ms: 1 };
      return { code: 0, stdout: '', stderr: '', ms: 1 };
    }
  });
  const out = await remote.run('write_file', { path: 'a.txt', content: 'hi' }, ctxFor(ssh));
  assert.match(out, /Created a\.txt/);
  assert.ok(seen.join('\n').includes('base64'), 'content encoded, never interpolated');
});

test('edit_file applies the local snippet rules to remote text', async () => {
  const ssh = stubSsh({
    async sshRead() { return { bytes: 20, truncated: false, binary: false, text: 'foo bar foo' }; },
    async sshRun(host, command) {
      if (command.includes('EXISTS')) return { code: 0, stdout: 'EXISTS', stderr: '', ms: 1 };
      return { code: 0, stdout: '', stderr: '', ms: 1 };
    }
  });
  await assert.rejects(
    () => remote.run('edit_file', { path: 'a.txt', old_string: 'foo', new_string: 'x' }, ctxFor(ssh)),
    /more than once/);
});

test('delete_file asks for recursive on directories', async () => {
  const ssh = stubSsh({
    async sshRun(host, command) {
      if (command.includes('ISDIR') || command.includes('ISFILE') || command.includes('GONE')) {
        return { code: 0, stdout: command.includes('rm ') ? '' : 'ISDIR', stderr: '', ms: 1 };
      }
      return { code: 0, stdout: '', stderr: '', ms: 1 };
    }
  });
  await assert.rejects(() => remote.run('delete_file', { path: 'dir' }, ctxFor(ssh)), /recursive/);
  const out = await remote.run('delete_file', { path: 'dir', recursive: true }, ctxFor(ssh));
  assert.match(out, /Deleted the directory/);
});

test('run_command cds to the connected folder and passes text through', async () => {
  const ssh = stubSsh({
    async sshRun() { return { code: 0, timedOut: false, ms: 3, stdout: 'ok', stderr: '', truncated: false }; }
  });
  const out = await remote.run('run_command', { command: 'npm test', cwd: 'sub' }, ctxFor(ssh));
  assert.ok(out.includes('npm test') && out.includes('exit 0'));
  const cmd = ssh.calls[0].command;
  assert.ok(cmd.includes('/home/me/app') && cmd.includes('npm test'), 'cd then free text');
});

test('git tools reuse the denied-option list', async () => {
  const ssh = stubSsh();
  await assert.rejects(() => remote.run('git_branch', { action: 'create', name: '-evil' }, ctxFor(ssh)), /branch name/);
  assert.equal(ssh.calls.length, 0);
});

/* ---------------- ToolHost remote routing ---------------- */

test('ToolHost runs workspace tools on the host when connected', async () => {
  const { ToolHost } = require('../src/main/tools');
  const { PermissionGate } = require('../src/main/tools/permissions');
  const ssh = stubSsh({
    async sshRun() { return { code: 0, timedOut: false, ms: 5, stdout: 'x\n', stderr: '', truncated: false }; }
  });
  const gate = new PermissionGate({ ask: async () => ({ decision: 'allow' }) });
  const host = new ToolHost({ root: null, gate, sshHosts: () => [], remote: { host: HOST, base: '/home/me/app', ssh } });
  const r = await host.invoke({ id: 'c1', name: 'read_file', args: { path: 'a.txt' } });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(ssh.calls.length > 0, 'went remote, not local');
});

test('ToolHost refuses local-only tools with neither workspace nor connection', async () => {
  const { ToolHost } = require('../src/main/tools');
  const { PermissionGate } = require('../src/main/tools/permissions');
  const gate = new PermissionGate({ ask: async () => ({ decision: 'allow' }) });
  const host = new ToolHost({ root: null, gate, sshHosts: () => [] });
  const r = await host.invoke({ id: 'c1', name: 'read_file', args: { path: 'a.txt' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /workspace/i);
});

test('agentSystemPrompt names the remote host when connected', () => {
  const { agentSystemPrompt } = require('../src/main/agent');
  const local = agentSystemPrompt('base');
  assert.ok(!local.includes('Remote workspace'));
  const remotePrompt = agentSystemPrompt('base', { hostLabel: 'Web', path: '/home/me/app' });
  assert.ok(remotePrompt.includes('Web') && remotePrompt.includes('/home/me/app'));
});

/* ---------------- renderer wiring ---------------- */

test('the chat bar, picker and bridge exist on every side', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/theme.css'), 'utf8');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  for (const id of ['sshDestBar', 'sshDestDot', 'sshDestBadge', 'sshDestText', 'sshDestBtn',
    'sshDestModal', 'sshDestModalTitle', 'sshDestHost', 'sshDestPath',
    'sshDestError', 'sshDestConnectBtn', 'sshDestDisconnectBtn', 'sshDestCancelBtn']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
  }
  assert.ok(preload.includes('setConversationSsh'), 'bridge exposes setConversationSsh');
  assert.ok(ipc.includes("ipcMain.handle('conversations:setSsh'"), 'IPC handles setSsh');
  assert.ok(appJs.includes('nexus.setConversationSsh'), 'renderer connects through the bridge');
  assert.ok(appJs.includes('Tools on · SSH'), 'toggle names the remote mode');
  assert.ok(css.includes('.ssh-dest-bar') && css.includes('.ssh-dest-dot'), 'bar styled');
  assert.ok(css.includes('.ssh-dest-badge'), 'the identity badge is styled');
  assert.ok(css.includes('.ssh-dest-dot.checking'), 'the checking state is styled');
  assert.ok(appJs.includes('verifySshDest') && appJs.includes('sshLiveByConv'), 'the pill verifies reachability, not just stored state');
  // The status lives under the composer — badge, name, "/" location — not as a top strip.
  const barAt = html.indexOf('id="sshDestBar"');
  assert.ok(barAt > html.indexOf('id="sendBtn"'), 'below the composer box');
  assert.ok(barAt < html.indexOf('<!-- BOTS -->'), 'still inside the chat view');
  assert.ok(html.includes('id="sshDestBtn" type="button" class="ghost ssh-dest-btn">This PC'), 'names This PC by default');
  assert.ok(html.indexOf('id="chatHeader"') < html.indexOf('id="messages"'), 'header still above messages');
  for (const id of ['sshDestHost', 'sshDestPath']) {
    assert.ok(html.includes('for="' + id + '"'), 'no label for #' + id);
  }
});

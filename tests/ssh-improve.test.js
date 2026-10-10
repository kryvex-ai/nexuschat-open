'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ssh = require('../src/shared/ssh');

/* ---------------- target parsing ---------------- */

test('parseSshTarget reads pastes people actually copy', () => {
  assert.deepEqual(ssh.parseSshTarget('web.example'), { host: 'web.example', user: '', port: null });
  assert.deepEqual(ssh.parseSshTarget('deploy@web.example:2222'), { host: 'web.example', user: 'deploy', port: 2222 });
  assert.deepEqual(ssh.parseSshTarget('ssh://deploy@web.example:2222'), { host: 'web.example', user: 'deploy', port: 2222 });
  assert.deepEqual(ssh.parseSshTarget('user@[::1]:2222'), { host: '::1', user: 'user', port: 2222 });
  assert.deepEqual(ssh.parseSshTarget('[::1]:2222'), { host: '::1', user: '', port: 2222 });
  // Bare IPv6 keeps every colon — no guessing which one is a port.
  assert.deepEqual(ssh.parseSshTarget('::1'), { host: '::1', user: '', port: null });
  assert.equal(ssh.parseSshTarget(''), null);
  assert.equal(ssh.parseSshTarget('   '), null);
});

test('normalizeHost strips one bracket pair', () => {
  assert.equal(ssh.normalizeHost('[::1]'), '::1');
  assert.equal(ssh.normalizeHost('Example.COM'), 'example.com');
  assert.equal(ssh.normalizeHost('plain'), 'plain');
});

test('validateHostForm accepts a paste and reports field errors', () => {
  const ok = ssh.validateHostForm({ label: '', host: 'deploy@web.example:2222', user: '', port: '', keyFile: '' });
  assert.equal(ok.ok, true);
  assert.equal(ok.clean.host, 'web.example');
  assert.equal(ok.clean.user, 'deploy');
  assert.equal(ok.clean.port, 2222);
  assert.equal(ok.clean.label, 'web.example');
  // Explicit boxes win over the paste.
  const win = ssh.validateHostForm({ label: 'X', host: 'a@h1:111', user: 'b', port: '222', keyFile: '' });
  assert.equal(win.clean.user, 'b');
  assert.equal(win.clean.port, 222);
  const badHost = ssh.validateHostForm({ host: 'has space', user: '', port: '', keyFile: '' });
  assert.equal(badHost.ok, false);
  assert.ok(badHost.errors.host);
  const badUser = ssh.validateHostForm({ host: 'h.example', user: 'bad user!', port: '', keyFile: '' });
  assert.equal(badUser.ok, false);
  assert.ok(badUser.errors.user);
  const badPort = ssh.validateHostForm({ host: 'h.example', user: '', port: '99999', keyFile: '' });
  assert.equal(badPort.ok, false);
  assert.ok(badPort.errors.port);
});

/* ---------------- IPv6 plumbing ---------------- */

test('IPv6 hosts survive sanitize, target and known_hosts', () => {
  const out = ssh.sanitizeHosts([{ id: 'v6', host: '[::1]', user: 'me', port: 2222, keyFile: '' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, '::1');
  assert.equal(ssh.targetFor({ host: '::1', user: 'me' }), 'me@[::1]');
  assert.equal(ssh.targetFor({ host: 'box', user: '' }), 'box');
  assert.equal(ssh.knownHostsQuery({ host: 'box', port: 2222 }), '[box]:2222');
  assert.equal(ssh.knownHostsQuery({ host: '::1', port: 2222 }), '[::1]:2222');
});

test('sanitizeHosts still drops option smuggling', () => {
  assert.deepEqual(ssh.sanitizeHosts([{ id: 'x', host: '-oProxyCommand=evil' }]), []);
});

/* ---------------- listing v2 (sizes + mtimes) ---------------- */

test('parseRemoteList reads the size/mtime columns and the old shape', () => {
  const old = ssh.parseRemoteList('C\t/var/log\nf\t/var/log/a.txt');
  assert.equal(old.length, 1);
  assert.equal(old[0].name, 'a.txt');
  const full = ssh.parseRemoteList([
    'C\t/var/log',
    'd\t/var/log/apt\t4096 1700000000',
    'f\t/var/log/sys.log\t1536 1700000100',
    'f\t/var/log/nostat'
  ].join('\n'));
  const apt = full.find(e => e.name === 'apt');
  assert.equal(apt.dir, true);
  assert.equal(apt.size, 4096);
  assert.ok(typeof apt.mtime === 'number' && apt.mtime > 0);
  const log = full.find(e => e.name === 'sys.log');
  assert.equal(log.size, 1536);
  // Old rows keep the old object shape — no size/mtime keys at all.
  const bare = full.find(e => e.name === 'nostat');
  assert.deepEqual(Object.keys(bare).sort(), ['dir', 'name', 'path']);
});

test('a tab inside a file name drops the row instead of misreading it', () => {
  const out = ssh.parseRemoteList('f\t/var/log/has\ttab.txt');
  assert.equal(out.length, 0, 'not numeric metadata, so the path held a tab');
});

test('the listing script still resolves home and quotes injections', () => {
  assert.ok(ssh.remoteListScript('').includes('"$HOME"'));
  assert.ok(ssh.remoteListScript('/srv').includes('&& pwd)'));
  assert.ok(ssh.remoteListCommand('/var/log').startsWith('sh -c '));
  assert.ok(ssh.remoteListScript('$(rm -rf /)').includes("'$(rm -rf /)'"));
});

/* ---------------- failure hints ---------------- */

test('describeSshFailure names the five failures one way', () => {
  assert.equal(ssh.describeSshFailure('REMOTE HOST IDENTIFICATION HAS CHANGED!', {}).title, 'Host key changed');
  assert.equal(ssh.describeSshFailure('Host key verification failed.', {}).title, 'Host key not trusted');
  assert.equal(ssh.describeSshFailure('Permission denied (publickey).', {}).title, 'Key refused');
  assert.equal(ssh.describeSshFailure('ssh: connect to host x port 22: Connection refused', {}).title, 'Connection refused');
  assert.equal(ssh.describeSshFailure('Could not resolve hostname bad: Name or service not known', {}).title, 'Unknown host');
  assert.equal(ssh.describeSshFailure('', { timedOut: true }).title, 'Timed out');
  assert.equal(ssh.describeSshFailure('some new ssh line', {}).title, '');
});

test('formatBytes and formatMtime stay quiet on unknowns', () => {
  assert.equal(ssh.formatBytes(1536), '1.5 KB');
  assert.equal(ssh.formatBytes(512), '512 B');
  assert.equal(ssh.formatBytes(null), '');
  assert.equal(ssh.formatMtime(null), '');
  assert.match(ssh.formatMtime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

/* ---------------- main side ---------------- */

test('the main ssh layer exposes a bounded binary check', () => {
  const main = require('../src/main/ssh');
  assert.equal(typeof main.sshCheckBinary, 'function');
  assert.equal(typeof main.sshSave, 'function');
  // sshSave takes a timeout now — a stalled download kills the child.
  assert.ok(main.sshSave.toString().includes('timeoutMs'), 'sshSave(host, path, dest, maxBytes, timeoutMs)');
});

/* ---------------- renderer wiring ---------------- */

test('every SSH control the renderer touches exists in the panel', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/theme.css'), 'utf8');
  for (const id of ['sshPrereqLine', 'sshFormTitle', 'sshFormError', 'sshHostHints', 'sshNewHostBtn',
    'sshCmdList', 'sshTimeout', 'sshRunStatus', 'sshCopyOutBtn', 'sshClearOutBtn',
    'sshHomeBtn', 'sshCrumbs', 'sshFilter', 'sshCopyPreviewBtn', 'sshLastTest', 'sshEffective',
    'sshCount', 'sshHostList', 'sshLabel', 'sshHost', 'sshUser', 'sshPort', 'sshKey',
    'sshSaveHostBtn', 'sshRemoveHostBtn', 'sshTestBtn', 'sshForgetKeyBtn',
    'sshCmd', 'sshRunBtn', 'sshOut', 'sshPath', 'sshUpBtn', 'sshListBtn',
    'sshFiles', 'sshPreviewBtn', 'sshDownloadBtn', 'sshFileStatus', 'sshPreview',
    'sshScore', 'sshCopyCfgBtn', 'sshFindings', 'sshNote', 'sshConfig']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing #' + id + ' in index.html');
  }
  assert.ok(preload.includes('sshPrereq'), 'preload exposes sshPrereq');
  assert.ok(appJs.includes('nexus.sshPrereq'), 'renderer checks the binary');
  assert.ok(appJs.includes('nexus.sshRun(host.id, cmd, timeoutMs)'), 'the runner passes its timeout');
  for (const cls of ['.ssh-crumbs', '.ssh-crumb', '.ssh-file-meta', '.ssh-file-row']) {
    assert.ok(css.includes(cls), 'missing style: ' + cls);
  }
  // Labels still point at real controls.
  for (const id of ['sshLabel', 'sshCmd', 'sshPath']) {
    assert.ok(html.includes('for="' + id + '"'), 'no label for #' + id);
  }
});

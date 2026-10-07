'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SSH_LIMITS,
  sanitizeHosts, targetFor, buildSshArgs, shQuote,
  remoteListScript, remoteListCommand, parseRemoteList, parseListDir, remoteReadCommand,
  sanitizeRemotePath, sanitizeCommand, sanitizeSaveName, uniqueSaveName,
  hostAlias, knownHostsQuery, parseSshG, listVal, csvVal, firstLine,
  auditSsh, sshConfigBlock, isProbablyText
} = require('../src/shared/ssh');

/* ---------------- hosts ---------------- */

test('sanitizeHosts drops junk and normalizes what survives', () => {
  assert.deepEqual(sanitizeHosts(null), [], 'not a list');
  const out = sanitizeHosts([
    { id: 'a1', label: 'Web', host: 'Example.COM', user: 'deploy', port: 2222, keyFile: '~/.ssh/id_ed25519' },
    { host: '-oProxyCommand=evil' },          // option smuggling
    { host: 'has space' },                    // not a hostname
    { host: 'ok.example', port: 99999 },      // port out of range -> 22
    'not an object',
    { host: 'ok2.example', user: 'bad user!' } // invalid user -> blanked
  ]);
  assert.equal(out.length, 3, 'only host-shaped entries survive');
  assert.deepEqual(out[0], { id: 'a1', label: 'Web', host: 'example.com', user: 'deploy', port: 2222, keyFile: '~/.ssh/id_ed25519' });
  assert.equal(out[1].port, 22, 'an impossible port falls back to 22');
  assert.equal(out[1].user, '', 'an impossible user is blanked, not dropped');
  assert.match(out[1].id, /^h/, 'a missing id is generated, stable for the same host');
  assert.equal(sanitizeHosts(new Array(80).fill({ host: 'h' + Math.random() })).length, SSH_LIMITS.HOSTS_MAX, 'capped');
});

test('a leading dash can never reach the spawn as an option', () => {
  assert.deepEqual(sanitizeHosts([{ id: 'x', host: '--help' }]), []);
  const args = buildSshArgs(sanitizeHosts([{ id: 'x', label: 'L', host: 'box.example', user: 'me', port: 2200, keyFile: '/k' }])[0]);
  const dest = args[args.length - 1];
  assert.equal(dest, 'me@box.example');
  assert.ok(!dest.startsWith('-'));
  assert.equal(args[0], '-o');
  assert.ok(args.join(' ').includes('BatchMode=yes'), 'never a password prompt');
});

test('buildSshArgs: flags stay before the destination, the command is one argv', () => {
  const host = { id: 'x', label: 'L', host: 'box', user: '', port: 22, keyFile: '' };
  const run = buildSshArgs(host, { acceptNew: true, command: 'uptime; echo done' });
  assert.deepEqual(run.slice(-2), ['box', 'uptime; echo done'], 'command travels as a single argument');
  assert.ok(run.includes('StrictHostKeyChecking=accept-new'), 'explicit actions pin the key');
  const probe = buildSshArgs(host, { command: 'true' });
  assert.ok(!probe.includes('StrictHostKeyChecking=accept-new'), 'the test probe never mutates known_hosts');
  const g = buildSshArgs(host, { flag: '-G' });
  assert.deepEqual(g.slice(-2), ['-G', 'box']);
  assert.deepEqual(targetFor({ host: 'b', user: '' }), 'b');
  assert.deepEqual(targetFor({ host: 'b', user: 'u' }), 'u@b');
});

/* ---------------- quoting and remote scripts ---------------- */

test('shQuote survives embedded quotes', () => {
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
  const script = remoteListScript('/var/log');
  const cmd = remoteListCommand('/var/log');
  assert.ok(cmd.startsWith('sh -c '), 'the login shell never parses our script');
  assert.ok(cmd.includes("'\\''"), 'script quotes are escaped for the outer layer');
  assert.ok(remoteListScript('').includes('"$HOME"'), 'blank path lists the login home');
  assert.ok(remoteListScript('/srv').includes('&& pwd)'), 'the script resolves and echoes the directory first');
  assert.ok(remoteListScript("$(rm -rf /)").includes("'$(rm -rf /)'"), 'command substitution stays quoted');
});

test('parseRemoteList: directories first, then alphabetical, junk skipped', () => {
  const out = parseRemoteList([
    'C\t/var/log',
    'f\t/var/log/zeta.log',
    'd\t/var/log/apt',
    'd\t/var/log/Alpha',
    'no-tab-here',
    'x\t/var/log/weird',
    'f\t/var/log/aardvark.txt'
  ].join('\n'));
  assert.deepEqual(out, [
    { name: 'Alpha', dir: true, path: '/var/log/Alpha' },
    { name: 'apt', dir: true, path: '/var/log/apt' },
    { name: 'aardvark.txt', dir: false, path: '/var/log/aardvark.txt' },
    { name: 'zeta.log', dir: false, path: '/var/log/zeta.log' }
  ], 'only d/f rows survive, dirs first, full paths kept for navigation');
  assert.equal(parseListDir('C\t/var/log\nf\t/var/log/a'), '/var/log', 'the C header names the resolved dir');
  assert.equal(parseListDir('f\t/var/log/a'), null, 'no header, no crash');
});

test('remote paths and names are constrained before they are used', () => {
  assert.equal(sanitizeRemotePath('/etc/passwd'), '/etc/passwd');
  assert.equal(sanitizeRemotePath('relative/path'), null, 'absolute only');
  assert.equal(sanitizeRemotePath('/tmp/\0evil'), null, 'no NUL');
  assert.equal(sanitizeRemotePath('', { allowHome: true }), '', 'home is a valid listing target');
  assert.equal(sanitizeRemotePath('-rf', { allowHome: true }), null, 'a leading dash is never a path');
  assert.equal(sanitizeCommand('uptime\n'), 'uptime\n');
  assert.equal(sanitizeCommand(''), null);
  assert.equal(sanitizeCommand('bad\0cmd'), null);
  assert.equal(sanitizeSaveName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeSaveName('..'), 'download');
  assert.equal(uniqueSaveName('report.txt', () => false), 'report.txt');
  assert.equal(uniqueSaveName('report.txt', n => n === 'report.txt'), 'report (2).txt');
  assert.equal(uniqueSaveName('report.txt', n => n === 'report.txt' || n === 'report (2).txt'), 'report (3).txt');
});

test('read command: absolute path, truncation signal at max+1', () => {
  const cmd = remoteReadCommand('/var/log/syslog', 1000);
  assert.equal(cmd, "head -c 1001 '/var/log/syslog'");
  assert.equal(remoteReadCommand("/tmp/it's", 10).includes("'\\''"), true);
});

/* ---------------- ssh -G parsing and audit ---------------- */

test('parseSshG keeps repeats as a list, single keys as strings', () => {
  const eff = parseSshG([
    'user deploy',
    'port 2200',
    'identityfile /home/me/.ssh/id_ed25519',
    'identityfile /home/me/.ssh/id_rsa',
    'passwordauthentication yes',
    'ciphers chacha20-poly1305@openssh.com,3des-cbc'
  ].join('\n'));
  assert.equal(eff.user, 'deploy');
  assert.equal(eff.port, '2200');
  assert.deepEqual(eff.identityfile, ['/home/me/.ssh/id_ed25519', '/home/me/.ssh/id_rsa']);
  assert.deepEqual(listVal(eff, 'identityfile').length, 2, 'identityfile: one per line');
  assert.deepEqual(csvVal(eff, 'ciphers'), ['chacha20-poly1305@openssh.com', '3des-cbc'], 'algorithms: comma-split');
  assert.deepEqual(listVal(eff, 'nowhere'), []);
  assert.equal(firstLine('boom\nsecret line'), 'boom');
});

function effOf(over = {}) {
  return Object.assign({
    pubkeyauthentication: 'yes',
    passwordauthentication: 'no',
    permitrootlogin: 'prohibit-password',
    forwardagent: 'no',
    hostbasedauthentication: 'no',
    ciphers: 'chacha20-poly1305@openssh.com,aes256-gcm@openssh.com',
    kexalgorithms: 'sntrup761x25519-sha512,curve25519-sha256',
    macs: 'umac-openssh@openssh.com,hmac-sha2-256-etm@openssh.com'
  }, over);
}
const goodFacts = { connect: { ok: true, ms: 42 }, knownHosts: true, key: { path: '/k', exists: true, mode: 0o600 } };

test('a clean host scores 100 with zero warnings', () => {
  const r = auditSsh(effOf(), goodFacts);
  assert.equal(r.score, 100, JSON.stringify(r.findings.filter(f => f.level !== 'good')));
  assert.equal(r.findings.filter(f => f.level !== 'good').length, 0);
  assert.match(r.note, /looks good/);
});

test('each bad rule costs 25, each warning 10, floored at 0', () => {
  const bad = auditSsh(effOf({ pubkeyauthentication: 'no', hostbasedauthentication: 'yes' }),
    { connect: { ok: false, error: 'Permission denied (publickey).\nmore' }, knownHosts: false, key: null });
  // bad: pubkey off, hostbased on, connect failed = 3 ; warn: password?, known_hosts…
  assert.ok(bad.score <= 100 - 75, 'three bads bite hard: ' + bad.score);
  assert.equal(bad.findings.find(f => f.title === 'Cannot connect').detail, 'Permission denied (publickey).', 'first line only');
  const r2 = auditSsh(effOf({ passwordauthentication: 'yes', forwardagent: 'yes', permitrootlogin: 'yes' }),
    { connect: { ok: true, ms: 10 }, knownHosts: false, key: null });
  assert.equal(r2.score, 100 - 10 * 4, 'password, root login, agent forwarding, untrusted key');
  const floor = auditSsh(
    effOf({ pubkeyauthentication: 'no', hostbasedauthentication: 'yes', kexalgorithms: 'diffie-hellman-group1-sha1' }),
    { connect: { ok: false, error: 'nope' }, knownHosts: false, key: { path: '/k', exists: true, mode: 0o644 } });
  assert.equal(floor.score, 0, 'score never goes negative');
});

test('weak crypto in the offer is called out with a fix', () => {
  const r = auditSsh(effOf({
    ciphers: 'aes256-ctr,3des-cbc',
    kexalgorithms: 'diffie-hellman-group14-sha1,curve25519-sha256',
    macs: 'hmac-sha2-256,hmac-md5'
  }), goodFacts);
  const titles = r.findings.filter(f => f.level === 'warn' || f.level === 'bad').map(f => f.title);
  assert.ok(titles.some(t => /ciphers/i.test(t)), titles.join('|'));
  assert.ok(titles.some(t => /key exchange/i.test(t)));
  assert.ok(titles.some(t => /message authentication/i.test(t)));
  const kexFinding = r.findings.find(f => /key exchange/i.test(f.title));
  assert.match(kexFinding.detail, /group14-sha1/);
  assert.ok(kexFinding.fix.includes('KexAlgorithms'));
});

test('group1-sha1 is a problem, not a warning', () => {
  const r = auditSsh(effOf({ kexalgorithms: 'diffie-hellman-group1-sha1' }), goodFacts);
  const kex = r.findings.find(f => /key exchange/i.test(f.title));
  assert.equal(kex.level, 'bad');
});

test('key permissions are checked, and a missing key is not a crash', () => {
  const loose = auditSsh(effOf(), { connect: { ok: true, ms: 1 }, knownHosts: true, key: { path: '/k', exists: true, mode: 0o644 } });
  const finding = loose.findings.find(f => /readable/i.test(f.title));
  assert.equal(finding.level, 'bad');
  assert.match(finding.fix, /chmod 600/);
  const missing = auditSsh(effOf(), { connect: { ok: true, ms: 1 }, knownHosts: true, key: { path: '/k', exists: false, mode: null } });
  assert.equal(missing.findings.find(f => /missing/i.test(f.title)).level, 'warn');
  const windows = auditSsh(effOf(), { connect: { ok: true, ms: 1 }, knownHosts: true, key: { path: 'C:\\k', exists: true, mode: null } });
  assert.ok(windows.findings.every(f => f.title !== 'The key file is readable by other users'), 'no mode, no verdict');
});

test('the config block carries the host and the hardening lines', () => {
  const host = { id: 'x', label: 'My Web Server', host: 'web.example', user: 'deploy', port: 2200, keyFile: '~/.ssh/web' };
  const block = sshConfigBlock(host);
  assert.match(block, /^Host My-Web-Server$/m, 'a label with spaces becomes one token');
  assert.match(block, /^ {2}HostName web\.example$/m);
  assert.match(block, /^ {2}User deploy$/m);
  assert.match(block, /^ {2}Port 2200$/m);
  assert.match(block, /^ {2}IdentityFile ~\/\.ssh\/web$/m);
  assert.match(block, /PasswordAuthentication no/);
  assert.match(block, /ForwardAgent no/);
  assert.equal(hostAlias({ label: '', host: 'plain' }), 'plain', 'no label falls back to the host');
  assert.equal(knownHostsQuery({ host: 'box', port: 22 }), 'box');
  assert.equal(knownHostsQuery({ host: 'box', port: 2222 }), '[box]:2222');
});

test('binary content is detected before it is previewed', () => {
  assert.equal(isProbablyText(Buffer.from('hello\nworld')), true);
  assert.equal(isProbablyText(Buffer.from([0x7f, 0x45, 0x00, 0x4c])), false);
  assert.equal(isProbablyText(Buffer.alloc(0)), true);
  const inside = Buffer.concat([Buffer.from('x'.repeat(8191)), Buffer.from([0]), Buffer.from('tail')]);
  assert.equal(isProbablyText(inside), false, 'the first 8 KB decide');
  const beyond = Buffer.concat([Buffer.from('x'.repeat(8192)), Buffer.from([0])]);
  assert.equal(isProbablyText(beyond), true, 'a NUL past the window is ignored');
});

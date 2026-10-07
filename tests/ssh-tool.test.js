'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { toolByName, callSummary, validateArgs, manual, RISK } = require('../src/shared/tools');

/* ---------------- the tool half ---------------- */

test('ssh_exec exists, is danger, and never lets the model pick a host string', () => {
  const t = toolByName('ssh_exec');
  assert.ok(t, 'ssh_exec is in the registry');
  assert.equal(t.risk, RISK.DANGER, 'always asks, never remembered');
  assert.equal(t.group, 'ssh');
  assert.ok(validateArgs(t, { host: 'web', command: 'uptime' }).ok);
  assert.equal(validateArgs(t, { command: 'uptime' }).ok, false, 'host is required');
  assert.equal(validateArgs(t, { host: 'web', command: 12 }).ok, false, 'types are enforced');
  assert.equal(callSummary(t, { host: 'web', command: 'uptime' }), 'On web: uptime');
});

test('the manual documents ssh_exec and the saved-host rule', () => {
  const m = manual();
  assert.ok(m.includes('ssh_exec('), 'the tool is in the prompt manual');
  assert.ok(/SSH:/.test(m), 'its group has a title');
  assert.ok(m.includes('saved in Settings → SSH'), 'the model is told only saved hosts exist');
});

/* ---------------- the executor, without touching the network ---------------- */

test('ssh_exec only ever reaches the saved list', async () => {
  const sshTools = require('../src/main/ssh');
  const hosts = [{ id: 'a1', label: 'Web', host: 'web.example' }];
  const ctx = { sshHosts: () => hosts };
  await assert.rejects(
    () => sshTools.run('ssh_exec', { host: 'evil.example', command: 'uname -a' }, ctx),
    /Settings → SSH/, 'an address that was never saved cannot be typed');
  await assert.rejects(
    () => sshTools.run('ssh_exec', { host: 'Web', command: '  ' }, ctx),
    /No command/, 'a label from the list resolves, but the command is still checked');
  await assert.rejects(
    () => sshTools.run('ssh_exec', { host: 'a1', command: 'uptime' }, { sshHosts: () => [] }),
    /Settings → SSH/, 'an emptied list refuses everything');
  await assert.rejects(
    () => sshTools.run('not_a_tool', {}, {}), /no tool called/);
});

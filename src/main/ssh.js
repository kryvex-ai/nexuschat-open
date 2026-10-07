'use strict';

/**
 * SSH — the spawn layer. Everything here drives the system OpenSSH client
 * (`ssh`, `ssh-keygen`) as a child process; the argv comes from the pure
 * builder in shared/ssh.js, so validation and quoting never happen twice.
 *
 * Why OpenSSH and not a library: the user's ssh-agent, ~/.ssh/config,
 * ProxyJump chains and certificates keep working exactly as they do in a
 * terminal, there is still not a single runtime dependency, and BatchMode
 * (set by the builder) makes "prompt for a password" structurally
 * impossible — this app never sees one.
 *
 * Every call is bounded: a connect timeout baked into the argv and a hard
 * wall-clock kill on top, with output capped so a runaway `yes` on a big
 * disk cannot eat the renderer.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SSH_LIMITS, buildSshArgs, remoteListCommand, parseRemoteList, parseListDir,
  remoteReadCommand, sshConfigBlock, knownHostsQuery, auditSsh, parseSshG,
  isProbablyText, firstLine, listVal, sanitizeCommand
} = require('../shared/ssh');

const NO_SSH = 'OpenSSH (ssh) was not found on this machine. Install it first — on Windows: Settings → Apps → Optional features → OpenSSH Client.';

function expandHome(p) {
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The saved record, with the key path resolved for this machine. */
function prep(host) {
  return { ...host, keyFile: expandHome(host.keyFile) };
}

/**
 * Run one binary to completion. Never rejects on a non-zero exit — callers
 * check `code` — only on "could not start" or "no ssh on this box".
 * Output is kept as a Buffer so binary detection can look at raw bytes.
 */
function spawnBounded(bin, args, { timeoutMs = 30000, maxBytes = SSH_LIMITS.OUTPUT_MAX } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      reject(new Error(bin === 'ssh' ? NO_SSH : String(e && e.message || e)));
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let outCut = false;
    let errCut = false;
    let timedOut = false;
    let settled = false;

    const hardKill = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    }, timeoutMs);
    if (hardKill.unref) hardKill.unref();

    child.stdout.on('data', (c) => {
      if (outLen < maxBytes) { out.push(c); outLen += c.length; } else outCut = true;
    });
    child.stderr.on('data', (c) => {
      if (errLen < maxBytes) { err.push(c); errLen += c.length; } else errCut = true;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      reject(new Error(String(e && e.code === 'ENOENT' ? NO_SSH : (e && e.message) || e)));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      resolve({
        code: code === null ? 124 : code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        truncated: outCut || errCut,
        timedOut,
        ms: Date.now() - started
      });
    });
  });
}

const errText = (r) => firstLine(r.stderr.length ? r.stderr.toString('utf8') : r.stdout.toString('utf8'));

/** Run a command on the host. Explicit user action: pins the key on first use. */
async function sshRun(host, command, timeoutMs = SSH_LIMITS.RUN_TIMEOUT_MS) {
  const r = await spawnBounded('ssh', buildSshArgs(prep(host), { acceptNew: true, command }), { timeoutMs });
  return {
    code: r.code, timedOut: r.timedOut, ms: r.ms,
    stdout: r.stdout.toString('utf8').slice(0, SSH_LIMITS.OUTPUT_MAX),
    stderr: r.stderr.toString('utf8').slice(0, SSH_LIMITS.OUTPUT_MAX),
    truncated: r.truncated
  };
}

/**
 * One read-only handshake: strict about the host key (this must never pin
 * anything as a side effect of a test) and BatchMode about auth.
 */
async function sshProbe(host) {
  try {
    const r = await spawnBounded('ssh', buildSshArgs(prep(host), { command: 'true', connectTimeoutS: 6 }), { timeoutMs: SSH_LIMITS.PROBE_TIMEOUT_MS });
    if (r.timedOut) return { ok: false, ms: r.ms, error: 'No answer within ' + Math.round(SSH_LIMITS.PROBE_TIMEOUT_MS / 1000) + 's.' };
    if (r.code === 0) return { ok: true, ms: r.ms };
    return { ok: false, ms: r.ms, error: errText(r) || 'Connection failed (exit ' + r.code + ').' };
  } catch (e) {
    return { ok: false, ms: 0, error: String((e && e.message) || e) };
  }
}

/** `ssh -G` — the effective config for this host, no network involved. */
async function sshEffectiveConfig(host) {
  const r = await spawnBounded('ssh', buildSshArgs(prep(host), { flag: '-G' }), { timeoutMs: 10000 });
  if (r.timedOut || r.code !== 0) throw new Error(errText(r) || 'ssh -G failed — check the host name.');
  return parseSshG(r.stdout.toString('utf8'));
}

async function keygenFind(host) {
  try {
    const r = await spawnBounded('ssh-keygen', ['-F', knownHostsQuery(host)], { timeoutMs: 5000, maxBytes: 65536 });
    return r.code === 0 && r.stdout.toString('utf8').trim().length > 0;
  } catch {
    return false;
  }
}

async function keygenForget(host) {
  const r = await spawnBounded('ssh-keygen', ['-R', knownHostsQuery(host)], { timeoutMs: 5000, maxBytes: 65536 });
  if (r.code !== 0 && r.stderr.toString('utf8').trim()) throw new Error(errText(r));
  return { ok: r.code === 0 };
}

/** Facts about the local key: the configured file, else the first default that exists. */
function statKey(host) {
  const candidates = host.keyFile
    ? [expandHome(host.keyFile)]
    : ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(n => path.join(os.homedir(), '.ssh', n));
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return { path: p, exists: true, mode: process.platform === 'win32' ? null : st.mode & 0o777 };
    } catch { /* try the next */ }
  }
  return { path: candidates[0], exists: false, mode: null };
}

async function sshList(host, remotePath) {
  const r = await spawnBounded('ssh', buildSshArgs(prep(host), { acceptNew: true, command: remoteListCommand(remotePath) }), { timeoutMs: SSH_LIMITS.LIST_TIMEOUT_MS });
  const text = r.stdout.toString('utf8');
  if (r.code !== 0 && !text) throw new Error(errText(r) || 'Listing failed (exit ' + r.code + ').');
  const entries = parseRemoteList(text).slice(0, 2000);
  return { dir: parseListDir(text) || remotePath || '', entries, truncated: r.truncated };
}

async function sshRead(host, remotePath, maxBytes = SSH_LIMITS.READ_MAX) {
  const r = await spawnBounded('ssh', buildSshArgs(prep(host), { acceptNew: true, command: remoteReadCommand(remotePath, maxBytes) }), { timeoutMs: SSH_LIMITS.READ_TIMEOUT_MS });
  const buf = r.stdout;
  if (r.code !== 0 && !buf.length) throw new Error(errText(r) || 'Read failed (exit ' + r.code + ').');
  const truncated = buf.length > maxBytes;
  const body = truncated ? buf.subarray(0, maxBytes) : buf;
  return {
    bytes: body.length,
    truncated,
    binary: !isProbablyText(body),
    text: body.toString('utf8')
  };
}

/**
 * Stream a remote file into the workspace. Unique name, hard byte cap, and
 * a partial file is unlinked — a cancelled or oversized save never leaves
 * debris for the agent to trip over.
 */
async function sshSave(host, remotePath, destPath, maxBytes = SSH_LIMITS.SAVE_MAX) {
  const args = buildSshArgs(prep(host), { acceptNew: true, command: remoteReadCommand(remotePath, maxBytes) });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('ssh', args, { windowsHide: true });
    } catch (e) {
      reject(new Error(String((e && e.message) || e)));
      return;
    }
    const out = fs.createWriteStream(destPath, { flags: 'wx' });
    let bytes = 0;
    let failed = null;
    const cleanup = (msg) => {
      try { out.destroy(); } catch { /* already closed */ }
      try { fs.unlinkSync(destPath); } catch { /* partial already gone */ }
      reject(new Error(msg));
    };
    out.on('error', (e) => { failed = 'Cannot write the workspace file: ' + String(e && e.message || e); });
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        failed = 'The file is larger than the ' + Math.round(maxBytes / 1048576) + ' MB save limit.';
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (c) => { if (errBuf.length < 8192) errBuf += c.toString('utf8'); });
    child.on('error', (e) => cleanup(String((e && e.message) || e)));
    child.on('close', () => {
      out.end(() => {
        if (failed) return cleanup(failed);
        if (bytes === 0) return cleanup(firstLine(errBuf) || 'The remote file could not be read.');
        resolve({ bytes });
      });
    });
    child.stdout.pipe(out, { end: false });
  });
}

/** The full self-test: offline audit first, then one probe. */
async function sshTest(host) {
  const eff = await sshEffectiveConfig(host);
  const known = await keygenFind(host);
  const key = statKey(host);
  const connect = await sshProbe(host);
  const { score, findings, note } = auditSsh(eff, { connect, knownHosts: known, key });
  return {
    ok: true, score, findings, note,
    config: sshConfigBlock(host),
    effective: {
      hostname: eff.hostname || host.host,
      user: eff.user || '',
      port: eff.port || String(host.port || 22),
      identityfile: listVal(eff, 'identityfile')
    }
  };
}

/**
 * The model's `host` argument, resolved against the saved list: id first,
 * then label, then the address itself. Nothing else can match, so a model
 * that invents a host simply gets an error naming the list it must pick from.
 */
function resolveHost(hosts, want) {
  const s = String(want == null ? '' : want).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  return hosts.find(h => h && h.id === s)
    || hosts.find(h => h && String(h.label || '').toLowerCase() === low)
    || hosts.find(h => h && String(h.host || '').toLowerCase() === low)
    || null;
}

/** ssh_exec — the permission gate has already asked; this only runs it. */
async function sshExecTool(args, ctx) {
  const list = typeof ctx.sshHosts === 'function' ? ctx.sshHosts() : [];
  const host = resolveHost(Array.isArray(list) ? list : [], args.host);
  if (!host) {
    throw new Error('No saved host matches "' + String(args.host || '').slice(0, 80)
      + '". Hosts live in Settings → SSH; add one there and use its id or label.');
  }
  const command = sanitizeCommand(args.command);
  if (!command) throw new Error('No command to run.');
  const floor = SSH_LIMITS.TOOL_MIN_MS;
  const ms = Math.min(SSH_LIMITS.TOOL_MAX_MS, Math.max(floor, Math.floor(Number(args.timeout_ms) || SSH_LIMITS.RUN_TIMEOUT_MS)));
  const r = await sshRun(host, command, ms);
  // Same shape the local shell tool returns, so the model reads both alike.
  const head = `exit ${r.code}${r.timedOut ? ` — killed after ${Math.round(ms / 1000)}s` : ''}\n$ ${command}\n`;
  if (!r.stdout && !r.stderr) return head + '(no output)';
  return head + (r.stdout ? r.stdout : '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
}

/** The executor shape src/main/tools/index.js dispatches on. */
const HANDLERS = { ssh_exec: sshExecTool };

async function run(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error('ssh has no tool called ' + name);
  return handler(args || {}, ctx || {});
}

module.exports = { sshRun, sshProbe, sshEffectiveConfig, keygenFind, keygenForget, statKey, sshList, sshRead, sshSave, sshTest, expandHome, HANDLERS, run };

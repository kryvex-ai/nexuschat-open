'use strict';

/**
 * Shell, git and network tools.
 *
 * Three different trust levels live here, and the differences matter:
 *
 *  - git runs with an argv array and NO shell, because its arguments come
 *    straight from the model. Git itself can execute code through options
 *    like --upload-pack or --ext-diff, so those are refused outright, and the
 *    environment is pinned so a command can never sit waiting for a password
 *    prompt behind an invisible window.
 *  - run_command is deliberately a shell. That is the point of the tool, it
 *    is always confirmed in the permission prompt, and it runs with the cwd
 *    confined to the workspace.
 *  - http_fetch is the one tool that leaves the machine. It stays behind the
 *    network switch in Settings and always asks.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { resolvePath } = require('./paths');
const { LIMITS } = require('../../shared/tools');

/** Git options that can run something on this machine. Refused, not sanitised. */
const GIT_DENIED = [
  '--upload-pack', '--exec-path', '--output', '--ext-diff', '--textconv',
  '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config',
  '-c', '--help', '--html-path', '--man-path', '--info-path', '-p', '--paginate'
];

const GIT_ENV = {
  ...process.env,
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_NOSYSTEM: '1',
  // A repo-local hook must not be able to run something either.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null'
};

function fail(msg) {
  throw new Error(msg);
}

function clip(text, max = LIMITS.OUTPUT_MAX) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `\n… (truncated at ${max} characters)`, truncated: true };
}

/**
 * Spawn a process and collect its output. Always resolves: a non-zero exit is
 * a result, not an error, and the timeout kills the whole process group so a
 * command that starts children does not leave them running.
 */
function runProcess(argv, { cwd, timeoutMs = 120000, shell = false, input = null, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell ? argv[0] : argv[0], argv.slice(1), {
        cwd,
        // Callers can pin the environment (git must never stop for a password
        // prompt); the user's own environment is the default.
        env: env || process.env,
        shell,
        // Always its own process group: a timeout has to be able to kill the
        // children too, or `sleep 60` would outlive the command that started it.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message), timedOut: false, truncated: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = LIMITS.OUTPUT_MAX;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole group when we can; fall back to the child alone.
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);

    child.stdout?.on('data', d => { if (stdout.length < cap) stdout += d; });
    child.stderr?.on('data', d => { if (stderr.length < cap) stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: clip(stdout).text, stderr: String(e.message), timedOut, truncated: stdout.length >= cap });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout: clip(stdout).text, stderr: clip(stderr).text, timedOut, truncated: stdout.length >= cap || stderr.length >= cap });
    });
    if (input !== null && child.stdin) { try { child.stdin.end(input); } catch { /* ignore */ } }
  });
}

/** Reject git arguments that could execute code or point git somewhere else. */
function assertSafeGitArgs(args) {
  for (const a of args) {
    const s = String(a);
    if (s.includes('\0') || s.includes('\n')) fail('git arguments must be single-line text.');
    // `-c` (config) is the classic one: `-c core.sshCommand=…` runs a command, and
    // it can arrive as two arguments or glued on as `-cfoo=bar`.
    if (GIT_DENIED.includes(s)) fail(`The git option ${s} is not something a tool may pass — it can run code on this machine.`);
    if (/^-c/.test(s)) fail('git -c (config overrides) is not something a tool may pass — it can run code on this machine.');
    if (/^--(upload-pack|exec-path|output|ext-diff|textconv|config|git-dir|work-tree|namespace|super-prefix|pager|diff-filter)=/.test(s)) {
      fail('That git option can run code or redirect where git writes — tools may not pass it.');
    }
  }
}

/** The repository the call is about, refused when it is not a git repo. */
async function repoDir(root, maybe) {
  const base = maybe ? resolvePath(root, maybe) : { ok: true, abs: root, rel: '' };
  if (!base.ok) fail(base.error);
  let out = '';
  for (let dir = base.abs; ;) {
    if (fs.existsSync(path.join(dir, '.git'))) return { dir, rel: path.relative(root, dir) || '.' };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  fail('That is not inside a git repository — git tools need one.');
  return null;
}

async function git(root, argv, { cwdRel = '', timeoutMs = 60000 } = {}) {
  const repo = await repoDir(root, cwdRel);
  assertSafeGitArgs([...argv]);
  return runProcess(['git', '--no-pager', '-c', 'color.ui=false', ...argv], {
    cwd: repo.dir,
    timeoutMs,
    env: GIT_ENV
  });
}/* ---------------- git handlers ---------------- */

const GIT_HANDLERS = {
  async git_status(args, { root }) {
    const r = await git(root, ['status', '--short', '--branch'], { cwdRel: args.path || '' });
    return r.code === 0 ? (r.stdout.trim() || 'Working tree clean.') : `git status failed: ${r.stderr || r.stdout}`;
  },

  async git_diff(args, { root }) {
    const argv = ['diff'];
    if (args.staged === true) argv.push('--staged');
    if (args.ref) { assertSafeGitArgs([String(args.ref)]); argv.push(String(args.ref)); }
    if (args.path) { assertSafeGitArgs([String(args.path)]); argv.push('--', String(args.path)); }
    const r = await git(root, argv);
    if (r.code !== 0) return `git diff failed: ${r.stderr || r.stdout}`;
    return r.stdout.trim() ? r.stdout : 'No differences.';
  },

  async git_log(args, { root }) {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 20)));
    const argv = ['log', `-${limit}`, '--date=short', '--pretty=%h %ad %an %s'];
    if (args.path) { assertSafeGitArgs([String(args.path)]); argv.push('--', String(args.path)); }
    const r = await git(root, argv);
    return r.code === 0 ? (r.stdout.trim() || 'No commits yet.') : `git log failed: ${r.stderr || r.stdout}`;
  },

  async git_show(args, { root }) {
    assertSafeGitArgs([String(args.ref)]);
    const r = await git(root, ['show', String(args.ref)]);
    return r.code === 0 ? r.stdout : `git show failed: ${r.stderr || r.stdout}`;
  },

  async git_stage(args, { root }) {
    const paths = (args.paths && args.paths.length) ? args.paths : ['.'];
    assertSafeGitArgs(paths);
    const r = await git(root, [args.unstage === true ? 'restore' : 'add', '--', ...paths]);
    if (r.code !== 0) return `git ${args.unstage ? 'restore' : 'add'} failed: ${r.stderr || r.stdout}`;
    const status = await git(root, ['status', '--short']);
    return `${args.unstage ? 'Unstaged' : 'Staged'}: ${paths.join(', ')}\n${status.stdout.trim() || '(nothing else changed)'}`;
  },

  async git_commit(args, { root }) {
    const message = String(args.message || '').trim();
    if (!message) fail('A commit needs a message.');
    if (message.includes('\0')) fail('The commit message must be single-line text.');
    const argv = ['commit', '-m', message];
    if (args.amend === true) argv.push('--amend');
    const r = await git(root, argv);
    if (r.code !== 0) {
      const out = (r.stdout + r.stderr).trim();
      if (/nothing to commit|no changes added/i.test(out)) return 'Nothing to commit — the working tree has no staged changes.';
      return `git commit failed: ${out}`;
    }
    const head = await git(root, ['rev-parse', '--short', 'HEAD']);
    return `Committed ${head.stdout.trim()}: ${message.split('\n')[0]}`;
  },

  async git_branch(args, { root }) {
    const action = String(args.action || 'list');
    if (action === 'list') {
      const r = await git(root, ['branch', '--format=%(refname:short) %(objectname:short)']);
      return r.code === 0 ? (r.stdout.trim() || 'No branches yet.') : `git branch failed: ${r.stderr}`;
    }
    const name = String(args.name || '').trim();
    if (!name) fail('That action needs a branch "name".');
    if (!/^[\w./-]{1,120}$/.test(name) || name.startsWith('-')) fail('That is not a usable branch name.');
    if (action === 'create') {
      const r = await git(root, ['branch', name]);
      return r.code === 0 ? `Created branch ${name}.` : `git branch failed: ${(r.stderr || r.stdout).trim()}`;
    }
    if (action === 'switch') {
      const r = await git(root, ['switch', name]);
      return r.code === 0 ? `Switched to ${name}.` : `git switch failed: ${(r.stderr || r.stdout).trim()}`;
    }
    fail('git_branch action must be "list", "create" or "switch".');
    return '';
  }
};/* ---------------- shell + network handlers ---------------- */

const MISC_HANDLERS = {
  async run_command(args, { root }) {
    const command = String(args.command || '').trim();
    if (!command) fail('An empty command does nothing.');
    if (command.includes('\0')) fail('That command contains a NUL byte.');
    const cwd = args.cwd ? resolvePath(root, args.cwd) : { ok: true, abs: root, rel: '' };
    if (!cwd.ok) fail(cwd.error);
    if (!fs.existsSync(cwd.abs)) fail(`${cwd.rel} does not exist.`);
    const ms = Math.min(LIMITS.TIMEOUT_MAX_MS, Math.max(LIMITS.TIMEOUT_MIN_MS, Math.floor(Number(args.timeout_ms) || 120000)));
    const r = await runProcess([command], { cwd: cwd.abs, timeoutMs: ms, shell: true });
    const head = `exit ${r.code}${r.timedOut ? ` — killed after ${Math.round(ms / 1000)}s` : ''}\n$ ${command}\n`;
    if (!r.stdout && !r.stderr) return head + '(no output)';
    return head + (r.stdout ? r.stdout : '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
  },

  async http_fetch(args, { root }) {
    let url;
    try {
      url = new URL(String(args.url));
    } catch {
      fail('That is not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('Only http and https URLs are fetched.');
    const method = String(args.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('Unsupported HTTP method.');
    const headers = { 'user-agent': 'NexusChat Open agent tool' };
    if (args.headers && typeof args.headers === 'object') {
      for (const [k, v] of Object.entries(args.headers)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) fail('Unsupported header name.');
        if (!/^[\x20-\x7e]{0,512}$/.test(String(v))) fail('Unsupported header value.');
        headers[k.toLowerCase()] = String(v);
      }
    }
    if (args.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: args.body ? String(args.body) : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      });
    } catch (e) {
      fail('Request failed: ' + (e && e.message ? e.message : String(e)));
    }
    const text = await res.text().catch(() => '');
    const out = clip(text);
    return [
      `${method} ${url} → ${res.status} ${res.statusText} (${Date.now() - started}ms)`,
      res.headers.get('content-type') ? `content-type: ${res.headers.get('content-type')}` : '',
      '',
      out.text
    ].filter(Boolean).join('\n');
  }
};

const HANDLERS = { ...GIT_HANDLERS, ...MISC_HANDLERS };

async function run(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error('Unknown shell tool: ' + name);
  return handler(args, ctx);
}

module.exports = {
  run, HANDLERS, GIT_HANDLERS, MISC_HANDLERS,
  runProcess, assertSafeGitArgs, GIT_DENIED, GIT_ENV
};
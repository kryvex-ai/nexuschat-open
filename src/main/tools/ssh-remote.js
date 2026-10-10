'use strict';

/**
 * SSH-remote executors — the same tool names the model already knows, run on
 * the chat's connected host instead of this PC.
 *
 * Every handler receives validated registry args (ToolHost did that) plus a
 * context { remote: { host, base }, ssh }. `host` is the saved host record,
 * `base` the connected folder ('' = login home). `ssh` defaults to the real
 * runner in ../ssh and is injectable in tests.
 *
 * Command construction rules (why they look the way they do):
 *  - The model path stays RELATIVE: commands start with `cd <base>` (or
 *    `cd "$HOME"` when base is ''), then operate on the quoted relative
 *    path. Nothing is ever joined locally, so the login-home case needs no
 *    extra round trip, and git pathspecs stay cwd-relative as git expects.
 *  - Remote paths are single-quoted via shQuote; the compound script is
 *    wrapped in an explicit `sh -c`, so fish/csh logins cannot reinterpret it.
 *  - The model command in run_command is free text by design — it runs
 *    remotely, exactly like ssh_exec.
 *  - Writes travel base64-encoded (printf '%s' + decode with GNU/BSD
 *    fallbacks), never interpolated as shell text.
 *  - Markers (NOCD/NOTFOUND/EXISTS) are echoed by the script itself so a
 *    missing folder reads as a message, not an ssh exit-code puzzle.
 */

const { LIMITS } = require('../../shared/tools');
const { shQuote, SSH_LIMITS } = require('../../shared/ssh');
const { assertSafeGitArgs } = require('./shell');

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Mirrors local SKIP_DIRS so remote searches skip the same generated trees. */
const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.idea',
  '.vscode', '.mypy_cache', '.pytest_cache', '.tox'
];
const EXCLUDE_FLAGS = SKIP_DIRS.map(d => '--exclude-dir=' + d).join(' ');

const MAX_READ_BYTES = 400000;

/** Tools that run remotely when a chat is connected. http_fetch stays local. */
const REMOTE_TOOLS = new Set([
  'read_file', 'list_dir', 'search_files', 'grep_files', 'file_info',
  'diff_files', 'project_info',
  'write_file', 'edit_file', 'multi_edit', 'append_file', 'create_dir',
  'move_file', 'copy_file', 'delete_file',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_stage',
  'git_commit', 'git_branch',
  'run_command', 'find_paths'
]);

function isRemoteable(name) {
  return REMOTE_TOOLS.has(name);
}

function fail(msg) {
  throw new Error(msg);
}

function sshOf(ctx) {
  if (ctx && ctx.ssh && typeof ctx.ssh.sshRun === 'function') return ctx.ssh;
  if (ctx && ctx.remote && ctx.remote.ssh && typeof ctx.remote.ssh.sshRun === 'function') return ctx.remote.ssh;
  return require('../ssh');
}

function remoteOf(ctx) {
  const r = ctx && ctx.remote;
  if (!r || !r.host) fail('This chat is not connected to an SSH host — pick one under the chat first.');
  return { host: r.host, base: typeof r.base === 'string' ? r.base : '' };
}

/**
 * Validate a model-supplied relative path and normalize it. Returns the
 * normalized rel (forward slashes, no leading ./). Throws on absolute paths,
 * home shortcuts, traversal above the connected folder, NUL/control bytes.
 */
function checkRel(p, { allowEmpty = false } = {}) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) {
    if (allowEmpty) return '';
    fail('A path is required.');
  }
  if (raw.includes('\0')) fail('That path contains a NUL byte.');
  if (CONTROL_RE.test(raw)) fail('That path contains control characters.');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('~')) {
    fail('Paths are relative to the connected folder — "' + raw.slice(0, 60) + '" is not inside it.');
  }
  if (raw.length > 1024) fail('That path is too long.');
  const parts = raw.split('/'); // keep empties to catch "//", resolve below
  const stack = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!stack.length) fail('That path climbs above the connected folder — stay inside it.');
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (!stack.length) {
    if (allowEmpty) return '';
    fail('A path is required.');
  }
  return stack.join('/');
}

function checkRelDir(p) {
  // The workspace root itself ("", ".") is a valid listing/search root.
  const raw = String(p == null ? '' : p).trim();
  if (!raw || raw === '.') return '';
  return checkRel(raw);
}

/** `cd <base>` prefix: absolute base quoted, home as "$HOME" (unquoted). */
function cdPart(base) {
  const b = String(base || '').trim();
  const dest = b ? shQuote(b) : '"$HOME"';
  return 'cd ' + dest + ' || { echo NOCD; exit 1; }; ';
}

const sh = (script) => 'sh -c ' + shQuote(script);
const Q = (s) => shQuote(s);
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const DECODE = "(base64 -d 2>/dev/null || base64 -D 2>/dev/null || base64 --decode)";

function clipOut(text, max = LIMITS.OUTPUT_MAX) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + '\n… (truncated at ' + max + ' characters)', truncated: true };
}

function throwIfNoCd(r) {
  const out = String((r.stdout || '') + '\n' + (r.stderr || ''));
  if (/^NOCD|[\n]NOCD/.test(out) || /NOCD/.test(out.split('\n')[0])) {
    fail('The connected folder is not there any more — reconnect the chat to a folder that exists.');
  }
}

function remoteError(r, fallback) {
  const first = String(r.stderr || r.stdout || '').split('\n')[0].trim();
  return first || fallback || ('Remote command failed (exit ' + r.code + ').');
}

function splitLines(text) {
  return String(text).replace(/\n$/, '').split('\n');
}

function numbered(text, startLine = 1) {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => String(startLine + i).padStart(width, ' ') + '  ' + l).join('\n');
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function posixDirname(rel) {
  const i = rel.lastIndexOf('/');
  return i <= 0 ? '' : rel.slice(0, i);
}

function guardWrite(rel) {
  const top = String(rel).split('/')[0];
  if (top === '.git') fail('Writing inside .git/ is not something a text tool should do — use the git tools instead.');
}

async function runScript(host, ssh, script, timeoutMs) {
  const r = await ssh.sshRun(host, sh(script), timeoutMs);
  throwIfNoCd(r);
  return r;
}

/* ---------------- reads ---------------- */

const READ_HANDLERS = {
  async read_file(args, ctx) {
    const rel = checkRel(args.path);
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const cap = Math.min(Number(args.max_bytes) || MAX_READ_BYTES, MAX_READ_BYTES);
    // Ask for one byte more so truncation is detectable, like the preview does.
    const script = cdPart(base) + 'p=' + Q(rel) + '; [ -d "$p" ] && { echo ISDIR; exit 1; };'
      + ' [ -e "$p" ] || [ -L "$p" ] || { echo NOTFOUND; exit 1; };'
      + ' head -c ' + (cap + 1) + ' "$p"';
    const r = await runScript(host, ssh, script, 20000);
    const out = String(r.stdout || '');
    if (r.code !== 0) {
      if (/NOTFOUND/.test(out)) fail(rel + ' does not exist on the host.');
      if (/ISDIR/.test(out)) fail(rel + ' is a directory — use list_dir.');
      fail(remoteError(r, 'Could not read ' + rel + '.'));
    }
    if (/\0/.test(out.slice(0, 8000))) fail(rel + ' looks like a binary file, so there is no text to read.');
    const truncated = Buffer.byteLength(out, 'utf8') > cap;
    const text = truncated ? Buffer.from(out, 'utf8').subarray(0, cap).toString('utf8') : out;
    const all = splitLines(text);
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    const end = args.end_line ? Math.min(all.length, Math.floor(Number(args.end_line))) : all.length;
    if (start > all.length) fail(rel + ' has ' + all.length + ' line(s); start_line ' + start + ' is past the end.');
    const slice = all.slice(start - 1, end);
    return rel + ' — ' + all.length + ' line(s)' + (truncated ? ' (truncated)' : '') + '\n' + numbered(slice.join('\n'), start);
  },

  async list_dir(args, ctx) {
    const rel = checkRelDir(args.path);
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const pattern = args.pattern ? String(args.pattern) : '';
    if (args.recursive) {
      const depth = Math.min(8, Math.max(1, Math.floor(Number(args.depth) || 2)));
      const nameFlag = pattern ? ' -name ' + Q('*' + pattern) : '';
      const at = rel ? Q(rel) : '.';
      const script = cdPart(base) + '[ -d ' + at + ' ] || { echo NOTFOUND; exit 1; };'
        + ' find ' + at + ' -maxdepth ' + depth + ' -not -path "*/node_modules*" -not -path "*/.git*"'
        + nameFlag + ' | head -n 2000';
      const r = await runScript(host, ssh, script, 30000);
      if (r.code !== 0) {
        if (/NOTFOUND/.test(String(r.stdout))) fail((rel || 'That folder') + ' is not a directory on the host.');
        fail(remoteError(r, 'Could not list ' + (rel || 'the folder') + '.'));
      }
      const rows = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
        .filter(s => s !== '.' && !s.startsWith('./node_modules') && !s.includes('/node_modules/') && !s.includes('/.git/'))
        .map(s => s.replace(/^\.\//, ''))
        .filter(s => !pattern || s.endsWith(pattern));
      if (!rows.length) return (rel || 'Remote folder') + ' is empty.';
      const lines = rows.slice(0, 2000).map(s => 'file            ' + s);
      return (rel || 'Remote folder') + ' — ' + lines.length + ' entr' + (lines.length === 1 ? 'y' : 'ies') + ':\n' + lines.join('\n');
    }
    // Flat listing reuses the file browser's line protocol (type + size).
    const list = await ssh.sshList(host, base && rel ? base.replace(/\/$/, '') + '/' + rel : base || rel || '');
    const entries = Array.isArray(list.entries) ? list.entries : [];
    const rows = [];
    for (const e of entries) {
      const name = e.name || '';
      if (pattern && !name.endsWith(pattern)) continue;
      // e.path is absolute; show it relative to the connected folder.
      const shown = rel ? (rel + '/' + name) : name;
      const kind = e.dir ? 'dir ' : 'file';
      const size = e.dir ? '' : String(e.size === 0 || e.size ? e.size : '');
      rows.push(kind + '  ' + size.padStart(9) + '  ' + shown);
    }
    if (!rows.length) return (rel || 'Remote folder') + ' is empty.';
    return (rel || 'Remote folder') + ' — ' + rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + ':\n' + rows.join('\n');
  },

  async search_files(args, ctx) {
    const query = String(args.query);
    if (!query) fail('A search needs a query.');
    const rel = checkRelDir(args.path);
    const include = args.include ? String(args.include) : '';
    const max = Math.min(500, Math.max(1, Math.floor(Number(args.max_results) || 100)));
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const at = rel ? Q(rel) : '.';
    const inc = include ? ' --include=' + Q('*' + include) : '';
    const script = cdPart(base) + 'grep -rnIF ' + EXCLUDE_FLAGS + inc + ' -e ' + Q(query) + ' ' + at
      + ' 2>/dev/null | head -n ' + max;
    const r = await runScript(host, ssh, script, 30000);
    const text = String(r.stdout || '').trim();
    if (!text) return 'No match for “' + query.slice(0, 120) + '”.';
    const c = clipOut(text);
    return c.text;
  },

  async grep_files(args, ctx) {
    const source = String(args.pattern);
    try {
      // eslint-disable-next-line no-new
      new RegExp(source);
    } catch (e) {
      fail('That is not a valid regular expression: ' + e.message);
    }
    const rel = checkRelDir(args.path);
    const include = args.include ? String(args.include) : '';
    const max = Math.min(500, Math.max(1, Math.floor(Number(args.max_results) || 100)));
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const at = rel ? Q(rel) : '.';
    const inc = include ? ' --include=' + Q('*' + include) : '';
    const icase = args.ignore_case === true ? ' -i' : '';
    const script = cdPart(base) + 'grep -rnI' + icase + ' ' + EXCLUDE_FLAGS + inc + ' -e ' + Q(source) + ' ' + at
      + ' 2>/dev/null | head -n ' + max;
    const r = await runScript(host, ssh, script, 30000);
    if (r.code !== 0 && r.code !== 1 && !String(r.stdout || '').trim()) {
      fail(remoteError(r, 'Remote search failed.'));
    }
    const text = String(r.stdout || '').trim();
    if (!text) return 'No line matches /' + source.slice(0, 120) + '/.';
    return clipOut(text).text;
  },

  async find_paths(args, ctx) {
    const query = String(args.query);
    if (!query.trim()) fail('A search needs a query.');
    const rel = checkRelDir(args.path);
    const max = Math.min(500, Math.max(1, Math.floor(Number(args.max_results) || 100)));
    const includeDirs = args.include_dirs !== false;
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    // Substring match on the name, case-insensitive; glob metacharacters in
    // the query are escaped so they stay literal inside -iname.
    const escaped = query.replace(/([*?\[\\])/g, '\\$1');
    const at = rel ? Q(rel) : '.';
    const skip = '-not -path "*/node_modules/*" -not -path "*/.git/*"';
    const dirScript = cdPart(base) + 'find ' + at + ' -maxdepth 8 -type d -iname ' + Q('*' + escaped + '*')
      + ' ' + skip + ' 2>/dev/null | head -n ' + max;
    const fileScript = cdPart(base) + 'find ' + at + ' -maxdepth 8 -type f -iname ' + Q('*' + escaped + '*')
      + ' ' + skip + ' 2>/dev/null | head -n ' + max;
    const jobs = [runScript(host, ssh, fileScript, 30000)];
    if (includeDirs) jobs.unshift(runScript(host, ssh, dirScript, 30000));
    const settled = await Promise.all(jobs);
    const dirs = includeDirs ? settled[0] : null;
    const files = includeDirs ? settled[1] : settled[0];
    const emptyDirs = !String((dirs && dirs.stdout) || '').trim();
    const emptyFiles = !String(files.stdout || '').trim();
    if (emptyDirs && emptyFiles && ((dirs && dirs.code !== 0) || files.code !== 0)) {
      fail(remoteError(files.code !== 0 ? files : dirs, 'Remote search failed.'));
    }
    const clean = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean)
      .map(x => x.replace(/^\.\//, ''));
    const rows = [];
    if (dirs) {
      for (const d of clean(dirs.stdout)) {
        rows.push('dir   ' + d);
        if (rows.length >= max) break;
      }
    }
    for (const f of clean(files.stdout)) {
      rows.push('file  ' + f);
      if (rows.length >= max) break;
    }
    if (!rows.length) return 'No paths matching “' + query.slice(0, 120) + '”.';
    return rows.length + ' path(s) matching “' + query.slice(0, 120) + '”:\n' + clipOut(rows.join('\n')).text;
  },

  async file_info(args, ctx) {
    const rel = checkRel(args.path);
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const script = cdPart(base) + 'p=' + Q(rel) + '; [ -e "$p" ] || [ -L "$p" ] || { echo NOTFOUND; exit 1; };'
      + ' if [ -d "$p" ]; then echo dir; else echo file; fi;'
      + ' s=$(stat -c "%s %Y" "$p" 2>/dev/null || stat -f "%z %m" "$p" 2>/dev/null || echo ""); echo "$s"';
    const r = await runScript(host, ssh, script, 15000);
    if (r.code !== 0) {
      if (/NOTFOUND/.test(String(r.stdout))) return 'No: ' + rel + ' does not exist.';
      fail(remoteError(r, 'Could not inspect ' + rel + '.'));
    }
    const lines = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    const kind = lines[0] === 'dir' ? 'directory' : 'file';
    const meta = (lines[1] || '').split(/\s+/);
    const size = meta[0] && /^\d+$/.test(meta[0]) ? Number(meta[0]) : null;
    const mtime = meta[1] && /^\d+$/.test(meta[1]) ? new Date(Number(meta[1]) * 1000).toISOString() : '';
    const out = [rel + ': exists: yes', 'type: ' + kind];
    if (size !== null) out.push('size: ' + formatSize(size));
    if (mtime) out.push('modified: ' + mtime);
    return out.join('\n');
  },

  async diff_files(args, ctx) {
    const a = checkRel(args.path);
    const b = checkRel(args.other_path);
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const maxLines = Math.min(2000, Math.max(20, Math.floor(Number(args.max_lines) || 400)));
    const script = cdPart(base) + 'diff -U3 ' + Q(a) + ' ' + Q(b) + ' 2>&1 | head -n ' + maxLines;
    const r = await runScript(host, ssh, script, 30000);
    // diff exits 1 when files differ — that is the result, not a failure.
    if (r.code !== 0 && r.code !== 1) fail(remoteError(r, 'Could not diff the files.'));
    const text = String(r.stdout || '').trim();
    if (!text) return 'No differences.';
    return '--- ' + a + '\n+++ ' + b + '\n' + clipOut(text).text;
  },

  async project_info(args, ctx) {
    const { host, base } = remoteOf(ctx);
    const ssh = sshOf(ctx);
    const script = cdPart(base)
      + 'git branch --show-current 2>/dev/null; git rev-parse --short HEAD 2>/dev/null;'
      + ' for f in package.json pyproject.toml Cargo.toml go.mod; do [ -f "$f" ] && { echo "== $f"; head -c 4000 "$f"; echo; }; done';
    const r = await runScript(host, ssh, script, 15000);
    const text = String(r.stdout || '').trim();
    if (!text) return 'Remote folder: no git branch and no recognized manifest found.';
    return clipOut(text).text;
  }
};

/* ---------------- writes ---------------- */

async function remoteWriteFile(host, ssh, base, rel, content, { append = false } = {}) {
  guardWrite(rel);
  if (Buffer.byteLength(String(content), 'utf8') > MAX_READ_BYTES) {
    fail(rel + ' is larger than the ' + formatSize(MAX_READ_BYTES) + ' write limit.');
  }
  const dir = posixDirname(rel);
  const op = append ? '>>' : '>';
  // New vs replaced is reported by a pre-check, like the local writer does.
  const pre = await runScript(host, ssh,
    cdPart(base) + 'p=' + Q(rel) + '; [ -f "$p" ] && echo EXISTS || echo NEW', 15000);
  const existed = /EXISTS/.test(String(pre.stdout));
  const script = cdPart(base)
    + (dir ? 'mkdir -p ' + Q(dir) + ' && ' : '')
    + 't=' + Q(rel + '.tmp-$$') + '; printf \'%s\' ' + Q(b64(content)) + ' | ' + DECODE + ' ' + op + ' "$t" || exit 1;'
    + (append
      ? ' cat "$t" >> ' + Q(rel) + ' && rm -f "$t"'
      : ' mv "$t" ' + Q(rel));
  const r = await runScript(host, ssh, script, 30000);
  if (r.code !== 0) fail(remoteError(r, 'Could not write ' + rel + '.'));
  return { existed };
}

const WRITE_HANDLERS = {
  async write_file(args, ctx) {
    const rel = checkRel(args.path);
    const { host, base } = remoteOf(ctx);
    const { existed } = await remoteWriteFile(host, sshOf(ctx), base, rel, String(args.content));
    const content = String(args.content);
    return (existed ? 'Replaced ' : 'Created ') + rel + ' (' + formatSize(Buffer.byteLength(content)) + ', ' + content.split('\n').length + ' lines).';
  },

  async append_file(args, ctx) {
    const rel = checkRel(args.path);
    const { host, base } = remoteOf(ctx);
    await remoteWriteFile(host, sshOf(ctx), base, rel, String(args.content), { append: true });
    return 'Appended ' + formatSize(Buffer.byteLength(String(args.content))) + ' to ' + rel + '.';
  },

  async create_dir(args, ctx) {
    const rel = checkRel(args.path);
    guardWrite(rel);
    const { host, base } = remoteOf(ctx);
    const r = await runScript(host, sshOf(ctx), cdPart(base) + 'if [ -d ' + Q(rel) + ' ]; then echo EXISTS; else mkdir -p ' + Q(rel) + ' && echo CREATED; fi', 15000);
    if (r.code !== 0) fail(remoteError(r, 'Could not create ' + rel + '.'));
    return /EXISTS/.test(String(r.stdout)) ? rel + ' already exists.' : 'Created ' + rel + '/.';
  },

  async move_file(args, ctx) {
    const from = checkRel(args.path);
    const to = checkRel(args.to);
    guardWrite(from);
    guardWrite(to);
    if (to === from || to.startsWith(from + '/')) fail('A directory cannot be moved inside itself.');
    const { host, base } = remoteOf(ctx);
    const destDir = posixDirname(to);
    const r = await runScript(host, sshOf(ctx), cdPart(base)
      + '[ -e ' + Q(from) + ' ] || [ -L ' + Q(from) + ' ] || { echo NOTFOUND; exit 1; };'
      + '[ -e ' + Q(to) + ' ] && { echo EXISTS; exit 1; };'
      + (destDir ? 'mkdir -p ' + Q(destDir) + ' && ' : '')
      + 'mv ' + Q(from) + ' ' + Q(to), 30000);
    if (r.code !== 0) {
      const out = String(r.stdout || '');
      if (/NOTFOUND/.test(out)) fail(from + ' does not exist.');
      if (/EXISTS/.test(out)) fail(to + ' already exists — remove it or pick another name.');
      fail(remoteError(r, 'Could not move the file.'));
    }
    return 'Moved ' + from + ' → ' + to + '.';
  },

  async copy_file(args, ctx) {
    const from = checkRel(args.path);
    const to = checkRel(args.to);
    guardWrite(to);
    if (to === from || to.startsWith(from + '/')) fail('A directory cannot be copied inside itself.');
    const { host, base } = remoteOf(ctx);
    const destDir = posixDirname(to);
    const r = await runScript(host, sshOf(ctx), cdPart(base)
      + '[ -e ' + Q(from) + ' ] || [ -L ' + Q(from) + ' ] || { echo NOTFOUND; exit 1; };'
      + '[ -e ' + Q(to) + ' ] && { echo EXISTS; exit 1; };'
      + (destDir ? 'mkdir -p ' + Q(destDir) + ' && ' : '')
      + 'cp -r ' + Q(from) + ' ' + Q(to), 30000);
    if (r.code !== 0) {
      const out = String(r.stdout || '');
      if (/NOTFOUND/.test(out)) fail(from + ' does not exist.');
      if (/EXISTS/.test(out)) fail(to + ' already exists.');
      fail(remoteError(r, 'Could not copy the file.'));
    }
    return 'Copied ' + from + ' → ' + to + '.';
  },

  async delete_file(args, ctx) {
    const rel = checkRel(args.path);
    guardWrite(rel);
    const { host, base } = remoteOf(ctx);
    const probe = await runScript(host, sshOf(ctx),
      cdPart(base) + 'p=' + Q(rel) + '; [ -e "$p" ] || [ -L "$p" ] || { echo GONE; exit 0; }; [ -d "$p" ] && echo ISDIR || echo ISFILE', 15000);
    const kind = String(probe.stdout || '');
    if (/GONE/.test(kind)) return rel + ' was already gone.';
    if (/ISDIR/.test(kind) && args.recursive !== true) {
      fail(rel + ' is a directory — pass "recursive": true to delete the whole tree.');
    }
    const op = /ISDIR/.test(kind) ? 'rm -rf -- ' + Q(rel) : 'rm -f -- ' + Q(rel);
    const r = await runScript(host, sshOf(ctx), cdPart(base) + op, 30000);
    if (r.code !== 0) fail(remoteError(r, 'Could not delete ' + rel + '.'));
    return /ISDIR/.test(kind) ? 'Deleted the directory ' + rel + ' and everything in it.' : 'Deleted ' + rel + '.';
  },

  /** Read-modify-write: the snippet rules match the local applyEdits exactly. */
  async edit_apply(p, edits, host, base, ssh) {
    const rel = checkRel(p);
    guardWrite(rel);
    const list = Array.isArray(edits) ? edits : [];
    if (!list.length) fail('No edits to apply.');
    if (list.length > 50) fail('At most 50 edits per call.');
    const read = await ssh.sshRead(host, (base ? base.replace(/\/$/, '') + '/' + rel : rel), SSH_LIMITS.READ_MAX).catch((e) => {
      fail(String((e && e.message) || e));
    });
    if (read.binary) fail(rel + ' looks like a binary file, so there is no text to edit.');
    let text = String(read.text || '');
    let applied = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i] || {};
      const needle = String(e.old_string);
      const replacement = String(e.new_string);
      if (e.new_string === undefined || typeof e.new_string !== 'string') fail('Edit ' + (i + 1) + ' needs a "new_string" (use "" to delete).');
      if (!needle) fail('Edit ' + (i + 1) + ' has no old_string.');
      const first = text.indexOf(needle);
      if (first === -1) fail('Edit ' + (i + 1) + ': that text is not in ' + rel + ' any more — read the file again and match what is there.');
      if (e.replace_all === true) {
        const parts = text.split(needle);
        applied += parts.length - 1;
        text = parts.join(replacement);
        continue;
      }
      if (text.indexOf(needle, first + needle.length) !== -1) {
        fail('Edit ' + (i + 1) + ': that text appears more than once in ' + rel + '. Include more surrounding lines, or set "replace_all": true.');
      }
      text = text.slice(0, first) + replacement + text.slice(first + needle.length);
      applied++;
    }
    await remoteWriteFile(host, ssh, base, rel, text);
    return 'Applied ' + applied + ' edit' + (applied === 1 ? '' : 's') + ' to ' + rel + '.';
  },

  async edit_file(args, ctx) {
    const { host, base } = remoteOf(ctx);
    return WRITE_HANDLERS.edit_apply(args.path,
      [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }],
      host, base, sshOf(ctx));
  },

  async multi_edit(args, ctx) {
    const { host, base } = remoteOf(ctx);
    return WRITE_HANDLERS.edit_apply(args.path, args.edits || [], host, base, sshOf(ctx));
  }
};

/* ---------------- git + shell ---------------- */

const GIT_HANDLERS = {
  async git_status(args, ctx) {
    const rel = checkRelDir(args.path);
    const { host, base } = remoteOf(ctx);
    const at = rel ? Q(rel) : '.';
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'git -C ' + at + ' status --short --branch 2>&1', 60000);
    if (r.code !== 0) {
      if (/not a git repository/i.test(String(r.stdout || '') + String(r.stderr || ''))) {
        return 'That is not inside a git repository — git tools need one.';
      }
      fail(remoteError(r, 'git status failed.'));
    }
    const text = String(r.stdout || '').trim();
    return text || 'Working tree clean.';
  },

  async git_diff(args, ctx) {
    const { host, base } = remoteOf(ctx);
    const argv = ['diff'];
    if (args.staged === true) argv.push('--staged');
    if (args.ref) { assertSafeGitArgs([String(args.ref)]); argv.push(String(args.ref)); }
    let spec = '';
    if (args.path) {
      const rel = checkRel(args.path);
      assertSafeGitArgs([rel]);
      spec = ' -- ' + Q(rel);
    }
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'git ' + argv.map(a => Q(a)).join(' ') + spec + ' 2>&1', 60000);
    if (r.code !== 0) fail(remoteError(r, 'git diff failed.'));
    const text = String(r.stdout || '').trim();
    return text || 'No differences.';
  },

  async git_log(args, ctx) {
    const { host, base } = remoteOf(ctx);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 20)));
    let spec = '';
    if (args.path) {
      const rel = checkRel(args.path);
      assertSafeGitArgs([rel]);
      spec = ' -- ' + Q(rel);
    }
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'git log -' + limit + ' --date=short --pretty=' + Q('%h %ad %an %s') + spec + ' 2>&1', 60000);
    if (r.code !== 0) fail(remoteError(r, 'git log failed.'));
    return String(r.stdout || '').trim() || 'No commits yet.';
  },

  async git_show(args, ctx) {
    assertSafeGitArgs([String(args.ref)]);
    const { host, base } = remoteOf(ctx);
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'git show ' + Q(String(args.ref)) + ' 2>&1', 60000);
    if (r.code !== 0) fail(remoteError(r, 'git show failed.'));
    return clipOut(r.stdout).text;
  },

  async git_stage(args, ctx) {
    const asked = (args.paths && args.paths.length) ? args.paths : ['.'];
    assertSafeGitArgs(asked.map(String));
    const rels = asked.map(p => (p === '.' ? '.' : checkRel(p)));
    const { host, base } = remoteOf(ctx);
    const op = args.unstage === true ? 'restore' : 'add';
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'git ' + op + ' -- ' + rels.map(Q).join(' ') + ' 2>&1 && git status --short 2>&1', 60000);
    if (r.code !== 0) fail(remoteError(r, 'git ' + op + ' failed.'));
    return (args.unstage ? 'Unstaged' : 'Staged') + ': ' + rels.join(', ') + '\n' + (String(r.stdout || '').trim() || '(nothing else changed)');
  },

  async git_commit(args, ctx) {
    const message = String(args.message || '').trim();
    if (!message) fail('A commit needs a message.');
    if (message.includes('\0')) fail('The commit message must be single-line text.');
    const { host, base } = remoteOf(ctx);
    const amend = args.amend === true ? ' --amend' : '';
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + 'printf \'%s\' ' + Q(b64(message)) + ' | ' + DECODE + ' | git commit' + amend + ' -F - 2>&1', 60000);
    const out = String(r.stdout || '') + String(r.stderr || '');
    if (r.code !== 0) {
      if (/nothing to commit|no changes added/i.test(out)) return 'Nothing to commit — the working tree has no staged changes.';
      fail(remoteError(r, 'git commit failed.'));
    }
    const head = await runScript(host, sshOf(ctx), cdPart(base) + 'git rev-parse --short HEAD 2>/dev/null', 15000);
    return 'Committed ' + String(head.stdout || '').trim() + ': ' + message.split('\n')[0];
  },

  async git_branch(args, ctx) {
    const action = String(args.action || 'list');
    const { host, base } = remoteOf(ctx);
    if (action === 'list') {
      const r = await runScript(host, sshOf(ctx),
        cdPart(base) + 'git branch --format=' + Q('%(refname:short) %(objectname:short)') + ' 2>&1', 30000);
      if (r.code !== 0) fail(remoteError(r, 'git branch failed.'));
      return String(r.stdout || '').trim() || 'No branches yet.';
    }
    const name = String(args.name || '').trim();
    if (!name) fail('That action needs a branch "name".');
    if (!/^[\w./-]{1,120}$/.test(name) || name.startsWith('-')) fail('That is not a usable branch name.');
    if (action !== 'create' && action !== 'switch') fail('git_branch action must be "list", "create" or "switch".');
    const r = await runScript(host, sshOf(ctx),
      cdPart(base) + (action === 'create' ? 'git branch ' + Q(name) : 'git switch ' + Q(name)) + ' 2>&1', 30000);
    if (r.code !== 0) fail(remoteError(r, 'git branch failed.'));
    return action === 'create' ? 'Created branch ' + name + '.' : 'Switched to ' + name + '.';
  },

  async run_command(args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) fail('An empty command does nothing.');
    if (command.includes('\0')) fail('That command contains a NUL byte.');
    const { host, base } = remoteOf(ctx);
    // cwd is relative to the connected folder; two cds keep "$HOME" working.
    let cd = cdPart(base);
    if (args.cwd) {
      const sub = checkRel(args.cwd);
      cd += 'cd ' + Q(sub) + ' || { echo NOCD; exit 1; }; ';
    }
    const ms = Math.min(LIMITS.TIMEOUT_MAX_MS, Math.max(5000, Math.floor(Number(args.timeout_ms) || 120000)));
    const ssh = sshOf(ctx);
    const r = await ssh.sshRun(host, sh(cd + command), ms);
    const head = 'exit ' + r.code + (r.timedOut ? ' — killed after ' + Math.round(ms / 1000) + 's' : '') + '\n$ ' + command + '\n';
    const body = (!r.stdout && !r.stderr) ? '(no output)'
      : (r.stdout ? String(r.stdout).slice(0, LIMITS.OUTPUT_MAX) : '')
      + (r.stderr ? '\n[stderr]\n' + String(r.stderr).slice(0, LIMITS.OUTPUT_MAX) : '');
    return head + body;
  }
};

const HANDLERS = { ...READ_HANDLERS, ...WRITE_HANDLERS, ...GIT_HANDLERS };

async function run(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error('Unknown remote tool: ' + name);
  return handler(args, ctx);
}

module.exports = {
  run, HANDLERS, REMOTE_TOOLS, isRemoteable,
  checkRel, checkRelDir, cdPart, SKIP_DIRS
};

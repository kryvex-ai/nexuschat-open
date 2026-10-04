'use strict';

/**
 * File tools — read, search and edit inside the workspace.
 *
 * Every handler receives validated arguments (src/shared/tools.js did that)
 * and a context carrying the workspace root; every one of them resolves its
 * paths through tools/paths.js, which refuses anything outside the root. A
 * handler returns a string for the model or throws an Error whose message is
 * safe to show the user and to hand back to the model.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { resolvePath } = require('./paths');
const { LIMITS } = require('../../shared/tools');

/** Directories that are never worth walking into: enormous, generated or
 *  managed by another tool. They are skipped silently — a search that misses
 *  node_modules is not a bug, and walking it would hang the app. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.idea',
  '.vscode', '.mypy_cache', '.pytest_cache', '.tox'
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.tar', '.bz2', '.xz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.wav', '.mp4', '.mov',
  '.avi', '.webm', '.wasm', '.node', '.class', '.jar', '.pyc', '.db', '.sqlite'
]);

const MAX_READ_BYTES = 400000;
const MAX_WALK_ENTRIES = 20000;
const MAX_LIST_ENTRIES = 2000;

function fail(msg) {
  throw new Error(msg);
}

function pathIn(root, p, opts) {
  const r = resolvePath(root, p, opts);
  if (!r.ok) fail(r.error);
  return r;
}

function looksBinary(abs, buf) {
  if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return true;
  if (!buf) return false;
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function readTextFile(abs, maxBytes) {
  const cap = Math.min(Number(maxBytes) || MAX_READ_BYTES, MAX_READ_BYTES);
  const stat = await fsp.stat(abs);
  if (stat.size > cap) {
    fail(`${path.basename(abs)} is ${formatSize(stat.size)}, larger than the ${formatSize(cap)} limit — read it with start_line/end_line instead.`);
  }
  const buf = await fsp.readFile(abs);
  if (looksBinary(abs, buf)) {
    fail(`${path.basename(abs)} looks like a binary file, so there is no text to read.`);
  }
  return { text: buf.toString('utf8'), bytes: buf.length, truncated: false };
}

/**
 * Split text into lines for display. A file that ends with a newline has no
 * extra blank line at the end — reporting one would put a phantom line number
 * in the model's hands.
 */
function splitLines(text) {
  return String(text).replace(/\n$/, '').split('\n');
}

/** Read a file and prefix each line with its number — models quote it back. */
function numbered(text, startLine = 1) {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => String(startLine + i).padStart(width, ' ') + '  ' + l).join('\n');
}

/**
 * Depth-limited walk yielding { abs, rel, stat } for files. Skips SKIP_DIRS and
 * stops at MAX_WALK_ENTRIES so a stray /proc-style tree cannot hang the app.
 */
async function* walk(root, { startRel = '', maxDepth = 8, filter = null } = {}) {
  const rootAbs = path.join(root, startRel);
  let seen = 0;
  const stack = [{ dir: rootAbs, rel: startRel, depth: 0 }];
  while (stack.length) {
    const { dir, rel, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return;
      const abs = path.join(dir, e.name);
      const relEntry = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= maxDepth) continue;
        stack.push({ dir: abs, rel: relEntry, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (filter && !filter(e.name)) continue;
      let stat = null;
      try { stat = await fsp.stat(abs); } catch { /* vanished mid-walk */ }
      yield { abs, rel: relEntry, stat };
    }
  }
}

/**
 * Line diff by longest common subsequence, bounded so two large files cannot
 * turn into a multi-second matrix build. Past the bound it degrades to a
 * whole-file replacement, which is honest about what it could not compute.
 */
function lineDiff(aLines, bLines, maxLines) {
  const cap = 1500;
  if (aLines.length > cap || bLines.length > cap) {
    return ['@@ -1,' + aLines.length + ' +1,' + bLines.length + ' @@',
      ...aLines.slice(0, 3).map(l => '-' + l),
      '… (files too large for a line diff)',
      ...bLines.slice(0, 3).map(l => '+' + l)];
  }
  const n = aLines.length, m = bLines.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = aLines[i] === bLines[j]
        ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const out = [`@@ -1,${n} +1,${m} @@`];
  let i = 0, j = 0, shown = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { i++; j++; continue; }
    if (shown >= maxLines) { out.push('… (diff truncated)'); break; }
    out.push('-' + aLines[i++]);
    out.push('+' + bLines[j++]);
    shown += 2;
  }
  while (i < n && shown < maxLines) out.push('-' + aLines[i++]), shown++;
  while (j < m && shown < maxLines) out.push('+' + bLines[j++]), shown++;
  return out;
}/* ---------------- read handlers ---------------- */

const HANDLERS = {
  async read_file(args, { root }) {
    const { abs, rel } = pathIn(root, args.path);
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) fail(`${rel} is a directory — use list_dir.`);
    const { text, bytes } = await readTextFile(abs, args.max_bytes);
    const all = splitLines(text);
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    const end = args.end_line ? Math.min(all.length, Math.floor(Number(args.end_line))) : all.length;
    if (start > all.length) fail(`${rel} has ${all.length} line(s); start_line ${start} is past the end.`);
    const slice = all.slice(start - 1, end);
    return `${rel} — ${all.length} line(s), ${formatSize(bytes)}\n` + numbered(slice.join('\n'), start);
  },

  async list_dir(args, { root }) {
    const { abs, rel } = args.path ? pathIn(root, args.path) : { abs: root, rel: '' };
    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) fail(`${rel || 'That path'} is a file, not a directory.`);
    const pattern = args.pattern ? String(args.pattern) : '';
    const lines = [];
    if (args.recursive) {
      const depth = Math.min(8, Math.max(1, Math.floor(Number(args.depth) || 2)));
      for await (const f of walk(root, { startRel: rel, maxDepth: depth, filter: n => !pattern || n.endsWith(pattern) })) {
        if (lines.length >= MAX_LIST_ENTRIES) { lines.push(`… (stopped at ${MAX_LIST_ENTRIES} entries)`); break; }
        lines.push(`file  ${String(f.stat ? f.stat.size : 0).padStart(9)}  ${f.rel}`);
      }
    } else {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (pattern && !e.name.endsWith(pattern)) continue;
        const child = path.join(abs, e.name);
        let size = '';
        if (e.isFile()) { try { size = String((await fsp.stat(child)).size); } catch { /* gone */ } }
        const kind = e.isDirectory() ? 'dir ' : e.isSymbolicLink() ? 'link' : 'file';
        lines.push(`${kind}  ${size.padStart(9)}  ${rel ? rel + '/' : ''}${e.name}`);
      }
    }
    if (!lines.length) return `${rel || 'Workspace'} is empty.`;
    return `${rel || 'Workspace root'} — ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}:\n` + lines.join('\n');
  },

  async search_files(args, { root }) {
    const query = String(args.query);
    const needle = query.toLowerCase();
    const include = args.include ? String(args.include) : '';
    const max = Math.min(500, Math.max(1, Math.floor(Number(args.max_results) || 100)));
    const startRel = args.path ? pathIn(root, args.path).rel : '';
    const hits = [];
    let files = 0;
    for await (const f of walk(root, { startRel, maxDepth: 10, filter: n => !include || n.endsWith(include) })) {
      if (f.stat && f.stat.size > 512000) continue;
      if (BINARY_EXT.has(path.extname(f.abs).toLowerCase())) continue;
      files++;
      let text;
      try { text = (await fsp.readFile(f.abs)).toString('utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= max) return `Stopped at ${max} hit(s) across ${files} file(s):\n` + hits.join('\n');
        }
      }
    }
    if (!hits.length) return `No match for “${query}” in ${files} file(s).`;
    return `${hits.length} hit(s) for “${query}” across ${files} file(s):\n` + hits.join('\n');
  },async grep_files(args, { root }) {
    const source = String(args.pattern);
    let re;
    try {
      re = new RegExp(source, args.ignore_case ? 'gi' : 'g');
    } catch (e) {
      fail('That is not a valid regular expression: ' + e.message);
    }
    const include = args.include ? String(args.include) : '';
    const max = Math.min(500, Math.max(1, Math.floor(Number(args.max_results) || 100)));
    const startRel = args.path ? pathIn(root, args.path).rel : '';
    const hits = [];
    let files = 0;
    for await (const f of walk(root, { startRel, maxDepth: 10, filter: n => !include || n.endsWith(include) })) {
      if (f.stat && f.stat.size > 512000) continue;
      if (BINARY_EXT.has(path.extname(f.abs).toLowerCase())) continue;
      files++;
      let text;
      try { text = (await fsp.readFile(f.abs)).toString('utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          hits.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= max) return `Stopped at ${max} match(es) across ${files} file(s):\n` + hits.join('\n');
        }
      }
    }
    if (!hits.length) return `No line matches /${source}/ in ${files} file(s).`;
    return `${hits.length} match(es) for /${source}/ across ${files} file(s):\n` + hits.join('\n');
  },

  async file_info(args, { root }) {
    const r = resolvePath(root, args.path);
    if (!r.ok) return `No: ${args.path} (${r.error})`;
    let stat;
    try { stat = await fsp.stat(r.abs); } catch { return `No: ${args.path} does not exist.`; }
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const lines = [`${r.rel}: exists: yes`, `type: ${kind}`, `size: ${formatSize(stat.size)}`, `modified: ${stat.mtime.toISOString()}`];
    if (kind === 'file' && stat.size < 200000 && !BINARY_EXT.has(path.extname(r.abs).toLowerCase())) {
      try {
        const text = (await fsp.readFile(r.abs)).toString('utf8');
        lines.push('lines: ' + splitLines(text).length);
      } catch { /* unreadable */ }
    }
    return lines.join('\n');
  },

  async diff_files(args, { root }) {
    const a = pathIn(root, args.path);
    const b = pathIn(root, args.other_path);
    const [ta, tb] = await Promise.all([readTextFile(a.abs), readTextFile(b.abs)]);
    const maxLines = Math.min(2000, Math.max(20, Math.floor(Number(args.max_lines) || 400)));
    return `--- ${a.rel}\n+++ ${b.rel}\n` + lineDiff(ta.text.split('\n'), tb.text.split('\n'), maxLines).join('\n');
  },/* ---------------- writes ---------------- */

  async write_file(args, { root }) {
    const { abs, rel } = pathIn(root, args.path, { forWrite: true });
    let existed = false;
    try { existed = (await fsp.stat(abs)).isFile(); } catch { /* new file */ }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const content = String(args.content);
    await fsp.writeFile(abs, content, 'utf8');
    return `${existed ? 'Replaced' : 'Created'} ${rel} (${formatSize(Buffer.byteLength(content))}, ${content.split('\n').length} lines).`;
  },

  async edit_file(args, { root }) {
    return applyEdits(args.path, [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }], root).message;
  },

  async multi_edit(args, { root }) {
    return applyEdits(args.path, args.edits || [], root).message;
  },

  async append_file(args, { root }) {
    const { abs, rel } = pathIn(root, args.path, { forWrite: true });
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const content = String(args.content);
    await fsp.appendFile(abs, content, 'utf8');
    return `Appended ${formatSize(Buffer.byteLength(content))} to ${rel}.`;
  },

  async create_dir(args, { root }) {
    const { abs, rel } = pathIn(root, args.path, { forWrite: true });
    let existed = false;
    try { existed = (await fsp.stat(abs)).isDirectory(); } catch { /* new */ }
    await fsp.mkdir(abs, { recursive: true });
    return existed ? `${rel} already exists.` : `Created ${rel}/.`;
  },

  async move_file(args, { root }) {
    const from = pathIn(root, args.path, { forWrite: true });
    const to = pathIn(root, args.to, { forWrite: true });
    if (to.rel === from.rel || to.rel.startsWith(from.rel + '/')) fail('A directory cannot be moved inside itself.');
    if (fs.existsSync(to.abs)) fail(`${to.rel} already exists — remove it or pick another name.`);
    if (!fs.existsSync(from.abs)) fail(`${from.rel} does not exist.`);
    await fsp.mkdir(path.dirname(to.abs), { recursive: true });
    try {
      await fsp.rename(from.abs, to.abs);
    } catch {
      // Different filesystem: copy then remove.
      await fsp.cp(from.abs, to.abs, { recursive: true });
      await fsp.rm(from.abs, { recursive: true, force: true });
    }
    return `Moved ${from.rel} → ${to.rel}.`;
  },

  async copy_file(args, { root }) {
    const from = pathIn(root, args.path);
    const to = pathIn(root, args.to, { forWrite: true });
    if (to.rel === from.rel || to.rel.startsWith(from.rel + '/')) fail('A directory cannot be copied inside itself.');
    if (!fs.existsSync(from.abs)) fail(`${from.rel} does not exist.`);
    if (fs.existsSync(to.abs)) fail(`${to.rel} already exists.`);
    await fsp.mkdir(path.dirname(to.abs), { recursive: true });
    await fsp.cp(from.abs, to.abs, { recursive: true });
    return `Copied ${from.rel} → ${to.rel}.`;
  },

  async delete_file(args, { root }) {
    const { abs, rel } = pathIn(root, args.path, { forWrite: true });
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return `${rel} was already gone.`;
    if (stat.isDirectory()) {
      if (args.recursive !== true) fail(`${rel} is a directory — pass "recursive": true to delete the whole tree.`);
      await fsp.rm(abs, { recursive: true, force: false });
      return `Deleted the directory ${rel} and everything in it.`;
    }
    await fsp.unlink(abs);
    return `Deleted ${rel}.`;
  }
};

/**
 * Shared by edit_file and multi_edit. Every replacement is applied to an
 * in-memory copy and the file is written once at the end, so a mistake halfway
 * through a batch leaves the file exactly as it was.
 */
function applyEdits(p, edits, root) {
  const { abs, rel } = pathIn(root, p, { forWrite: true });
  if (!fs.existsSync(abs)) fail(`${rel} does not exist — read it before editing.`);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { fail(`${rel} could not be read as text.`); }
  let applied = 0;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const needle = String(e.old_string);
    const replacement = String(e.new_string);
    if (!needle) fail(`Edit ${i + 1} has no old_string.`);
    const first = text.indexOf(needle);
    if (first === -1) fail(`Edit ${i + 1}: that text is not in ${rel} any more — read the file again and match what is there.`);
    if (e.replace_all === true) {
      const parts = text.split(needle);
      applied += parts.length - 1;
      text = parts.join(replacement);
      continue;
    }
    if (text.indexOf(needle, first + needle.length) !== -1) {
      fail(`Edit ${i + 1}: that text appears more than once in ${rel}. Include more surrounding lines, or set "replace_all": true.`);
    }
    text = text.slice(0, first) + replacement + text.slice(first + needle.length);
    applied++;
  }
  fs.writeFileSync(abs, text, 'utf8');
  return { message: `Applied ${applied} edit${applied === 1 ? '' : 's'} to ${rel}.`, abs, rel };
}

async function run(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error('Unknown file tool: ' + name);
  return handler(args, ctx);
}

module.exports = { run, HANDLERS, applyEdits, walk, readTextFile, lineDiff, SKIP_DIRS };
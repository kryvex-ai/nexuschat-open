'use strict';

/**
 * The executors: files inside the workspace, and the shell/git/network tools.
 * The interesting cases here are the refusals — a path that tries to leave the
 * workspace, a git option that could run code, a command that never ends.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const fsTools = require('../src/main/tools/fs');
const shellTools = require('../src/main/tools/shell');
const { resolvePath } = require('../src/main/tools/paths');

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function workspace() {
  const root = tmpDir('agent-fs-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\nhello world\nsecond line\n');
  fs.writeFileSync(path.join(root, 'src/app.js'), 'const a = 1;\nconst b = 2;\nfunction go() { return a + b; }\n');
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  return root;
}

const call = (name, args, root) => fsTools.run(name, args, { root });
const shell = (name, args, root) => shellTools.run(name, args, { root });
const rejected = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e.message);
  }
};

/* ---------------- confinement ---------------- */

test('resolvePath: nothing outside the workspace resolves', () => {
  const root = workspace();
  assert.equal(resolvePath(root, 'src/app.js').ok, true);
  assert.equal(resolvePath(root, '../escape.txt').ok, false);
  assert.equal(resolvePath(root, '../../etc/passwd').ok, false);
  assert.equal(resolvePath(root, '/etc/hostname').ok, false);
  assert.equal(resolvePath(root, '').ok, false, 'the root itself is not a target');
  // a link pointing out of the tree cannot be used as a tunnel
  fs.symlinkSync('/etc', path.join(root, 'out'));
  const viaLink = resolvePath(root, 'out/hostname');
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.error, /outside the workspace/);
});

test('resolvePath: writes into .git internals are refused, reads are fine', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/config'), '[core]\n');
  assert.equal(resolvePath(root, '.git/config').ok, true, 'reading it is harmless');
  const write = resolvePath(root, '.git/config', { forWrite: true });
  assert.equal(write.ok, false);
  assert.match(write.error, /git tools/);
});

test('a missing workspace is an error, not a crash', async () => {
  const msg = await rejected(() => call('read_file', { path: 'a.txt' }, '/definitely/not/here'));
  assert.match(msg, /workspace/i);
});

/* ---------------- reading ---------------- */

test('read_file: numbered text, line ranges, and honest refusals', async () => {
  const root = workspace();
  const whole = await call('read_file', { path: 'src/app.js' }, root);
  assert.match(whole, /1 {2}const a = 1;/, 'lines are numbered');
  assert.match(whole, /3 line\(s\)/);
  const ranged = await call('read_file', { path: 'README.md', start_line: 2, end_line: 3 }, root);
  assert.match(ranged, /2 {2}hello world/);
  assert.match(ranged, /3 {2}second line/, 'end_line is inclusive');
  assert.ok(!ranged.includes('# Demo'), 'start_line is honoured');
  assert.match(await rejected(() => call('read_file', { path: 'src' }, root)), /directory/);
  assert.match(await rejected(() => call('read_file', { path: 'nope.js' }, root)), /ENOENT|no such file/i);
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  assert.match(await rejected(() => call('read_file', { path: 'blob.bin' }, root)), /binary/);
});

test('list_dir: recursive walks files and skips generated directories', async () => {
  const root = workspace();
  const flat = await call('list_dir', {}, root);
  assert.match(flat, /README\.md/);
  assert.match(flat, /src/);
  assert.match(flat, /node_modules/);
  const deep = await call('list_dir', { recursive: true, depth: 3 }, root);
  assert.match(deep, /src\/app\.js/);
  assert.ok(!deep.includes('node_modules'), 'node_modules is never walked');
  const filtered = await call('list_dir', { recursive: true, pattern: '.js' }, root);
  assert.match(filtered, /src\/app\.js/);
  assert.ok(!filtered.includes('README.md'));
});

test('search_files and grep_files find, filter and stop at their cap', async () => {
  const root = workspace();
  const hits = await call('search_files', { query: 'function' }, root);
  assert.match(hits, /src\/app\.js:3:/);
  assert.ok(!hits.includes('node_modules'));
  assert.match(await call('search_files', { query: 'nothing-here-at-all' }, root), /No match/);
  assert.match(await call('search_files', { query: 'const', include: '.js' }, root), /src\/app\.js/);
  const capped = await call('search_files', { query: 'const', max_results: 1 }, root);
  assert.match(capped, /Stopped at 1 hit/);
  const grepped = await call('grep_files', { pattern: 'const [ab]' }, root);
  assert.match(grepped, /src\/app\.js:1/);
  assert.match(await rejected(() => call('grep_files', { pattern: 'const [' }, root)), /not a valid regular expression/);
});

test('file_info and diff_files describe without touching anything', async () => {
  const root = workspace();
  const info = await call('file_info', { path: 'README.md' }, root);
  assert.match(info, /exists: yes/);
  assert.match(info, /lines: 3/, 'a trailing newline is not a phantom line');
  assert.match(await call('file_info', { path: 'ghost.txt' }, root), /does not exist/);
  const diff = await call('diff_files', { path: 'README.md', other_path: 'src/app.js' }, root);
  assert.match(diff, /^--- README\.md/m);
  assert.match(diff, /\+const a = 1;/);
  assert.match(diff, /-hello world/);
});/* ---------------- writing ---------------- */

test('write_file creates parents, reports overwrites, and stays inside the workspace', async () => {
  const root = workspace();
  const made = await call('write_file', { path: 'docs/deep/note.md', content: 'a\nb\n' }, root);
  assert.match(made, /Created docs\/deep\/note\.md/);
  const again = await call('write_file', { path: 'docs/deep/note.md', content: 'c\n' }, root);
  assert.match(again, /Replaced/);
  assert.equal(fs.readFileSync(path.join(root, 'docs/deep/note.md'), 'utf8'), 'c\n');
  assert.match(await rejected(() => call('write_file', { path: '../escape.md', content: 'x' }, root)), /outside the workspace/);
});

test('edit_file needs an exact match, and says so when the text moved', async () => {
  const root = workspace();
  const ok = await call('edit_file', { path: 'src/app.js', old_string: 'const b = 2;', new_string: 'const b = 42;' }, root);
  assert.match(ok, /Applied 1 edit/);
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /const b = 42;/);
  const gone = await rejected(() => call('edit_file', { path: 'src/app.js', old_string: 'const b = 2;', new_string: 'x' }, root));
  assert.match(gone, /not in src\/app\.js any more/);
  assert.match(await rejected(() => call('edit_file', { path: 'ghost.js', old_string: 'a', new_string: 'b' }, root)), /does not exist/);
});

test('edit_file refuses an ambiguous match unless replace_all says otherwise', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'dup.txt'), 'x\nx\n');
  const ambiguous = await rejected(() => call('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' }, root));
  assert.match(ambiguous, /more than once/);
  assert.equal(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8'), 'x\nx\n', 'nothing changed');
  const all = await call('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true }, root);
  assert.match(all, /Applied 2 edits/);
  assert.equal(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8'), 'y\ny\n');
});

test('multi_edit is all-or-nothing: a bad batch leaves the file exactly as it was', async () => {
  const root = workspace();
  const good = await call('multi_edit', {
    path: 'src/app.js',
    edits: [{ old_string: 'const a = 1;', new_string: 'const a = 7;' }, { old_string: 'const b = 2;', new_string: 'const b = 8;' }]
  }, root);
  assert.match(good, /Applied 2 edits/);
  const before = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const bad = await rejected(() => call('multi_edit', {
    path: 'src/app.js',
    edits: [{ old_string: 'const a = 7;', new_string: 'const a = 9;' }, { old_string: 'never appears', new_string: 'x' }]
  }, root));
  assert.match(bad, /not in src\/app\.js/);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), before, 'the first edit rolled back too');
});

test('move, copy and delete behave like a careful person would', async () => {
  const root = workspace();
  assert.match(await call('copy_file', { path: 'src/app.js', to: 'src/app.copy.js' }, root), /Copied/);
  assert.match(await rejected(() => call('copy_file', { path: 'src/app.js', to: 'src/app.copy.js' }, root)), /already exists/);
  assert.match(await call('move_file', { path: 'src/app.copy.js', to: 'src/moved.js' }, root), /Moved/);
  assert.match(await rejected(() => call('move_file', { path: 'src', to: 'src/inside' }, root)), /inside itself/);
  assert.match(await rejected(() => call('delete_file', { path: 'src' }, root)), /recursive/);
  assert.match(await call('delete_file', { path: 'src/moved.js' }, root), /Deleted/);
  assert.match(await call('delete_file', { path: 'src/moved.js' }, root), /already gone/);
});/* ---------------- git, shell, network ---------------- */

test('git arguments that could execute code are refused', () => {
  for (const bad of ['-c', '-cfoo=bar', '--upload-pack=touch /tmp/pwned', '--exec-path=/tmp', '--ext-diff', '--output=/tmp/x', '--git-dir=/tmp', '--textconv=sh']) {
    assert.throws(() => shellTools.assertSafeGitArgs([bad]), /git|run code/i, 'should refuse ' + bad);
  }
  assert.doesNotThrow(() => shellTools.assertSafeGitArgs(['--staged', '--', 'src/app.js']));
  assert.throws(() => shellTools.assertSafeGitArgs(['bad\narg']), /single-line/);
});

test('git tools work on a real repository', async () => {
  const root = workspace();
  const author = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@e' };
  const run = (cmd) => shellTools.runProcess(['git', ...cmd], { cwd: root, env: author });
  await run(['init', '-q', '-b', 'main']);
  assert.match(await shell('git_status', {}, root), /main|no commits/i);
  await run(['add', '.']);
  assert.match(await shell('git_commit', { message: 'first' }, root), /Committed [0-9a-f]+/);
  assert.match(await shell('git_log', {}, root), /first/);
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo changed\n');
  assert.match(await shell('git_diff', {}, root), /\+# Demo changed/);
  assert.match(await shell('git_branch', { action: 'create', name: 'feature' }, root), /Created branch feature/);
  assert.match(await shell('git_branch', { action: 'switch', name: 'feature' }, root), /Switched to feature/);
  assert.match(await shell('git_stage', { paths: ['README.md'] }, root), /Staged/);
});

test('git tools refuse to work outside a repository', async () => {
  const root = workspace();
  assert.match(await rejected(() => shell('git_status', {}, root)), /not inside a git repository/);
});

test('run_command: runs in the workspace, reports the exit code, and is killed on timeout', async () => {
  const root = workspace();
  const ok = await shell('run_command', { command: 'echo hello' }, root);
  assert.match(ok, /exit 0/);
  assert.match(ok, /hello/);
  assert.match(await shell('run_command', { command: 'exit 3' }, root), /exit 3/);
  const killed = await shell('run_command', { command: 'sleep 5', timeout_ms: 300 }, root);
  assert.match(killed, /killed after/);
  assert.match(await rejected(() => shell('run_command', { command: 'echo hi', cwd: '../..' }, root)), /outside the workspace/);
  assert.match(await rejected(() => shell('run_command', { command: '' }, root)), /empty command/);
});

test('http_fetch only speaks http(s), and says what came back', async () => {
  const root = workspace();
  assert.match(await rejected(() => shell('http_fetch', { url: 'file:///etc/passwd' }, root)), /http and https/);
  assert.match(await rejected(() => shell('http_fetch', { url: 'not a url' }, root)), /not a valid URL/);
  assert.match(await rejected(() => shell('http_fetch', { url: 'http://127.0.0.1:1/', method: 'TRACE' }, root)), /Unsupported HTTP method/);
  // An unreachable host is a failed result, not a crash
  assert.match(await rejected(() => shell('http_fetch', { url: 'http://127.0.0.1:1/nothing' }, root)), /Request failed/);
});

/* ---------------- git paths stay inside the workspace ---------------- */

test('git tools stage the workspace copy, never the repository-root one', async () => {
  // The realistic shape: the user picks repo/src as the workspace, and BOTH
  // repo/secrets.env.js and repo/src/secrets.env.js exist. git resolves a bare
  // pathspec from the REPOSITORY root, so passing the model's path straight
  // through would stage the file outside the workspace — the wrong file,
  // silently, for a tool the user approved.
  const repo = tmpDir('audit-git-');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'secrets.env.js'), "API_KEY = 'sk-live'\n");
  fs.writeFileSync(path.join(repo, 'src', 'secrets.env.js'), "API_KEY = 'local-copy'\n");
  await shellTools.runProcess(['git', 'init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env } });
  const handlers = shellTools.HANDLERS;
  const ctx = { root: path.join(repo, 'src') };

  const staged = await handlers.git_stage({ paths: ['secrets.env.js'] }, ctx);
  assert.match(staged, /Staged: /);
  assert.equal(execFileSyncSafe(repo), 'src/secrets.env.js', 'the workspace copy is what got staged');

  // Climbing out is refused outright.
  const escape = await rejected(() => handlers.git_stage({ paths: ['../secrets.env.js'] }, ctx));
  assert.match(escape, /outside the workspace/);
  const escapeDiff = await rejected(() => handlers.git_diff({ path: '../secrets.env.js' }, ctx));
  assert.match(escapeDiff, /outside the workspace/);
  const escapeLog = await rejected(() => handlers.git_log({ path: '../secrets.env.js' }, ctx));
  assert.match(escapeLog, /outside the workspace/);
});

function execFileSyncSafe(repo) {
  try {
    return require('node:child_process').execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return '(error)';
  }
}
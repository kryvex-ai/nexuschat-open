'use strict';

/**
 * Release guards for user-visible copy and renderer wiring.
 *
 * These are the cheap, high-value checks that catch the class of bug that
 * prompted this pass: stale product names, dead DOM references, style classes
 * with no CSS, broken `nexus.*` bridges and version drift.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appJs = read('src/renderer/app.js');
const indexHtml = read('src/renderer/index.html');
const themeCss = read('src/renderer/theme.css');
const preloadJs = read('src/preload.js');
const ipcJs = read('src/main/ipc.js');
const providersJs = read('src/main/providers/index.js');

/** ids created at runtime by the renderer (not present in index.html). */
const RUNTIME_IDS = new Set(['chips', 'emptySub', 'emptyTitle']);

const htmlIds = new Set([...indexHtml.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const appRefs = new Set([
  ...[...appJs.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)].map(m => m[1]),
  ...[...appJs.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)].map(m => m[1])
]);

/* ---------------- DOM wiring ---------------- */

test('every element app.js looks up exists in index.html', () => {
  const missing = [...appRefs].filter(id => !htmlIds.has(id) && !RUNTIME_IDS.has(id)).sort();
  assert.deepEqual(missing, [], 'dead DOM lookups: ' + missing.join(', '));
  assert.ok(appRefs.size > 50, 'sanity: the renderer was actually parsed');
});

test('every <label for=…> points at a real control', () => {
  const broken = [...indexHtml.matchAll(/<label[^>]*\bfor="([A-Za-z0-9_-]+)"/g)]
    .map(m => m[1])
    .filter(id => !htmlIds.has(id));
  assert.deepEqual(broken, [], 'labels pointing at nothing: ' + broken.join(', '));
});

test('every tab has a view, and every view has a tab', () => {
  const tabs = [...indexHtml.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.ok(tabs.length >= 5);
  for (const t of tabs) assert.ok(htmlIds.has('view-' + t), 'tab "' + t + '" has no view');
  const views = [...htmlIds].filter(id => id.startsWith('view-')).map(id => id.slice(5));
  for (const v of views) assert.ok(tabs.includes(v), 'view "' + v + '" is unreachable');
});

test('interactive elements have accessible names or labels', () => {
  const named = (tag) => /aria-label="[^"]+"|placeholder="[^"]+"|aria-labelledby=/.test(tag);
  for (const id of ['skillSearch', 'providerSearch', 'botSearch']) {
    const m = indexHtml.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
    assert.ok(m, 'missing #' + id);
    const label = new RegExp('for="' + id + '"').test(indexHtml);
    assert.ok(named(m[0]) || label, '#' + id + ' has no accessible name');
  }
  // Buttons may be named by their own text content.
  for (const id of ['resetSettingsBtn', 'refreshModelsBtn', 'newChatBtn']) {
    const m = indexHtml.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</button>'));
    assert.ok(m, 'missing #' + id);
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 1 || named(m[0]), '#' + id + ' has no accessible name');
  }
});

/* ---------------- copy ---------------- */

test('no stale product names in user-facing copy', () => {
  const stale = [
    ['Grok cloud', 'the cloud provider was renamed to "Cloud"'],
    ['Hermes (local)', 'the local runtime was renamed to "Offline"'],
    ['Nexus Chat', 'brand is written "NexusChat"']
  ];
  const sources = { 'src/renderer/app.js': appJs, 'src/renderer/index.html': indexHtml, 'src/main/ipc.js': ipcJs, 'src/main/providers/index.js': providersJs };
  const hits = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const [phrase, why] of stale) {
      if (text.includes(phrase)) hits.push(file + ': "' + phrase + '" (' + why + ')');
    }
  }
  assert.deepEqual(hits, [], hits.join('; '));
});

test('visible text has no doubled spaces or placeholder filler', () => {
  const offenders = [];
  for (const m of indexHtml.matchAll(/>([^<>]+)</g)) {
    const t = m[1];
    if (!t.trim()) continue;
    if (/\S {2,}\S/.test(t)) offenders.push(JSON.stringify(t.trim()));
  }
  assert.deepEqual(offenders, [], 'doubled spaces: ' + offenders.join(', '));
  assert.ok(!/lorem ipsum|\bTODO\b|\bFIXME\b/.test(indexHtml), 'no filler left in the markup');
});

test('the version in package.json is a release semver', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'semver, got ' + pkg.version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version, 'lockfile version must not drift');
  assert.equal(lock.packages[''].version, pkg.version, 'lockfile root must not drift');
});

/* ---------------- bridge + styles ---------------- */

test('every nexus.* call is exposed by the preload bridge', () => {
  const exposed = new Set([...preloadJs.matchAll(/^\s{2}([A-Za-z_$][\w$]*)[,:]/gm)].map(m => m[1]));
  const calls = [...new Set([...appJs.matchAll(/\bnexus\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
  assert.ok(calls.length > 20, 'sanity: the renderer talks to main');
  const missing = calls.filter(c => !exposed.has(c)).sort();
  assert.deepEqual(missing, [], 'not exposed in preload: ' + missing.join(', '));
});

test('every skill/plugin style class used by the UI has CSS', () => {
  // Derived from the code itself, so new markup can't ship unstyled.
  const used = new Set();
  for (const src of [appJs, indexHtml]) {
    for (const m of src.matchAll(/['"]((?:skill|plugin)-[a-z-]+)['"]/g)) used.add(m[1]);
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^(skill|plugin)-/.test(c)) used.add(c);
    }
  }
  assert.ok(used.size >= 6, 'sanity: found skill/plugin classes (' + used.size + ')');
  const unstyled = [...used].filter(c => !themeCss.includes('.' + c)).sort();
  assert.deepEqual(unstyled, [], 'no CSS for: ' + unstyled.join(', '));
  // The saved-feedback pill is shared by both settings sections.
  assert.ok(themeCss.includes('.save-pill'), '.save-pill must be styled');
  assert.ok(indexHtml.includes('class="save-pill"'), 'save pills use the styled class');
});

test('the plain page views own their scrolling', () => {
  // body is overflow: hidden, so a page view without its own scroller clips
  // its content at the window edge — which is how the whole Assistant panel
  // became unreachable on a short window.
  assert.match(themeCss, /#view-settings\.active, #view-providers\.active \{ overflow-y: auto; \}/,
    'settings and providers scroll themselves');
  assert.match(themeCss, /#view-skills\.active[^}]*overflow-y: auto/, 'skills already did; keep it that way');
});

test('index.html has no stray whitespace and links the shipped stylesheet', () => {
  const trailing = indexHtml.split('\n')
    .map((line, i) => (/[ \t]+$/.test(line) ? i + 1 : 0))
    .filter(Boolean);
  assert.deepEqual(trailing, [], 'trailing whitespace on lines: ' + trailing.join(', '));
  assert.ok(indexHtml.includes('href="theme.css"'), 'the stylesheet link survives restructuring');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/renderer/theme.css')), 'theme.css is shipped');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/renderer/styles.css')), 'no dead stylesheet');
});

test('theme fallback matches the shipped default (dark)', () => {
  const body = appJs.match(/function applyTheme\(theme\)\s*\{[\s\S]*?\n\}/);
  assert.ok(body, 'applyTheme missing');
  assert.match(body[0], /theme === 'light' \? 'light' : 'dark'/, 'unknown values must not flip the UI to light');
  const defaults = read('src/main/store.js').match(/theme:\s*'(\w+)'/);
  assert.equal(defaults && defaults[1], 'dark', 'dark stays the default theme');
  assert.match(appJs, /\$\('#themeSelect'\)\.value = state\.settings\.theme \|\| 'dark'/);
});

test('the renderer never interpolates data into innerHTML', () => {
  // quote-aware scan: capture each innerHTML assignment RHS in full
  const bad = [];
  const re = /innerHTML\s*=\s*/g;
  let m;
  while ((m = re.exec(appJs))) {
    let i = m.index + m[0].length;
    let out = '';
    let quote = null;
    for (; i < appJs.length; i++) {
      const ch = appJs[i];
      if (quote) {
        if (ch === '\\') { out += appJs[i + 1]; i++; continue; }
        if (ch === quote) quote = null;
        out += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
      if (ch === ';') break;
      out += ch;
    }
    if (/\$\{/.test(out)) bad.push('template interpolation: ' + out.trim().slice(0, 60));
    else if (/['"`]\s*\+\s*[A-Za-z_$]/.test(out)) bad.push('string concat: ' + out.trim().slice(0, 60));
    else if (!/^['"`]|^\s*[A-Za-z_$]+\s*\?/.test(out.trim())) bad.push('non-literal: ' + out.trim().slice(0, 60));
  }
  assert.deepEqual(bad, [], 'unsafe HTML writes: ' + bad.join(' | '));
});

test('the live stream bubble survives the mid-stream repaint', () => {
  // chat:send returns as soon as generation starts, and sendMessage repaints
  // the pane while the reply is still streaming. That repaint used to detach
  // the streaming bubble, so every delta painted off-screen and the reply
  // popped in whole at chat:done — the exact bug the live check also covers.
  const ensure = appJs.match(/function ensureStreamBubble\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(ensure, 'ensureStreamBubble missing');
  assert.match(ensure[0], /isConnected/, 'the bubble must be reattached after renderMessages rebuilds the pane');
  const delta = appJs.match(/function onChatDelta\(payload\)\s*\{[\s\S]*?\n\}/);
  assert.ok(delta, 'onChatDelta missing');
  assert.match(delta[0], /conversationId !== currentConvId/,
    'deltas must never paint into a chat the user switched to');
});

test('a source-run update check points at the releases page', () => {
  const body = appJs.match(/async function checkForUpdates\(atLaunch\)\s*\{[\s\S]*?\n\}/);
  assert.ok(body, 'checkForUpdates missing');
  assert.match(body[0], /info\.skipped[\s\S]*updateOpenRelease/,
    'the pill in a source checkout must lead to the releases page, not a dead end');
});

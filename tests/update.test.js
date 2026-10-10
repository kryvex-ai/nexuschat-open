'use strict';

/**
 * Update safety: what the app is willing to install. Every rule the main
 * process relies on is asserted here against a GitHub-shaped payload, plus
 * the wiring on all four sides (shared logic, IPC, preload, renderer).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updates = require('../src/shared/updates');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SETUP = 'NexusChat-Open-Setup-1.1.0.exe';
const GOOD_ASSET = 'https://github.com/kryvex-ai/nexuschat-open/releases/download/v1.1.0/' + SETUP;
const GOOD_SUMS = 'https://github.com/kryvex-ai/nexuschat-open/releases/download/v1.1.0/SHA256SUMS.txt';

function release(over = {}) {
  return {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: false,
    assets: [
      { name: SETUP, browser_download_url: GOOD_ASSET, size: 41234567 },
      { name: 'NexusChat-Open-Portable-1.1.0.exe', browser_download_url: GOOD_ASSET.replace('Setup', 'Portable'), size: 40000000 },
      { name: 'SHA256SUMS.txt', browser_download_url: GOOD_SUMS, size: 300 }
    ],
    ...over
  };
}

/* ---------------- version parsing and ordering ---------------- */

test('rateLimitWaitMs reads retry-after, reset, or nothing', () => {
  assert.equal(updates.rateLimitWaitMs(() => '120'), 120000, 'seconds become ms');
  assert.equal(updates.rateLimitWaitMs(() => null), null, 'no headers, no wait');
  assert.equal(updates.rateLimitWaitMs(() => 'junk'), null, 'garbage is not a time');
  assert.equal(updates.rateLimitWaitMs(), null, 'no reader, no wait');
  const reset = Math.floor(Date.now() / 1000) + 60;
  const wait = updates.rateLimitWaitMs((n) => n === 'x-ratelimit-reset' ? String(reset) : null);
  assert.ok(wait > 30000 && wait <= 60000, 'about a minute, got ' + wait);
  const past = updates.rateLimitWaitMs((n) => n === 'x-ratelimit-reset' ? String(Math.floor(Date.now() / 1000) - 10) : null);
  assert.equal(past, 0, 'a passed reset means no wait');
});

test('parseTag accepts stable versions and refuses everything else', () => {
  assert.deepEqual(updates.parseTag('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(updates.parseTag('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.equal(updates.parseTag('v1.2'), null, 'incomplete tag');
  assert.equal(updates.parseTag('v1.2.3-beta'), null, 'prerelease tag');
  assert.equal(updates.parseTag('latest'), null, 'non-version tag');
  assert.equal(updates.parseTag(''), null);
  assert.equal(updates.parseTag(null), null);
});

test('compareVersions orders releases and puts garbage last', () => {
  assert.equal(updates.compareVersions('v1.10.0', 'v1.9.9'), 1, 'semver, not string order');
  assert.equal(updates.compareVersions('1.1.0', 'v1.1.0'), 0);
  assert.equal(updates.compareVersions('1.0.9', '1.1.0'), -1);
  assert.equal(updates.compareVersions('v2.0.0', 'not-a-version'), 1, 'unparseable sorts lowest');
});

/* ---------------- the decision ---------------- */

test('selectUpdate offers a newer stable release with official assets only', () => {
  const res = updates.selectUpdate(release(), '1.0.0');
  assert.equal(res.updateAvailable, true);
  assert.equal(res.current, '1.0.0');
  assert.equal(res.latest, '1.1.0');
  assert.equal(res.asset.name, SETUP, 'the setup exe, never the portable build');
  assert.equal(res.asset.size, 41234567);
  assert.equal(res.checksums.url, GOOD_SUMS, 'the release carries its checksums');
});

test('selectUpdate stays quiet when there is nothing safe to install', () => {
  const cases = [
    [release(), '1.1.0', 'up-to-date', 'same version'],
    [release(), '1.2.0', 'up-to-date', 'running newer than the release'],
    [release({ prerelease: true }), '1.0.0', 'not-stable', 'prerelease'],
    [release({ draft: true }), '1.0.0', 'not-stable', 'draft'],
    [release({ tag_name: 'nightly' }), '1.0.0', 'bad-tag', 'unparseable tag'],
    [release({ assets: [] }), '1.0.0', 'no-safe-asset', 'no assets'],
    [{}, '1.0.0', 'bad-tag', 'empty payload']
  ];
  for (const [payload, current, reason, why] of cases) {
    const res = updates.selectUpdate(payload, current);
    assert.equal(res.updateAvailable, false, why);
    assert.equal(res.reason, reason, why);
  }
  assert.equal(updates.selectUpdate(release(), 'nonsense').reason, 'bad-current');
});

test('selectUpdate rejects an asset hosted anywhere but this repository', () => {
  const evil = release();
  evil.assets[0] = { name: SETUP, browser_download_url: 'https://evil.example/' + SETUP, size: 1 };
  const res = updates.selectUpdate(evil, '1.0.0');
  assert.equal(res.updateAvailable, false, 'off-site setup exe');
  assert.equal(res.reason, 'no-safe-asset');

  const downgraded = release();
  downgraded.assets[0].browser_download_url = 'http://github.com/kryvex-ai/nexuschat-open/releases/download/v1.1.0/' + SETUP;
  assert.equal(updates.selectUpdate(downgraded, '1.0.0').updateAvailable, false, 'plain http');
});

test('a release without usable checksums can be seen but never installed', () => {
  const res = updates.selectUpdate(release({ assets: release().assets.filter(a => a.name !== 'SHA256SUMS.txt') }), '1.0.0');
  assert.equal(res.updateAvailable, true, 'the pill may still advertise it');
  assert.equal(res.checksums, null, 'but install will refuse: no checksum to verify against');
});

test('isOfficialUrl only ever names this repository over https', () => {
  assert.equal(updates.isOfficialUrl(GOOD_ASSET), true);
  assert.equal(updates.isOfficialUrl(updates.RELEASES_PAGE), true);
  assert.equal(updates.isOfficialUrl('https://github.com/kryvex-ai/other/releases/latest'), false);
  assert.equal(updates.isOfficialUrl('https://evil.example/x'), false);
  assert.equal(updates.isOfficialUrl('http://github.com/kryvex-ai/nexuschat-open/releases/latest'), false);
  assert.equal(updates.isOfficialUrl(undefined), false);
});

test('a download redirect may only land on GitHub territory', () => {
  // Release assets 302 to a CDN: redirects must work, but only into GitHub's
  // own hosts — the final URL of every fetch is checked against this list.
  for (const h of ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) {
    assert.equal(updates.isOfficialDownloadHost(h), true, h);
  }
  for (const h of ['evil.com', 'github.com.evil.com', 'objects.githubusercontent.com.evil.com',
    'evil-githubusercontent.com', '', null, undefined]) {
    assert.equal(updates.isOfficialDownloadHost(h), false, String(h));
  }
});

test('the API endpoint is this repository, not a configurable one', () => {
  assert.equal(updates.RELEASES_API,
    'https://api.github.com/repos/kryvex-ai/nexuschat-open/releases/latest');
});

/* ---------------- checksums ---------------- */

test('parseChecksums reads sha256sum output, whatever the platform wrote', () => {
  const hash = 'a'.repeat(64);
  const other = 'B'.repeat(64);
  const map = updates.parseChecksums(`${hash}  NexusChat-Open-Setup-1.1.0.exe\r\n${other} *portable.exe\n\nnot a checksum\n`);
  assert.equal(map[SETUP], hash, 'CRLF line, lowercased');
  assert.equal(map['portable.exe'], other.toLowerCase(), 'binary-marker form');
  assert.equal(map['nothing.exe'], undefined);
  assert.deepEqual(updates.parseChecksums(''), Object.create(null));
  assert.deepEqual(updates.parseChecksums(null), Object.create(null));
});

test('matchesChecksum compares fully and only accepts real digests', () => {
  const a = '0123456789abcdef'.repeat(4);
  assert.equal(updates.matchesChecksum(a, a.toUpperCase()), true, 'hex case is not a difference');
  assert.equal(updates.matchesChecksum(a, a.slice(0, 63) + '0'), false);
  assert.equal(updates.matchesChecksum(a, ''), false);
  assert.equal(updates.matchesChecksum('short', 'short'), false, 'not a digest at all');
  assert.equal(updates.matchesChecksum(null, null), false);
});

/* ---------------- wiring on every side ---------------- */

test('the IPC channels exist and the preload exposes them', () => {
  const ipc = read('src/main/ipc.js');
  const preload = read('src/preload.js');
  for (const ch of ['update:check', 'update:install', 'update:release']) {
    assert.ok(ipc.includes("ipcMain.handle('" + ch + "'"), 'missing handler: ' + ch);
  }
  for (const fn of ['updateCheck', 'updateInstall', 'updateOpenRelease', 'onUpdateProgress']) {
    assert.ok(new RegExp('^\\s{2}' + fn + '[:,]', 'm').test(preload), 'not exposed: ' + fn);
  }
  assert.ok(ipc.includes("require('./updates')"), 'ipc uses the update service');
  const service = read('src/main/updates.js');
  assert.ok(service.includes("redirect: 'follow'") && service.includes('isOfficialDownloadHost'),
    'every fetch validates where a redirect landed before reading it');
});

test('a failed update check says why, not just "could not reach"', () => {
  const service = read('src/main/updates.js');
  assert.ok(service.includes("'rate-limited'"), '403/429 is named');
  assert.ok(service.includes("'no-releases'"), 'a 404 (nothing stable published) is named');
  assert.ok(service.includes('attempt === 0'), 'transport failures retry once; HTTP answers are final');
  const appJs = read('src/renderer/app.js');
  const body = appJs.match(/async function checkForUpdates\(atLaunch\)\s*\{[\s\S]*?\n\}/);
  assert.ok(body, 'checkForUpdates missing');
  assert.ok(body[0].includes('rate-limited') && body[0].includes('no-releases'), 'the pill reports the reason');
  assert.ok(body[0].includes('Could not reach GitHub'), 'the offline fallback survives');
});

test('the renderer owns the pill, the modal and a dismiss that persists', () => {
  const appJs = read('src/renderer/app.js');
  const html = read('src/renderer/index.html');
  for (const id of ['updatePill', 'updatePillText', 'updateModal', 'updateModalBody', 'updateInstallBtn', 'updateLaterBtn']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing element: #' + id);
  }
  assert.ok(appJs.includes("dismissedUpdate: updateInfo.latest"), 'Later remembers the version');
  assert.ok(appJs.includes("nexus.onUpdateProgress"), 'progress is wired');
  assert.ok(appJs.includes("checkForUpdates(true)"), 'the launch check runs');
  assert.ok(/helpIsOpen\(\)/.test(appJs), 'the nudge respects the guide overlay');
});

test('the store accepts a dismissed version and nothing else', () => {
  const { Store, PLAIN } = require('../src/main/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-upd-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const s = new Store(dir, PLAIN);
  assert.equal(s.updateSettings({ dismissedUpdate: '1.1.0' }).dismissedUpdate, '1.1.0');
  s.updateSettings({ dismissedUpdate: '1.2.0 <script>' });
  assert.equal(s.getSettings().dismissedUpdate, '1.1.0', 'junk cannot replace a real version');
  assert.equal(s.updateSettings({ dismissedUpdate: null }).dismissedUpdate, null, 'null clears it');
});

test('the release workflow publishes the checksums the app verifies against', () => {
  const wf = read('.github/workflows/release.yml');
  assert.ok(wf.includes('SHA256SUMS.txt'), 'the file is built');
  assert.ok(wf.includes('Get-FileHash'), 'from the real artifacts');
  assert.ok((wf.match(/dist\/SHA256SUMS\.txt/g) || []).length >= 2, 'attached to the artifact and the release');
  const main = read('src/main/updates.js');
  assert.ok(main.includes("reason: 'no-checksums'"), 'the installer refuses without a checksum');
  assert.ok(main.includes("throw new Error('checksum mismatch')") && main.includes('unlinkSync(file)'),
    'a failed verify deletes the file');
});

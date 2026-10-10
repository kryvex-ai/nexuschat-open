'use strict';

/**
 * Update service: checks the official GitHub release, and — after a native
 * confirmation — downloads the setup exe, verifies it against the release's
 * SHA256SUMS, and hands it to Windows.
 *
 * Safety rules, in order:
 *   - a check only ever reads api.github.com for this repository;
 *   - only a stable, newer tag with official assets counts (src/shared/updates.js);
 *   - the confirm dialog is native (main-owned), so the renderer cannot press
 *     "install" on its own;
 *   - the download is verified against the release checksum before anything
 *     executes — a failed check deletes the file;
 *   - the installer is spawned without a shell, and only on Windows builds
 *     that were actually installed (a source checkout has nothing to update).
 */

const { app, dialog, BrowserWindow, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const updates = require('../shared/updates');

const API_TIMEOUT_MS = 6000;

/**
 * Fetch that follows redirects (a release asset 302s to GitHub's CDN) but
 * then refuses to read a single byte unless the request ended on GitHub's
 * own hosts — an off-site landing is an attack, not an update.
 */
async function safeFetch(url, opts = {}) {
  const res = await fetch(url, { redirect: 'follow', ...opts });
  let finalUrl;
  try { finalUrl = new URL(res.url || url); } catch { throw new Error('bad response url'); }
  if (finalUrl.protocol !== 'https:' || !updates.isOfficialDownloadHost(finalUrl.hostname)) {
    throw new Error('redirected off the official host');
  }
  return res;
}

async function getJson(url) {
  let res;
  try {
    res = await safeFetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NexusChat-Open' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  } catch {
    // Nothing answered: offline, DNS, TLS, or the 6s timeout.
    throw Object.assign(new Error('offline'), { code: 'offline' });
  }
  if (res.status === 403 || res.status === 429) {
    const err = new Error('rate-limited');
    err.code = 'rate-limited';
    err.retryAfterMs = updates.rateLimitWaitMs((n) => res.headers.get(n));
    throw err;
  }
  // No stable release published at all (e.g. only betas exist, or the
  // releases were deleted): not a network problem, say so downstream.
  if (res.status === 404) throw Object.assign(new Error('no-releases'), { code: 'no-releases' });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.code = 'http';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getText(url) {
  const res = await safeFetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/**
 * Ask the release feed. Resolves with a decision object and never rejects —
 * every failure comes back as `updateAvailable: false` with a `reason` the UI
 * can report honestly (`offline`, `rate-limited`, `no-releases`, `http`),
 * because a failed check must neither disturb the UI nor lie about the cause.
 */
async function checkForUpdate() {
  const current = app.getVersion();
  // Running from source: there is no install to replace, so stay offline.
  if (!app.isPackaged) return { checked: false, skipped: true, updateAvailable: false, current };
  // One retry on transport failure only: a flaky first packet should not read
  // as unreachable. HTTP answers (403/404/500) are final — retrying a rate
  // limit would only extend it.
  for (let attempt = 0; ; attempt++) {
    try {
      const payload = await getJson(updates.RELEASES_API);
      return { checked: true, ...updates.selectUpdate(payload, current) };
    } catch (e) {
      if (e && e.code === 'offline' && attempt === 0) continue;
      const reason = (e && e.code) || 'offline';
      const out = { checked: false, updateAvailable: false, current, reason, offline: reason === 'offline' };
      if (e && Number.isFinite(e.retryAfterMs)) out.retryAfterMs = e.retryAfterMs;
      return out;
    }
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', c => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Streams the asset to `dest`, reporting a 0-100 integer percent. */
async function download(url, dest, expectedSize, onPercent) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!res.body) throw new Error('empty response');
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  let received = 0;
  let lastPct = -1;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total && onPercent) {
        const pct = Math.min(100, Math.floor((received / total) * 100));
        if (pct !== lastPct) { lastPct = pct; onPercent(pct); }
      }
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
  if (expectedSize > 0 && received !== expectedSize) {
    throw new Error('size mismatch: got ' + received + ', expected ' + expectedSize);
  }
}

/**
 * Confirm, download, verify, run. `onProgress({ phase, percent })` drives the
 * pill: 'download' | 'verify' | 'run'.
 */
async function installUpdate(onProgress) {
  const progress = (phase, percent) => { if (onProgress) onProgress({ phase, percent }); };

  if (process.platform !== 'win32' || !app.isPackaged) return { ok: false, reason: 'unsupported' };

  const check = await checkForUpdate();
  if (!check.updateAvailable) return { ok: false, reason: 'no-update' };
  if (!check.checksums) return { ok: false, reason: 'no-checksums' };

  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Install now', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: 'Install version ' + check.latest + '?',
    detail: 'You are on ' + check.current + '. NexusChat closes while Windows setup runs and reopens when it finishes.\n\n'
      + 'The download comes from the official GitHub release and is checked against its SHA-256 checksum before anything runs.'
  });
  if (response !== 0) return { ok: false, reason: 'cancelled' };

  let expected;
  try {
    const sums = updates.parseChecksums(await getText(check.checksums.url));
    expected = sums[check.asset.name];
  } catch {
    return { ok: false, reason: 'no-checksums' };
  }
  if (!expected) return { ok: false, reason: 'no-checksums' };

  const file = path.join(app.getPath('temp'), check.asset.name);
  try {
    progress('download', 0);
    await download(check.asset.url, file, check.asset.size, pct => progress('download', pct));
    progress('verify');
    const actual = await sha256File(file);
    if (!updates.matchesChecksum(actual, expected)) {
      throw new Error('checksum mismatch');
    }
    progress('run');
    // No shell, no string: the verified file runs exactly as named.
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 400);
    return { ok: true, restarting: true };
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return { ok: false, reason: /checksum/.test(String(err && err.message)) ? 'checksum' : 'download' };
  }
}

/** Open the official release page (the fallback where setup cannot run). */
async function openReleasePage() {
  try {
    await shell.openExternal(updates.RELEASES_PAGE);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

module.exports = { checkForUpdate, installUpdate, openReleasePage };

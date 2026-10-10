'use strict';

/**
 * What counts as a safe update, decided in one place so the main process, the
 * renderer and the tests all agree:
 *
 *   - the release must be a stable semver tag (v1.2.3), newer than what runs;
 *   - the installer must be an official asset of this repository — the URL has
 *     to sit under the repo's own /releases/download/ path, so a tampered API
 *     answer cannot point the downloader at another host;
 *   - the release must carry a SHA256SUMS file, and the installer's name must
 *     appear in it, otherwise there is nothing to verify the download against.
 *
 * Nothing here touches the network or the filesystem: the caller injects the
 * GitHub response.
 */

const RELEASES_API = 'https://api.github.com/repos/kryvex-ai/nexuschat-open/releases/latest';
const RELEASES_PAGE = 'https://github.com/kryvex-ai/nexuschat-open/releases/latest';
const ASSET_PREFIX = 'https://github.com/kryvex-ai/nexuschat-open/releases/download/';
const SUMS_NAME = 'SHA256SUMS.txt';

/** 'v1.2.3' | '1.2.3' -> { major, minor, patch }, else null (prerelease tags too). */
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag == null ? '' : tag).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function versionToString(v) {
  return v.major + '.' + v.minor + '.' + v.patch;
}

/** -1 | 0 | 1. Accepts tags or parsed objects; unparseable sorts lowest. */
function compareVersions(a, b) {
  const pa = typeof a === 'object' && a ? a : parseTag(a);
  const pb = typeof b === 'object' && b ? b : parseTag(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

/** Official asset or release-page URLs only — anything else is refused. */
function isOfficialUrl(url) {
  return typeof url === 'string'
    && (url === RELEASES_PAGE || url.startsWith(ASSET_PREFIX));
}

/**
 * Where a release download may land *after* following redirects: github.com
 * issues a 302 to its CDN, so redirects must work — but only ever into
 * GitHub's own territory. Checked against the final URL of every download.
 */
function isOfficialDownloadHost(hostname) {
  const h = String(hostname == null ? '' : hostname).toLowerCase();
  return h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com');
}

/**
 * The setup executable for this exact version out of a release's assets.
 * The portable build is never picked: setup is what the pill installs.
 */
function pickAsset(assets, version) {
  const want = 'NexusChat-Open-Setup-' + version + '.exe';
  const list = (Array.isArray(assets) ? assets : [])
    .filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
  const chosen = list.find(a => a.name === want) || list.find(a => /Setup[^/]*\.exe$/i.test(a.name));
  if (!chosen || !isOfficialUrl(chosen.browser_download_url)) return null;
  return { name: chosen.name, url: chosen.browser_download_url, size: Number(chosen.size) || 0 };
}

/** The SHA256SUMS asset of the same release, if it is official and well formed. */
function pickChecksums(assets) {
  const sums = (Array.isArray(assets) ? assets : [])
    .find(a => a && a.name === SUMS_NAME && typeof a.browser_download_url === 'string');
  if (!sums || !isOfficialUrl(sums.browser_download_url)) return null;
  return { name: sums.name, url: sums.browser_download_url };
}

/**
 * GitHub's latest-release payload + the running version -> the decision the
 * UI acts on. Never throws; `reason` says why there is nothing to install.
 */
function selectUpdate(payload, currentVersion) {
  const current = parseTag(currentVersion);
  const base = {
    updateAvailable: false,
    current: current ? versionToString(current) : String(currentVersion == null ? '' : currentVersion),
    latest: null
  };
  if (!current) return { ...base, reason: 'bad-current' };
  const latest = parseTag(payload && payload.tag_name);
  if (!latest) return { ...base, reason: 'bad-tag' };
  const out = { ...base, latest: versionToString(latest) };
  if (payload.draft || payload.prerelease) return { ...out, reason: 'not-stable' };
  if (compareVersions(latest, current) <= 0) return { ...out, reason: 'up-to-date' };
  const asset = pickAsset(payload.assets, out.latest);
  if (!asset) return { ...out, reason: 'no-safe-asset' };
  return {
    ...out,
    updateAvailable: true,
    asset,
    checksums: pickChecksums(payload.assets),
    reason: null
  };
}

/**
 * '<64 hex>  <filename>' lines (sha256sum format, optional '*' binary marker)
 * -> { filename: hex }.
 */
function parseChecksums(text) {
  const map = Object.create(null);
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
    if (m) map[m[2].trim()] = m[1].toLowerCase();
  }
  return map;
}

/** Constant-time hex compare: a mismatch must not leak how far it got. */
function matchesChecksum(actualHex, expectedHex) {
  const a = String(actualHex == null ? '' : actualHex).toLowerCase();
  const b = String(expectedHex == null ? '' : expectedHex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * How long GitHub asks us to wait before checking again, in milliseconds.
 * getHeader(name) reads one response header. Returns null when nothing says
 * to wait — callers then use their own wording instead of a time.
 */
function rateLimitWaitMs(getHeader) {
  const get = typeof getHeader === 'function' ? getHeader : () => null;
  const num = (v) => {
    const n = Number(String(v == null ? '' : v).trim());
    return Number.isFinite(n) ? n : null;
  };
  const retryAfter = num(get('retry-after'));
  if (retryAfter !== null && retryAfter > 0) return retryAfter * 1000;
  const reset = num(get('x-ratelimit-reset'));
  if (reset !== null && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  return null;
}

module.exports = {
  RELEASES_API,
  RELEASES_PAGE,
  ASSET_PREFIX,
  SUMS_NAME,
  parseTag,
  versionToString,
  compareVersions,
  rateLimitWaitMs,
  isOfficialUrl,
  isOfficialDownloadHost,
  pickAsset,
  pickChecksums,
  selectUpdate,
  parseChecksums,
  matchesChecksum
};

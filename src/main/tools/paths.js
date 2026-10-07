'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Workspace confinement.
 *
 * Every file tool works inside one root: the folder the user picked in
 * Settings. This module is the only thing standing between a model-supplied
 * path and your home directory, so it is deliberately strict:
 *
 *  - `..` cannot climb out (the resolved path must stay under the root);
 *  - a symlink pointing outside is refused, checked on the real path;
 *  - writes into .git internals are refused — git history is the git tools'
 *    business, not a text editor's;
 *  - the root itself must exist and be a directory.
 */

const DENY_WRITE_DIRS = ['.git'];

class WorkspaceError extends Error {}

/** Absolute, symlink-free form of the root, or null when it is unusable. */
function realRoot(root) {
  try {
    const abs = path.resolve(String(root || ''));
    const real = fs.realpathSync(abs);
    if (!fs.statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Resolve a model-supplied path against the root.
 * Returns { ok: true, abs, rel } or { ok: false, error } — never throws.
 */
/** True for an existing entry, dangling link included. */
function lstatOk(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function resolvePath(root, p, { forWrite = false } = {}) {
  const real = realRoot(root);
  if (!real) return { ok: false, error: 'The workspace folder is not available — set it in Settings → Agent.' };

  const input = String(p == null ? '' : p).trim();
  if (!input) return { ok: false, error: 'A path is required.' };
  if (input.includes('\0')) return { ok: false, error: 'That path contains a NUL byte.' };

  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(real, input);
  const rel = path.relative(real, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `That path is outside the workspace (${real}). Tools can only touch files inside it.` };
  }

  // Follow symlinks on whatever part already exists, so a link pointing out
  // of the tree cannot be used as a tunnel. This probes with lstat, not
  // exists: a link whose target has vanished still counts as a link here, so
  // the realpath below refuses it instead of the write going straight
  // through to wherever the dangling link points.
  let probe = abs;
  while (probe !== real && !lstatOk(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    return { ok: false, error: 'That path could not be resolved.' };
  }
  const realRel = path.relative(real, realProbe);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { ok: false, error: 'That path resolves outside the workspace (through a link). Tools can only touch files inside it.' };
  }
  // For a write, the final component may not exist yet — re-join it onto the
  // resolved parent so the containment check still describes the real target.
  const absFinal = path.join(realProbe, path.relative(probe, abs));
  const relFinal = path.relative(real, absFinal);
  if (relFinal === '' || relFinal.startsWith('..') || path.isAbsolute(relFinal)) {
    return { ok: false, error: 'That path is outside the workspace.' };
  }

  // Workspace-relative paths are reported with forward slashes: the messages
  // quote them, models read them back, and the string checks in the tool
  // layer ("dir/") must behave the same on every platform.
  const relPosix = relFinal.split(path.sep).join('/');
  if (forWrite) {
    const top = relPosix.split('/')[0];
    if (DENY_WRITE_DIRS.includes(top)) {
      return { ok: false, error: `Writing inside ${top}/ is not something a text tool should do — use the git tools instead.` };
    }
  }

  return { ok: true, abs: absFinal, rel: relPosix, root: real };
}

function assertInside(root, abs) {
  const real = realRoot(root);
  if (!real) throw new WorkspaceError('The workspace folder is not available.');
  const rel = path.relative(real, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceError('That path is outside the workspace.');
  }
  return rel.split(path.sep).join('/');
}

module.exports = { resolvePath, realRoot, assertInside, WorkspaceError, DENY_WRITE_DIRS };
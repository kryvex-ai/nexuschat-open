'use strict';

/**
 * Directives — the provider-agnostic way a model asks the app to act.
 *
 * A directive is one line of the form `[[kind {json}]]`. Every provider in
 * the app speaks it, which is why it exists: native function calling differs
 * per provider, and a syntax that works everywhere beats a nicer syntax that
 * works on half of them.
 *
 * The scanner below is brace-matching rather than regex-based so that JSON
 * strings containing brackets ("buy milk [urgent]") do not end the directive
 * early, and anything malformed is left in the text where the user can see
 * it instead of silently vanishing.
 */

/**
 * Strip every directive of `kind` out of `text`.
 * Returns { text, actions } — `text` is the reply without the directive lines,
 * `actions` the parsed objects, in the order they appeared.
 *
 * `accept` is an optional predicate on the parsed object. A JSON object that
 * parses but is not a real directive (missing `action`, say) is left in the
 * text where the user can see it and is not counted — the same thing a
 * malformed directive does.
 */
function extractDirectives(text, kind, accept) {
  const raw = String(text || '');
  const actions = [];
  let out = '';
  let i = 0;
  const open = '[[' + kind;
  while (i < raw.length) {
    const start = raw.indexOf(open, i);
    if (start === -1) { out += raw.slice(i); break; }
    const j = start + open.length;
    const nxt = raw[j];
    if (nxt !== undefined && nxt !== '{' && !/\s/.test(nxt)) {
      // "[[toolbox …" is not a directive — keep it and move on.
      out += raw.slice(i, j);
      i = j;
      continue;
    }
    let k = j;
    while (k < raw.length && /\s/.test(raw[k])) k++;
    if (raw[k] !== '{') {
      out += raw.slice(i, j);
      i = j;
      continue;
    }
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let p = k; p < raw.length; p++) {
      const ch = raw[p];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = p; break; }
      }
    }
    if (end === -1) {
      out += raw.slice(i, j);
      i = j;
      continue;
    }
    let m = end + 1;
    while (m < raw.length && /\s/.test(raw[m])) m++;
    if (raw.slice(m, m + 2) !== ']]') {
      out += raw.slice(i, j);
      i = j;
      continue;
    }
    try {
      const a = JSON.parse(raw.slice(k, end + 1));
      if (a && typeof a === 'object' && !Array.isArray(a) && (!accept || accept(a))) {
        out += raw.slice(i, start);
        actions.push(a);
        i = m + 2;
        continue;
      }
    } catch { /* malformed: keep it visible */ }
    out += raw.slice(i, j);
    i = j;
  }
  return { text: out.replace(/[ \t]+\n/g, '\n').trim(), actions };
}

/**
 * Make untrusted text incapable of becoming a directive. Used on everything
 * that comes back from a tool result before it is fed into the model again,
 * and on anything stored that later ends up in a prompt — a file that
 * contains `[[tool …]]` must not be able to act on its own.
 */
function neutralizeDirectives(s) {
  return String(s || '').replace(/\[\[/g, '[ [');
}

module.exports = { extractDirectives, neutralizeDirectives };
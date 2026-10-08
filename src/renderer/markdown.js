'use strict';

/**
 * The transcript's markdown half, kept out of app.js so it can be unit-tested
 * on plain Node: parse() is pure and DOM-free, render() only ever builds nodes
 * with createElement / textContent / appendChild. A model's reply is untrusted
 * text — an unmatched `<script>` or `javascript:` link has to land as literal
 * text, so the tree is only ever built node by node and no HTML string parse
 * exists.
 *
 * The UMD shim mirrors models.js: the renderer loads this as a plain
 * <script> (it never gets Node), and the test suite requires it. One
 * implementation, no copy that can drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexusMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------------- line grammar ----------------
   * Every line pattern allows a trailing \r so CRLF replies parse the same
   * way; paragraphs keep their lines verbatim (see below), so a round trip
   * never rewrites the author's text. `{0,3}` indentation matches the usual
   * markdown fences/headings; deeper indents stay literal paragraph text.
   */
  const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)\r?$/;
  const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?\r?$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/;
  const BULLET = /^ {0,3}([-*+])[ \t]+(.*)\r?$/;
  const ORDERED = /^ {0,3}\d{1,9}[.)][ \t]+(.*)\r?$/;
  const QUOTE = /^ {0,3}>[ \t]?(.*)\r?$/;

  const isBlank = (line) => !line.trim();

  /** The info string of a backtick fence may not contain a backtick. */
  const fenceOf = (line) => {
    const m = FENCE.exec(line);
    if (!m) return null;
    if (m[1][0] === '`' && m[2].includes('`')) return null;
    return m;
  };

  /** `- x` / `1. x` → { ordered, text }; anything else is not an item. */
  function listItem(line) {
    const b = BULLET.exec(line);
    if (b) return { ordered: false, text: b[2].trim() };
    const o = ORDERED.exec(line);
    if (o) return { ordered: true, text: o[1].trim() };
    return null;
  }

  /** True when this line starts a block of its own (so a paragraph stops). */
  function startsBlock(line) {
    if (fenceOf(line)) return true;
    if (HEADING.test(line)) return true;
    if (RULE.test(line)) return true;
    if (QUOTE.test(line)) return true;
    return !!listItem(line);
  }

  /**
   * text → [{type:'heading'|'paragraph'|'list'|'code'|'quote'|'rule', …}].
   * Pure, iterative, and never throws: headings cap at level 3, an unclosed
   * fence runs to the end of the input, and anything unmatched is a paragraph
   * kept exactly as written (paragraph lines join with a literal "\n").
   */
  function parse(text) {
    const src = text == null ? '' : String(text);
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      const open = fenceOf(line);
      if (open) {
        const marker = open[1];
        const lang = (open[2] || '').trim().split(/\s+/)[0] || '';
        const body = [];
        let j = i + 1;
        let closed = false;
        for (; j < lines.length; j++) {
          const close = FENCE_CLOSE.exec(lines[j]);
          if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
            closed = true;
            break;
          }
          body.push(lines[j]);
        }
        out.push({ type: 'code', lang, code: body.join('\n') });
        i = closed ? j + 1 : lines.length;
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        out.push({
          type: 'heading',
          level: Math.min(heading[1].length, 3),
          text: (heading[2] || '').trim()
        });
        i++;
        continue;
      }

      if (RULE.test(line)) { out.push({ type: 'rule' }); i++; continue; }

      if (QUOTE.test(line)) {
        const parts = [];
        while (i < lines.length) {
          const q = QUOTE.exec(lines[i]);
          if (!q) break;
          parts.push(q[1]);
          i++;
        }
        out.push({ type: 'quote', text: parts.join('\n') });
        continue;
      }

      const first = listItem(line);
      if (first) {
        const items = [];
        while (i < lines.length && !isBlank(lines[i])) {
          const it = listItem(lines[i]);
          if (!it || it.ordered !== first.ordered) break;
          items.push(it.text);
          i++;
        }
        out.push({ type: 'list', ordered: first.ordered, items });
        continue;
      }

      // Paragraph: consecutive lines that start no block, kept verbatim so
      // the text round-trips exactly (a blank line ends it).
      const para = [];
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push({ type: 'paragraph', text: para.join('\n') });
    }

    return out;
  }

  /* ---------------- inline ---------------- */

  // Alternation order matters: bold before italic, the link before a bare URL
  // (a `[t](…)` URL must be consumed by the link, not linked twice).
  const INLINE = /(?<bold>\*\*[^*\n]+\*\*)|(?<italic>\*[^*\n]+\*|_[^_\n]+_)|(?<code>`[^`\n]+`)|(?<link>\[(?<label>[^\]\n]*)\]\((?<href>[^)\s]+)\))|(?<url>https?:\/\/[^\s<>"'`]+)/g;

  const isWebUrl = (url) => /^https?:\/\//i.test(url);
  // Trailing sentence punctuation belongs to the sentence, not the link.
  const TRAILING = /[.,;:!?'")\]}]+$/;

  /**
   * text → runs: {kind:'text',text} | {kind:'bold'|'italic'|'code',text}
   *        | {kind:'link',label,href}. Anything that is not http(s) stays
   * literal text — no anchor, no scheme smuggled through.
   */
  function inline(text) {
    const raw = text == null ? '' : String(text);
    const runs = [];
    let last = 0;
    INLINE.lastIndex = 0;
    let m;
    while ((m = INLINE.exec(raw))) {
      if (m.index > last) runs.push({ kind: 'text', text: raw.slice(last, m.index) });
      last = m.index + m[0].length;
      const g = m.groups || {};
      if (g.bold) {
        runs.push({ kind: 'bold', text: g.bold.slice(2, -2) });
      } else if (g.italic) {
        runs.push({ kind: 'italic', text: g.italic.slice(1, -1) });
      } else if (g.code) {
        runs.push({ kind: 'code', text: g.code.slice(1, -1) });
      } else if (g.link) {
        if (isWebUrl(g.href)) runs.push({ kind: 'link', label: g.label, href: g.href });
        else runs.push({ kind: 'text', text: g.link });
      } else if (g.url) {
        const clean = g.url.replace(TRAILING, '');
        if (clean) {
          runs.push({ kind: 'link', label: clean, href: clean });
          if (clean.length < g.url.length) runs.push({ kind: 'text', text: g.url.slice(clean.length) });
        } else {
          runs.push({ kind: 'text', text: g.url });
        }
      }
    }
    if (last < raw.length) runs.push({ kind: 'text', text: raw.slice(last) });
    if (!runs.length) runs.push({ kind: 'text', text: '' });
    return runs;
  }

  /* ---------------- render (DOM only) ---------------- */

  function emptyFragment(doc) {
    if (doc && typeof doc.createDocumentFragment === 'function') return doc.createDocumentFragment();
    // No usable document (a test harness may pass nothing at all): hand back
    // an empty fragment-shaped object rather than throwing at the caller.
    const kids = [];
    return {
      nodeType: 11,
      childNodes: kids,
      children: kids,
      appendChild(c) { kids.push(c); return c; }
    };
  }

  function makeFragment(doc) {
    if (doc && typeof doc.createDocumentFragment === 'function') return doc.createDocumentFragment();
    return emptyFragment(doc);
  }

  /** A run container: plain text only ever sets textContent (or one span). */
  function fill(el, text, doc) {
    const runs = inline(text);
    if (runs.length === 1 && runs[0].kind === 'text') {
      el.textContent = runs[0].text;
      return;
    }
    for (const r of runs) {
      if (r.kind === 'text') {
        if (!r.text) continue;
        const span = doc.createElement('span');
        span.textContent = r.text;
        el.appendChild(span);
      } else if (r.kind === 'bold') {
        const strong = doc.createElement('strong');
        strong.textContent = r.text;
        el.appendChild(strong);
      } else if (r.kind === 'italic') {
        const em = doc.createElement('em');
        em.textContent = r.text;
        el.appendChild(em);
      } else if (r.kind === 'code') {
        const code = doc.createElement('code');
        code.className = 'inline-code';
        code.textContent = r.text;
        el.appendChild(code);
      } else if (r.kind === 'link') {
        const a = doc.createElement('a');
        a.textContent = r.label;
        a.setAttribute('href', r.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        el.appendChild(a);
      }
    }
  }

  function blockEl(b, doc) {
    if (b.type === 'heading') {
      const level = Math.min(3, Math.max(1, Number(b.level) || 1));
      const h = doc.createElement('h' + level);
      // md-h* is the markdown vocabulary; h-md is the heading style hook.
      h.className = 'md-h' + level + ' h-md';
      fill(h, b.text, doc);
      return h;
    }
    if (b.type === 'paragraph') {
      const p = doc.createElement('p');
      p.className = 'md-p';
      fill(p, b.text, doc);
      return p;
    }
    if (b.type === 'list') {
      const list = doc.createElement(b.ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      for (const item of b.items) {
        const li = doc.createElement('li');
        fill(li, item, doc);
        list.appendChild(li);
      }
      return list;
    }
    if (b.type === 'quote') {
      const q = doc.createElement('blockquote');
      q.className = 'md-quote';
      fill(q, b.text, doc);
      return q;
    }
    if (b.type === 'rule') {
      const hr = doc.createElement('hr');
      hr.className = 'md-rule';
      return hr;
    }
    if (b.type === 'code') {
      const pre = doc.createElement('pre');
      pre.className = 'md-code';
      if (b.lang) pre.setAttribute('data-lang', b.lang);
      const code = doc.createElement('code');
      code.textContent = b.code == null ? '' : String(b.code);
      pre.appendChild(code);
      const btn = doc.createElement('button');
      btn.className = 'md-copy';
      btn.setAttribute('type', 'button');
      btn.setAttribute('aria-label', 'Copy code');
      btn.setAttribute('title', 'Copy code');
      btn.textContent = 'Copy';
      pre.appendChild(btn);
      return pre;
    }
    return null;
  }

  /**
   * text → DocumentFragment of parse()'s blocks. Nodes are built with
   * createElement/textContent/appendChild only; a falsy or stub document
   * yields an empty fragment instead of a crash.
   */
  function render(text, doc) {
    if (!doc || typeof doc.createElement !== 'function') return emptyFragment(doc);
    const frag = makeFragment(doc);
    let blocks;
    try {
      blocks = parse(text);
      for (const b of blocks) {
        const node = blockEl(b, doc);
        if (node) frag.appendChild(node);
      }
    } catch (e) {
      // A malformed document must degrade to what we managed to build.
    }
    return frag;
  }

  return { parse, render };
});

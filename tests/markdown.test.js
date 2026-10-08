'use strict';

/**
 * markdown.js: the parser as a pure function, and the renderer against a
 * minimal fake document.
 *
 * Two things are worth proving here. First, the block format is a stable
 * contract (app.js and future CSS lean on those exact shapes). Second, a
 * model reply is untrusted text: an unmatched `<script>` or a
 * `javascript:` link has to land as literal text, never as markup — which
 * is why the renderer is checked through a serializer that escapes, the way
 * a browser serializes text nodes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const md = require('../src/renderer/markdown.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'markdown.js'), 'utf8');

const TYPES = new Set(['heading', 'paragraph', 'list', 'code', 'quote', 'rule']);
const types = (text) => md.parse(text).map(b => b.type);

/* ---------------- a fake document, just enough for render() ---------------- */

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: tag === '#fragment' ? 11 : 1,
    className: '',
    attrs: {},
    children: [],
    parent: null,
    _text: '',
    get textContent() {
      return this._text + this.children.map(c => c.textContent).join('');
    },
    set textContent(v) {
      this._text = v == null ? '' : String(v);
      this.children = [];
    },
    get childNodes() { return this.children; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; }
  };
  return node;
}

const makeDoc = () => ({
  createElement: (tag) => makeNode(tag),
  createDocumentFragment: () => makeNode('#fragment')
});

const doc = makeDoc();

/** Serialize the fake tree the way a browser would, escaping all text. */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function serialize(node) {
  if (node.nodeType === 3) return esc(node._text);
  const attrs = Object.entries(node.attrs).map(([k, v]) => ' ' + k + '="' + esc(v) + '"').join('');
  const cls = node.className ? ' class="' + esc(node.className) + '"' : '';
  const tag = node.tagName.toLowerCase();
  return '<' + tag + cls + attrs + '>' + esc(node._text)
    + node.children.map(serialize).join('') + '</' + tag + '>';
}

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}
const byClass = (root, cls) => walk(root).filter(n => String(n.className).split(/\s+/).includes(cls));
const byTag = (root, tag) => walk(root).filter(n => n.tagName === String(tag).toUpperCase());
const render = (text) => md.render(text, doc);

/* ---------------- headings ---------------- */

test('ATX headings run h1–h3, and deeper markers degrade to h3', () => {
  assert.deepEqual(md.parse('# One'), [{ type: 'heading', level: 1, text: 'One' }]);
  assert.deepEqual(md.parse('## Two'), [{ type: 'heading', level: 2, text: 'Two' }]);
  assert.deepEqual(md.parse('### Three'), [{ type: 'heading', level: 3, text: 'Three' }]);
  assert.deepEqual(md.parse('#### Four'), [{ type: 'heading', level: 3, text: 'Four' }]);
  assert.deepEqual(md.parse('###### Six'), [{ type: 'heading', level: 3, text: 'Six' }]);
  assert.equal(md.parse('####### seven')[0].type, 'paragraph', 'seven hashes is not a heading');
  assert.equal(md.parse('#nospace')[0].type, 'paragraph', 'a marker needs a space');
});

test('heading text is trimmed of its own padding', () => {
  assert.deepEqual(md.parse('  #  Hello world  '), [{ type: 'heading', level: 1, text: 'Hello world' }]);
  assert.deepEqual(md.parse('#'), [{ type: 'heading', level: 1, text: '' }]);
});

/* ---------------- paragraphs ---------------- */

test('a paragraph round-trips exactly, trailing spaces and all', () => {
  const samples = [
    'Hello streaming works token by token!',
    'trailing spaces live here  ',
    '  an indented line stays text',
    'line one\nline two',
    'a\r\nb\r',
    '<script>alert(1)</script>',
    '**bold** `code` and a bare https://example.com all stay one paragraph'
  ];
  for (const s of samples) {
    assert.deepEqual(md.parse(s), [{ type: 'paragraph', text: s }], JSON.stringify(s));
  }
});

test('paragraphs join with \\n inside, and blank lines split them', () => {
  assert.deepEqual(md.parse('one\ntwo'), [{ type: 'paragraph', text: 'one\ntwo' }]);
  assert.deepEqual(types('one\n\n\ntwo'), ['paragraph', 'paragraph']);
  const doc = 'First para\nsecond line\n\nSecond para';
  assert.equal(md.parse(doc).map(b => b.text).join('\n\n'), doc, 'blocks round-trip as a document');
  assert.deepEqual(md.parse('   \n\t\n'), [], 'whitespace-only input is empty, not a paragraph');
  assert.deepEqual(md.parse(''), []);
  assert.deepEqual(md.parse(null), []);
  assert.deepEqual(md.parse(undefined), []);
});

/* ---------------- lists ---------------- */

test('bullet lists take -, * and + and stop at a blank line', () => {
  for (const marker of ['-', '*', '+']) {
    assert.deepEqual(md.parse(marker + ' a\n' + marker + ' b'), [
      { type: 'list', ordered: false, items: ['a', 'b'] }
    ]);
  }
  const two = md.parse('- a\n\n- b');
  assert.equal(two.length, 2, 'a blank line ends the list');
  assert.deepEqual(two[1], { type: 'list', ordered: false, items: ['b'] });
});

test('ordered lists are marked ordered and stop when the marker kind changes', () => {
  assert.deepEqual(md.parse('1. one\n2. two'), [{ type: 'list', ordered: true, items: ['one', 'two'] }]);
  assert.deepEqual(md.parse('1) paren'), [{ type: 'list', ordered: true, items: ['paren'] }]);
  const mixed = md.parse('1. one\n- bullet');
  assert.deepEqual(mixed, [
    { type: 'list', ordered: true, items: ['one'] },
    { type: 'list', ordered: false, items: ['bullet'] }
  ]);
});

test('a non-item line ends a list instead of joining it', () => {
  assert.deepEqual(types('- item\n\na paragraph'), ['list', 'paragraph']);
  assert.deepEqual(types('- item\na paragraph'), ['list', 'paragraph']);
  assert.equal(md.parse('-')[0].type, 'paragraph', 'a bare marker is not a list');
});

/* ---------------- fenced code ---------------- */

test('fences keep their code verbatim and carry the language token', () => {
  const blocks = md.parse('```js\nconst a = 1;\n\nconst b = 2;\n```');
  assert.deepEqual(blocks, [{ type: 'code', lang: 'js', code: 'const a = 1;\n\nconst b = 2;' }]);
  assert.deepEqual(md.parse('```\nplain\n```'), [{ type: 'code', lang: '', code: 'plain' }]);
  assert.deepEqual(md.parse('~~~python\nprint(1)\n~~~'), [{ type: 'code', lang: 'python', code: 'print(1)' }]);
  assert.equal(md.parse('```js  \nx\n```')[0].lang, 'js', 'trailing padding in the info string');
});

test('an unclosed fence runs to the end of the input and never throws', () => {
  assert.deepEqual(md.parse('text\n\n```js\nunclosed\nmore'), [
    { type: 'paragraph', text: 'text' },
    { type: 'code', lang: 'js', code: 'unclosed\nmore' }
  ]);
  // A shorter run of backticks does not close a longer one, either.
  assert.equal(md.parse('````\ncode\n```')[0].code, 'code\n```');
  assert.equal(md.parse('``a`b')[0].type, 'paragraph', 'a backtick in the info string is not a fence');
});

/* ---------------- quotes and rules ---------------- */

test('quotes join their > lines and stop at the first plain line', () => {
  assert.deepEqual(md.parse('> one\n> two'), [{ type: 'quote', text: 'one\ntwo' }]);
  assert.deepEqual(md.parse('> quoted\nplain'), [
    { type: 'quote', text: 'quoted' },
    { type: 'paragraph', text: 'plain' }
  ]);
  assert.deepEqual(md.parse('>'), [{ type: 'quote', text: '' }]);
});

test('thematic breaks are rules; near-misses are not', () => {
  for (const rule of ['---', '***', '___', '- - -', '*  *  *']) {
    assert.deepEqual(md.parse(rule), [{ type: 'rule' }], rule);
  }
  assert.equal(md.parse('--')[0].type, 'paragraph');
  assert.equal(md.parse('- item')[0].type, 'list');
});

/* ---------------- a whole document ---------------- */

test('a mixed document keeps its blocks in source order', () => {
  const text = '# Title\n\nintro line\n\n- one\n- two\n\n1. first\n\n```sh\nls\n```\n\n> note\n\n---\n\ntail';
  assert.deepEqual(types(text), [
    'heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule', 'paragraph'
  ]);
});

/* ---------------- adversarial input ---------------- */

const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '\u0000\u0001nul bytes',
  '```js\nno closing fence',
  '~~~~\n~~~\nstill inside',
  '#'.repeat(10000),
  'a'.repeat(10000),
  '> '.repeat(3000),
  '1. \n2. \n3.',
  '[click](javascript:alert(1))',
  '![img](https://example.com/a.png)',
  '| a | b |\n| --- | --- |',
  'line1\r\nline2\r\n',
  '   \t   ',
  null,
  undefined,
  42,
  {},
  []
];

test('parse never throws, whatever it is fed', () => {
  for (const bad of HOSTILE) {
    assert.doesNotThrow(() => md.parse(bad), 'parse(' + String(bad).slice(0, 40) + ')');
    for (const b of md.parse(bad)) {
      assert.ok(TYPES.has(b.type), 'unexpected block type ' + b.type);
    }
  }
});

test('render never throws, and no image or table ever appears', () => {
  for (const bad of HOSTILE) {
    assert.doesNotThrow(() => md.render(bad, doc), 'render with a document');
    assert.doesNotThrow(() => md.render(bad), 'render without a document');
  }
  assert.equal(byTag(render('![img](https://example.com/a.png)'), 'img').length, 0, 'no images');
  assert.equal(byTag(render('| a | b |\n| --- | --- |'), 'table').length, 0, 'no tables');
});

/* ---------------- render: blocks ---------------- */

test('a plain reply round-trips through render with no extra whitespace', () => {
  const frag = render('Hello streaming works token by token!');
  assert.equal(frag.children.length, 1, 'one paragraph, nothing around it');
  assert.equal(frag.children[0].tagName, 'P');
  assert.equal(frag.children[0].className, 'md-p');
  assert.equal(frag.children[0].textContent, 'Hello streaming works token by token!');
});

test('headings, quotes, rules and lists use the shipped classes', () => {
  assert.equal(render('# One').children[0].tagName, 'H1');
  assert.equal(render('# One').children[0].className, 'md-h1 h-md');
  assert.equal(render('## Two').children[0].className, 'md-h2 h-md');
  assert.equal(render('#### Four').children[0].tagName, 'H3', 'deeper headings render as h3');

  const list = render('- a\n- b\n\n1. x').children;
  assert.equal(list[0].tagName, 'UL');
  assert.equal(list[0].className, 'md-list');
  assert.deepEqual(list[0].children.map(li => li.textContent), ['a', 'b']);
  assert.equal(list[0].children[0].tagName, 'LI');
  assert.equal(list[1].tagName, 'OL', 'ordered lists render as ol');
  assert.equal(list[1].className, 'md-list');

  const quote = byClass(render('> a\n> b'), 'md-quote');
  assert.equal(quote.length, 1);
  assert.equal(quote[0].tagName, 'BLOCKQUOTE');
  assert.equal(quote[0].textContent, 'a\nb');

  assert.equal(byClass(render('---'), 'md-rule').length, 1);
  assert.equal(byClass(render('---'), 'md-rule')[0].tagName, 'HR');
});

test('blocks come out in source order, one node each', () => {
  const frag = render('# T\n\npara\n\n- i\n\n---\n\n```\nx\n```');
  assert.deepEqual(frag.children.map(n => n.tagName), ['H1', 'P', 'UL', 'HR', 'PRE']);
});

test('a code block is pre.md-code with its copy button inside', () => {
  const pre = byClass(render('```js\nconst a = 1;\n```'), 'md-code')[0];
  assert.ok(pre, 'pre.md-code exists');
  assert.equal(pre.tagName, 'PRE');
  assert.equal(pre.getAttribute('data-lang'), 'js', 'the language token survives for a future label');
  const code = byTag(pre, 'code')[0];
  assert.equal(code.textContent, 'const a = 1;', 'the code is text, exactly as written');
  const btn = byTag(pre, 'button')[0];
  assert.ok(btn, 'the copy button is in the block');
  assert.equal(btn.className, 'md-copy');
  assert.equal(btn.getAttribute('type'), 'button');
  assert.equal(btn.getAttribute('aria-label'), 'Copy code');
  assert.equal(btn.getAttribute('title'), 'Copy code');
  assert.equal(btn.textContent, 'Copy');
  assert.ok(pre.children.indexOf(btn) > pre.children.indexOf(code), 'the button rides after the code');
});

/* ---------------- render: inline ---------------- */

test('emphasis and inline code become strong, em and code.inline-code', () => {
  const p = render('**b** *i* _u_ `c`').children[0];
  assert.equal(p.textContent, 'b i u c');
  assert.equal(byTag(p, 'strong')[0].textContent, 'b');
  assert.equal(byTag(p, 'em').length, 2, '*i* and _u_ are both italic');
  const code = byTag(p, 'code')[0];
  assert.equal(code.className, 'inline-code');
  assert.equal(code.textContent, 'c');
});

test('links only for http(s), with the safe target and rel', () => {
  const p = render('see [docs](https://example.com/a) now').children[0];
  const a = byTag(p, 'a')[0];
  assert.equal(a.getAttribute('href'), 'https://example.com/a');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.textContent, 'docs');
  assert.equal(p.textContent, 'see docs now');
});

test('non-http schemes render as literal text, never as anchors', () => {
  for (const bad of [
    '[click](javascript:alert(1))',
    '[click](JAVASCRIPT:alert(1))',
    '[click](data:text/html,<script>x</script>)',
    '[click](vbscript:msgbox)'
  ]) {
    const frag = render(bad);
    assert.equal(byTag(frag, 'a').length, 0, 'no anchor for ' + bad);
    assert.equal(frag.children[0].textContent, bad, 'the source stays readable: ' + bad);
  }
});

test('bare https urls become links, sentence punctuation stays behind', () => {
  const p = render('Go to https://example.com/x now').children[0];
  const a = byTag(p, 'a')[0];
  assert.equal(a.getAttribute('href'), 'https://example.com/x');
  assert.equal(a.textContent, 'https://example.com/x');
  assert.equal(p.textContent, 'Go to https://example.com/x now');

  const dotted = render('See https://example.com.').children[0];
  assert.equal(byTag(dotted, 'a')[0].getAttribute('href'), 'https://example.com', 'the full stop is not part of the URL');
  assert.equal(dotted.textContent, 'See https://example.com.');
});

/* ---------------- render: safety ---------------- */

test('markup never becomes HTML: the payload lands as text', () => {
  const frag = render('<script>alert("x")</script>\n\n"><img src=x onerror=alert(1)>');
  const html = serialize(frag);
  assert.ok(html.includes('&lt;script&gt;'), 'the tag is escaped text: ' + html.slice(0, 80));
  assert.ok(!/<script/i.test(html), 'no live script tag in the output');
  assert.equal(byTag(frag, 'script').length, 0);
  assert.equal(byTag(frag, 'img').length, 0);
  assert.ok(html.includes('&lt;img'), 'the image tag is text too');
});

test('a text run is never split: textContent matches the source', () => {
  const plain = 'Hello streaming works token by token!';
  assert.equal(render(plain).children[0].textContent, plain);
  const mixed = 'Use **this** and that';
  assert.equal(render(mixed).children[0].textContent, 'Use this and that');
});

test('render with a falsy document returns an empty fragment instead of throwing', () => {
  const frag = md.render('# ignored');
  assert.ok(frag, 'still an object to append');
  assert.equal(frag.children.length, 0, 'empty fragment');
  assert.equal(frag.childNodes.length, 0, 'empty child list');
});

test('markdown.js builds nodes only with createElement/textContent/appendChild', () => {
  assert.ok(!source.includes('innerHTML'), 'no innerHTML anywhere in markdown.js');
  assert.ok(!/\bcreateTextNode\b/.test(source), 'text goes through textContent, per the spec');
  assert.match(source, /createElement/);
});

/* ---------------- the module itself ---------------- */

test('the UMD shim is loadable from Node and names the renderer global', () => {
  assert.deepEqual(Object.keys(md).sort(), ['parse', 'render']);
  assert.equal(typeof md.parse, 'function');
  assert.equal(typeof md.render, 'function');
  assert.match(source, /root\.NexusMarkdown = factory\(\)/, 'the renderer gets NexusMarkdown');
  assert.match(source, /module\.exports = factory\(\)/, 'the tests get module.exports');
});

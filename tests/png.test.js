'use strict';

/**
 * The PNG codec behind `npm run icon`: it has to read the brand source
 * (written by another tool, using real per-row filters) and write files the
 * app ships. Both directions are exercised here, plus the geometry helpers
 * that crop the mark out of its transparent canvas.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { encodePNG, decodePNG, alphaBBox, crop, resizeBox } = require('../scripts/png');

/* ---------- helpers ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/**
 * A PNG whose rows each carry a chosen filter type, built by applying the
 * filter *forward* — the inverse of what decodePNG has to undo.
 */
function makeFilteredPNG(width, height, rgba, filters) {
  const bpp = 4, stride = width * bpp;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw[y * (1 + stride)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const left = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upLeft = (y > 0 && x >= bpp) ? rgba[(y - 1) * stride + x - bpp] : 0;
      let pred;
      if (f === 0) pred = 0;
      else if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else pred = paeth(left, up, upLeft);
      raw[y * (1 + stride) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function solid(width, height, rgba) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = rgba[0]; out[i + 1] = rgba[1]; out[i + 2] = rgba[2]; out[i + 3] = rgba[3];
  }
  return { data: out, width, height };
}

/* ---------- tests ---------- */

test('encode → decode round trips every byte', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 10, 20, 30, 0,
    12, 34, 56, 200, 200, 12, 34, 56, 99, 98, 97, 96, 1, 2, 3, 4
  ]);
  const decoded = decodePNG(encodePNG(rgba, 4, 2));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data], [...rgba]);
});

test('decode undoes all five row filters', () => {
  const width = 6, height = 7;
  const rgba = Buffer.alloc(width * height * 4);
  let seed = 7;
  for (let i = 0; i < rgba.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rgba[i] = seed & 0xff; }
  const decoded = decodePNG(makeFilteredPNG(width, height, rgba, [0, 1, 2, 3, 4]));
  assert.deepEqual([...decoded.data], [...rgba]);
});

test('decode rejects what it cannot read, instead of returning garbage', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png')), /not a PNG/);
  const good = encodePNG(solid(2, 2, [1, 2, 3, 255]).data, 2, 2);
  const badType = Buffer.from(good);
  badType[25] = 3; // color type palette — unsupported
  assert.throws(() => decodePNG(badType), /unsupported color type/);
});

test('alphaBBox finds where the mark sits in a transparent canvas', () => {
  const img = solid(10, 8, [0, 0, 0, 0]);
  for (let y = 2; y <= 5; y++) {
    for (let x = 3; x <= 7; x++) {
      const i = (y * 10 + x) * 4;
      img.data[i] = 200; img.data[i + 3] = 255;
    }
  }
  assert.deepEqual(alphaBBox(img), { x: 3, y: 2, w: 5, h: 4 });
  assert.equal(alphaBBox(solid(4, 4, [0, 0, 0, 0])), null, 'all-transparent has no box');
});

test('crop returns exactly the requested rectangle', () => {
  const img = solid(4, 4, [9, 9, 9, 255]);
  const out = crop(img, { x: 1, y: 2, w: 2, h: 2 });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(out.data[0], 9);
  assert.equal(out.data.length, 16);
});

test('resizeBox averages the box and does not bleed transparent pixels', () => {
  const four = {
    width: 2, height: 2,
    data: Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255
    ])
  };
  const one = resizeBox(four, 1, 1);
  assert.deepEqual([...one.data], [128, 128, 128, 255], 'plain average');

  const mixed = {
    width: 2, height: 1,
    data: Buffer.from([255, 0, 0, 0, 0, 0, 255, 255])
  };
  const half = resizeBox(mixed, 1, 1);
  assert.deepEqual([...half.data], [0, 0, 255, 128],
    'a fully transparent pixel contributes colour nowhere — premultiplied average');
});

test('the brand source decodes: 1024² RGBA, real filters, mark cropped where expected', () => {
  const file = path.join(__dirname, '..', 'brand', 'kryvex-logo.png');
  const img = decodePNG(fs.readFileSync(file));
  assert.equal(img.width, 1024);
  assert.equal(img.height, 1024);
  assert.equal(img.data[3], 0, 'canvas corner is transparent');
  const box = alphaBBox(img);
  assert.deepEqual(box, { x: 195, y: 173, w: 646, h: 616 },
    'the mark moved — update the icon expectations if this is intentional');

  const icon = resizeBox(crop(img, box), 512, 512);
  assert.equal(icon.width, 512);
  assert.equal(icon.data[(256 * 512 + 256) * 4 + 3], 255, 'centre of the mark is opaque');
});

test('the generated logo files are present and carry the mark', () => {
  for (const rel of ['build/icon.png', 'src/renderer/logo.png']) {
    const img = decodePNG(fs.readFileSync(path.join(__dirname, '..', rel)));
    assert.equal(img.width, img.height, rel + ' is square');
    assert.equal(img.data[3], 0, rel + ' keeps a transparent background');
    const box = alphaBBox(img);
    assert.ok(box && box.w > img.width * 0.6, rel + ' mark fills most of the canvas');
  }
});

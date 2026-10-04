#!/usr/bin/env node
'use strict';

/**
 * Generates build/icon.png (512x512) with zero dependencies.
 * Matches the in-app logo: sky→violet gradient, rounded square, white chat
 * bubble with the tail. Run: npm run icon
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;

/* ---------- tiny PNG encoder ---------- */
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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

function encodePNG(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- drawing helpers (Hermes mark) ---------- */

// Brand colors: a white wing-bolt on a black field (matches src/renderer/logo.svg)
const INK = [255, 255, 255];   // #FFFFFF
const FIELD = [0, 0, 0];      // #000000

function inRoundedSquare(x, y, r) {
  if (x < 0 || x > SIZE || y < 0 || y > SIZE) return false;
  const cx = Math.max(r, Math.min(SIZE - r, x));
  const cy = Math.max(r, Math.min(SIZE - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// point-in-polygon (ray casting) for the wing-bolt shapes
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const BOLT = [[150, 402], [296, 96], [356, 96], [302, 208], [392, 208], [212, 402]];
const WING_1 = [[296, 96], [430, 96], [398, 150], [342, 150], [356, 96]];
const WING_2 = [[342, 150], [418, 150], [392, 196], [330, 196]];

function inBolt(x, y) {
  return inPoly(x, y, BOLT) || inPoly(x, y, WING_1) || inPoly(x, y, WING_2);
}

/* ---------- render ---------- */

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const outside = !inRoundedSquare(x + 0.5, y + 0.5, 96);
    if (outside) { rgba[i + 3] = 0; continue; }        // rounded square corners (r=96)
    const [r, g, b] = inBolt(x + 0.5, y + 0.5) ? INK : FIELD;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(rgba, SIZE, SIZE));
console.log('Wrote ' + out + ' (' + SIZE + 'x' + SIZE + ')');

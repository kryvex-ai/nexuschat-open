'use strict';

/**
 * A minimal PNG codec, so `npm run icon` can derive the app's icons from
 * brand/kryvex-logo.png with no dependencies beyond node:zlib. Only what the
 * brand file (and our own encoder) actually produces: 8-bit, non-interlaced,
 * RGB or RGBA. Anything else throws instead of decoding garbage.
 */

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------- CRC (PNG requires it on every chunk) ---------- */
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

/** { data: RGBA, width, height } -> PNG file bytes. */
function encodePNG(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- decode ---------- */

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (1 + stride)];
    const row = y * (1 + stride) + 1;
    const o = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[row + x];
      const left = x >= bpp ? out[o + x - bpp] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = (y > 0 && x >= bpp) ? out[prev + x - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + left; break;
        case 2: v = rawByte + up; break;
        case 3: v = rawByte + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          v = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: throw new Error('png: unknown filter type ' + f + ' on row ' + y);
      }
      out[o + x] = v & 0xff;
    }
  }
  return out;
}

/** PNG file bytes -> { data: RGBA, width, height }. */
function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG file');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error('png: unsupported bit depth ' + bitDepth);
  if (interlace !== 0) throw new Error('png: interlaced images are not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('png: unsupported color type ' + colorType);

  const pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, channels);
  if (channels === 4) return { data: pixels, width, height };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i]; rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2]; rgba[j + 3] = 255;
  }
  return { data: rgba, width, height };
}

/* ---------- geometry ---------- */

/**
 * Bounding box of every pixel whose alpha is above `threshold` — where the
 * mark actually sits inside the canvas, so the icon can crop to it.
 * Returns { x, y, w, h } or null when the image is fully transparent.
 */
function alphaBBox(img, threshold = 8) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** A copy of the image containing only the given rectangle. */
function crop(img, rect) {
  const out = { data: Buffer.alloc(rect.w * rect.h * 4), width: rect.w, height: rect.h };
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * img.width + rect.x) * 4;
    img.data.copy(out.data, y * rect.w * 4, src, src + rect.w * 4);
  }
  return out;
}

/**
 * Box-filter resize: each output pixel is the average of the source pixels it
 * covers, weighted by alpha (premultiplied) so transparent edges do not bleed
 * their background colour into the mark. Works for any ratio, exact for the
 * integer ones the icon sizes need.
 */
function resizeBox(img, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * img.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * img.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / width));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const wgt = img.data[i + 3];
          r += img.data[i] * wgt;
          g += img.data[i + 1] * wgt;
          b += img.data[i + 2] * wgt;
          a += wgt;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { data: out, width, height };
}

module.exports = { encodePNG, decodePNG, alphaBBox, crop, resizeBox };

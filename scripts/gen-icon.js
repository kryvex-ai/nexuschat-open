#!/usr/bin/env node
'use strict';

/**
 * Generates the app's two logo files from the brand source, with zero
 * dependencies: build/icon.png (512x512, window/tray/installer) and
 * src/renderer/logo.png (256x256, the in-app mark). Run: npm run icon
 *
 * The source is brand/kryvex-logo.png — the Kryvex mark, which sits inside a
 * larger transparent canvas. The mark is cropped to a padded square first so
 * it fills its box the way an app icon should, instead of floating small in
 * the middle of it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodePNG, decodePNG, alphaBBox, crop, resizeBox } = require('./png');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'brand', 'kryvex-logo.png');
const PAD = 1.15;   // side = mark size * PAD — room for the OS to round corners

/** The mark's bounding box, grown to a square and kept inside the canvas. */
function markRect(img) {
  const box = alphaBBox(img);
  if (!box) throw new Error('brand source is fully transparent: ' + SOURCE);
  const side = Math.min(
    Math.max(box.w, box.h) * PAD,
    img.width,
    img.height
  );
  let x = Math.round(box.x + box.w / 2 - side / 2);
  let y = Math.round(box.y + box.h / 2 - side / 2);
  x = Math.max(0, Math.min(x, img.width - side));
  y = Math.max(0, Math.min(y, img.height - side));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(side), h: Math.round(side) };
}

function write(file, img) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(img.data, img.width, img.height));
  console.log('Wrote ' + path.relative(ROOT, file) + ' (' + img.width + 'x' + img.height + ')');
}

const source = decodePNG(fs.readFileSync(SOURCE));
const mark = crop(source, markRect(source));
write(path.join(ROOT, 'build', 'icon.png'), resizeBox(mark, 512, 512));
write(path.join(ROOT, 'src', 'renderer', 'logo.png'), resizeBox(mark, 256, 256));

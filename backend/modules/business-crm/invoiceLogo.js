'use strict';

// Loads the Gen Z Digital Store logo for embedding in invoice PDFs.
//
// SECURITY: the path is a FIXED constant resolved from __dirname. There is deliberately no parameter
// and no lookup of settings.logo_url here — a settings field is operator-supplied data, and using it
// as a filesystem path or a URL would turn invoice rendering into an arbitrary file read or an
// outbound request (SSRF) triggerable by anyone who can edit settings. The stored logo_url stays
// what it always was: a display value for the web UI.
//
// Decoding uses node's built-in zlib, so this adds no runtime dependency.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOGO_PATH = path.join(__dirname, 'assets', 'invoice-logo.png');
const PNG_SIGNATURE = '89504e470d0a1a0a';

let cache; // undefined = not attempted, null = unavailable, object = ready

/** Reverses the PNG per-scanline filters. Supports all five, so the asset can be regenerated. */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read]; read += 1;
    const line = raw.slice(read, read + stride); read += stride;
    const current = out.slice(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) {
        const predictor = left + up - upLeft;
        const dLeft = Math.abs(predictor - left);
        const dUp = Math.abs(predictor - up);
        const dUpLeft = Math.abs(predictor - upLeft);
        restored = value + (dLeft <= dUp && dLeft <= dUpLeft ? left : (dUp <= dUpLeft ? up : upLeft));
      } else throw new Error(`unsupported PNG filter ${filter}`);
      current[x] = restored & 0xff;
    }
  }
  return out;
}

/**
 * Returns the logo ready for PDF embedding, or null when it cannot be read or decoded.
 *
 * A missing or corrupt logo must never fail an invoice: the caller falls back to a text-only header.
 * The result is cached for the life of the process, so the decode cost is paid once, not per invoice.
 */
function loadInvoiceLogo() {
  if (cache !== undefined) return cache;
  try {
    const file = fs.readFileSync(LOGO_PATH);
    if (file.slice(0, 8).toString('hex') !== PNG_SIGNATURE) throw new Error('not a PNG');
    const width = file.readUInt32BE(16);
    const height = file.readUInt32BE(20);
    const bitDepth = file[24];
    const colorType = file[25];
    const interlace = file[28];
    // 8-bit RGBA, non-interlaced. The committed asset is generated in exactly this shape.
    if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
      throw new Error(`unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
    }
    const parts = [];
    let offset = 8;
    while (offset < file.length) {
      const length = file.readUInt32BE(offset);
      const type = file.slice(offset + 4, offset + 8).toString('latin1');
      if (type === 'IDAT') parts.push(file.slice(offset + 8, offset + 8 + length));
      if (type === 'IEND') break;
      offset += 12 + length;
    }
    if (!parts.length) throw new Error('no image data');
    const pixels = unfilter(zlib.inflateSync(Buffer.concat(parts)), width, height, 4);

    // PDF has no alpha channel on a base image, so colour and transparency are split: RGB becomes
    // the image, alpha becomes its /SMask. Both are re-deflated so the PDF stays small.
    const rgb = Buffer.alloc(width * height * 3);
    const alpha = Buffer.alloc(width * height);
    for (let index = 0; index < width * height; index += 1) {
      rgb[index * 3] = pixels[index * 4];
      rgb[index * 3 + 1] = pixels[index * 4 + 1];
      rgb[index * 3 + 2] = pixels[index * 4 + 2];
      alpha[index] = pixels[index * 4 + 3];
    }
    cache = {
      width,
      height,
      rgb: zlib.deflateSync(rgb, { level: 9 }),
      alpha: zlib.deflateSync(alpha, { level: 9 }),
    };
  } catch {
    // Swallowed on purpose: an unreadable logo degrades the header, it does not break invoicing.
    cache = null;
  }
  return cache;
}

/** Test seam: clears the memo so a test can assert the failure path without reloading the module. */
function resetInvoiceLogoCache() { cache = undefined; }

module.exports = { loadInvoiceLogo, resetInvoiceLogoCache, LOGO_PATH };

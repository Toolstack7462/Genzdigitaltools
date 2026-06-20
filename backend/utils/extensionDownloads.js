'use strict';
/**
 * Writes the uploaded extension ZIP into the EXISTING static download folders so
 * the current client download link (/downloads/genz-digital-store-extension.zip)
 * always serves the latest build. It does NOT create a new download route or
 * folder — it replaces the file in place in the same locations already served.
 *
 * Target dirs are taken from env EXTENSION_DOWNLOAD_DIRS (':'-separated absolute
 * paths) when set; otherwise the known Hostinger docroots are used. Only dirs
 * that already exist are written to (we never create a brand-new download
 * folder). Writes are atomic (temp file + rename).
 */
const fs = require('fs');
const path = require('path');

const ZIP_FILENAME = 'genz-digital-store-extension.zip';

// Default existing download folders (main site, app subdomain, api docroot).
const DEFAULT_DIRS = [
  '/home/u171982351/domains/genzdigitalstore.com/public_html/downloads',
  '/home/u171982351/domains/genzdigitalstore.com/public_html/app/downloads',
  '/home/u171982351/domains/api.genzdigitalstore.com/public_html/downloads',
];

function targetDirs() {
  const fromEnv = String(process.env.EXTENSION_DOWNLOAD_DIRS || '').trim();
  const dirs = fromEnv ? fromEnv.split(':').map(s => s.trim()).filter(Boolean) : DEFAULT_DIRS;
  return dirs;
}

/**
 * Replace the extension zip in every existing download dir.
 * @param {Buffer} buf zip bytes
 * @returns {{written:string[], skipped:string[]}} absolute paths
 */
function writeExtensionZip(buf) {
  const written = [];
  const skipped = [];
  for (const dir of targetDirs()) {
    try {
      if (!fs.existsSync(dir)) { skipped.push(dir + ' (missing)'); continue; }
      const dest = path.join(dir, ZIP_FILENAME);
      const tmp = path.join(dir, `.${ZIP_FILENAME}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest); // atomic replace
      written.push(dest);
    } catch (err) {
      skipped.push(dir + ' (' + err.code + ')');
    }
  }
  return { written, skipped };
}

module.exports = { writeExtensionZip, targetDirs, ZIP_FILENAME, DEFAULT_DIRS };

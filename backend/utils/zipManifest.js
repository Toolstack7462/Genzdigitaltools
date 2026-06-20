'use strict';
/**
 * Extract a single entry (default: manifest.json) from a ZIP buffer using ONLY
 * Node built-ins (zlib). No dependency, so nothing extra needs installing on the
 * server. Supports STORED (method 0) and DEFLATE (method 8) entries — the only
 * methods a Chrome extension zip uses.
 *
 * This is a focused reader: it walks the End-Of-Central-Directory + central
 * directory to find the entry, then reads + inflates its local file data.
 * Never logs or returns anything but the requested file's bytes.
 */
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50; // End of central directory
const CEN_SIG  = 0x02014b50; // Central directory file header
const LOC_SIG  = 0x04034b50; // Local file header

function findEOCD(buf) {
  // EOCD is at the end; comment can be up to 65535 bytes. Scan backwards.
  const minLen = 22;
  if (buf.length < minLen) return -1;
  const start = Math.max(0, buf.length - (minLen + 0xffff));
  for (let i = buf.length - minLen; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf       ZIP file bytes
 * @param {string} wantName  entry filename to extract (case-insensitive, basename match allowed)
 * @returns {Buffer|null}    the (decompressed) entry bytes, or null if not found
 */
function extractEntry(buf, wantName = 'manifest.json') {
  if (!Buffer.isBuffer(buf)) throw new Error('zip buffer required');
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not_a_zip_or_no_eocd');

  const total = buf.readUInt16LE(eocd + 10);   // total central dir records
  let cenOff  = buf.readUInt32LE(eocd + 16);   // offset of central directory
  const want = String(wantName).toLowerCase();

  let p = cenOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method     = buf.readUInt16LE(p + 10);
    const compSize   = buf.readUInt32LE(p + 20);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const locOff     = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const nameLower = name.toLowerCase();

    const isMatch = nameLower === want || nameLower.endsWith('/' + want);
    if (isMatch) {
      // Read the local header to find the actual data offset (its name/extra
      // lengths can differ from the central record's).
      if (buf.readUInt32LE(locOff) !== LOC_SIG) throw new Error('bad_local_header');
      const locNameLen  = buf.readUInt16LE(locOff + 26);
      const locExtraLen = buf.readUInt16LE(locOff + 28);
      const dataStart = locOff + 30 + locNameLen + locExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) throw new Error('truncated_zip_entry');
      const raw = buf.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(raw);            // stored
      if (method === 8) return zlib.inflateRawSync(raw);    // deflate
      throw new Error('unsupported_compression_method_' + method);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Read + parse the extension manifest.json from a ZIP buffer.
 * @returns {{version:string, name?:string, manifest_version?:number, raw:object}}
 */
function readManifestFromZip(buf) {
  const bytes = extractEntry(buf, 'manifest.json');
  if (!bytes) throw new Error('manifest_not_found');
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); }
  catch (_) { throw new Error('manifest_not_valid_json'); }
  if (!json || typeof json !== 'object') throw new Error('manifest_not_object');
  return {
    version: json.version != null ? String(json.version) : null,
    name: json.name || null,
    manifest_version: json.manifest_version || null,
    raw: json,
  };
}

module.exports = { extractEntry, readManifestFromZip };

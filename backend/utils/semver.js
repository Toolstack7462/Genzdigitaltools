'use strict';
/**
 * Tiny semantic-version comparison (no dependency, no hardcoded versions).
 * Handles "MAJOR.MINOR.PATCH" with optional extra numeric segments and an
 * optional pre-release suffix (ignored for ordering beyond basic compare).
 */

function parse(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const core = s.split(/[-+]/)[0]; // drop pre-release/build metadata
  const parts = core.split('.').map(n => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Invalid/empty versions sort lowest. */
function compareVersions(a, b) {
  const pa = parse(a), pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** true when `installed` is strictly older than `latest`. */
function isOlder(installed, latest) {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}

/**
 * The greater of two version strings, null-safe. On equal versions `a` wins (so callers can pass
 * their preferred source first). Used to resolve the effective "published" version from the newer
 * of the on-disk ZIP and the DB release row.
 */
function maxVersion(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return compareVersions(a, b) >= 0 ? a : b;
}

/** A plausible "x.y.z" version string? Used to validate manifest input. */
function isValidVersion(v) {
  return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.\-]+)?$/.test(String(v || '').trim().replace(/^v/i, ''));
}

/**
 * Chrome's manifest "version" rules: one to four dot-separated integers, each 0–65535, no
 * leading zeros, not all zero, no suffix. Chrome refuses to load anything else, so a published
 * release (and a minimum-required version, which is compared against installed manifests) must
 * use exactly this form. Ordering is numeric per segment with missing segments = 0, which is
 * what compareVersions already does.
 */
function isValidChromeVersion(v) {
  const s = String(v == null ? '' : v);
  if (!/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(s)) return false;
  const parts = s.split('.').map(Number);
  if (parts.some(n => n > 65535)) return false;
  return parts.some(n => n > 0);
}

module.exports = { compareVersions, isOlder, isValidVersion, isValidChromeVersion, maxVersion, parse };

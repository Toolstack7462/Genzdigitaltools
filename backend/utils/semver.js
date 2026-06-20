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

/** A plausible "x.y.z" version string? Used to validate manifest input. */
function isValidVersion(v) {
  return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.\-]+)?$/.test(String(v || '').trim().replace(/^v/i, ''));
}

module.exports = { compareVersions, isOlder, isValidVersion, parse };

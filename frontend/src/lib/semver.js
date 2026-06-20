// Tiny semantic-version comparison (mirrors backend/utils/semver.js).
// Used so 3.9.1 is correctly detected as older than 3.9.3 (never string compare).
function parse(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const core = s.split(/[-+]/)[0];
  const parts = core.split('.').map(n => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const pa = parse(a), pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// true when `installed` is strictly older than `latest`.
export function isOlder(installed, latest) {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}

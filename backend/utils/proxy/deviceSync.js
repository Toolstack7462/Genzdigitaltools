'use strict';
/**
 * deviceSync — multi-device cookie sync for live-agent tools (WriteHuman).
 *
 * Lets the operator keep the SAME authorized account logged in on any number of PAIRED devices
 * (local PC, RDP-01, RDP-02 ...). Each device runs the lightweight cookie-sync agent; whichever
 * device supplies the NEWEST successfully verified bundle automatically becomes the active
 * source. No code change, no env change, no server reconfiguration when the login moves.
 *
 * -- Why this module exists --------------------------------------------------------------
 * The previous single-agent ingest wrote the incoming bundle STRAIGHT into the vault and only
 * verified afterwards, and it authenticated with ONE global env key (PROXY_AGENT_SYNC_KEY). Two
 * consequences bit us in production:
 *   1. A dead/stale agent could overwrite a known-good session (or flip it to session_expired)
 *      before anything checked whether its cookies actually worked.
 *   2. Losing that single env var (host incident 2026-07-03, and again ~2026-07-17) silently
 *      disabled the ENTIRE pipeline - every push answered 503 and nothing recorded the refusal,
 *      so a 38-day outage went unnoticed.
 * Device keys live in the DB (hashed), so pairing survives an env wipe, and every push now goes
 * through candidate -> verify -> atomic promote with rollback.
 *
 * -- Trusted ordering (the anti-flapping core) --------------------------------------------
 * Ordering is NOT by arrival time and NOT by any client-supplied number - both are spoofable and
 * both flap when two devices race. It is by the `iat` (issued-at) claim of the Supabase access
 * token INSIDE the candidate, which is signed by Supabase and therefore server-trustworthy.
 *   candidateIat >  activeIat  -> genuinely newer session -> verify, then promote + switch source
 *   candidateIat === activeIat -> the SAME session seen from another device -> no-op (no switch)
 *   candidateIat <  activeIat  -> a lagging device replaying an older session -> reject as stale
 * Because a switch requires a STRICTLY newer signed token, two devices holding the same session
 * can never ping-pong the active source between them.
 *
 * Security: allowlisted WriteHuman auth-cookie names only, never logs or returns cookie values or
 * tokens, masked account identity only, per-device hashed keys, replay + idempotency protection.
 */
const crypto = require('crypto');
const tools = require('./tools');
const { extractSupabaseSession } = require('./verify');
const { buildCookieHeader } = require('./cookies');

// Operational, non-sensitive error codes surfaced to the agent and the admin UI.
const CODES = {
  OK: 'OK',
  DEVICE_UNKNOWN: 'DEVICE_UNKNOWN',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  AUTH_INVALID: 'AUTH_INVALID',
  PAIRING_CODE_INVALID: 'PAIRING_CODE_INVALID',
  PAIRING_CODE_EXPIRED: 'PAIRING_CODE_EXPIRED',
  PAIRING_CODE_USED: 'PAIRING_CODE_USED',
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  REPLAY_REJECTED: 'REPLAY_REJECTED',
  NO_ALLOWED_COOKIES: 'NO_ALLOWED_COOKIES',
  CANDIDATE_SCHEMA_INVALID: 'CANDIDATE_SCHEMA_INVALID',
  COOKIE_BUNDLE_UNCHANGED: 'COOKIE_BUNDLE_UNCHANGED',
  STALE_BUNDLE: 'STALE_BUNDLE',
  STANDBY_ROUTINE_REFRESH: 'STANDBY_ROUTINE_REFRESH',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  VERIFICATION_INCONCLUSIVE: 'VERIFICATION_INCONCLUSIVE',
  PROMOTED: 'PROMOTED',
  PROMOTION_FAILED: 'PROMOTION_FAILED',
  ROLLBACK_COMPLETED: 'ROLLBACK_COMPLETED',
  ACTIVE_SOURCE_ONLY_DEVICE: 'ACTIVE_SOURCE_ONLY_DEVICE',
};

const MAX_ROLLBACKS = 2;          // bounded - encrypted session copies are sensitive at rest
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_DEVICES = 12;

// -- small helpers -----------------------------------------------------------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function timingEqHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function newDeviceId() { return 'dev_' + crypto.randomBytes(8).toString('hex'); }
function newDeviceKey() { return crypto.randomBytes(32).toString('hex'); }
// Human-typeable pairing code (no look-alike characters), single use, short TTL.
function newPairingCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += A[crypto.randomInt(0, A.length)];
  return s.slice(0, 5) + '-' + s.slice(5);
}
function cleanName(n, fallback) {
  const s = String(n == null ? '' : n).trim().replace(/[^\w .-]/g, '').slice(0, 32);
  return s || fallback;
}

/**
 * Claims we trust from the Supabase access token inside a bundle. Decoded locally without a
 * signature check, which is safe because of what each claim is used FOR: `iat` only ORDERS two
 * bundles and `sessionId` only tells one login apart from another - neither grants anything.
 * Whether the token actually works is decided by the real verification call, not here.
 *
 *   iat       - issue time. Trusted recency ordering between devices.
 *   sessionId - the GoTrue session (`session_id`). A token ROTATION keeps it; a fresh sign-in
 *               mints a new one. That is the only reliable way to tell "this machine refreshed
 *               the session we already have" from "somebody signed in again over here", and the
 *               promotion policy turns on exactly that difference.
 *
 * Returns { iat: number|null, sessionId: string|null }.
 */
function bundleTokenClaims(bundle, tool) {
  try {
    const ref = (tools.supabaseConfig(tool) || {}).projectRef;
    const header = buildCookieHeader(bundle, tools.targetHost(tool));
    const { accessToken } = extractSupabaseSession(header, ref);
    if (!accessToken) return { iat: null, sessionId: null };
    const part = String(accessToken).split('.')[1];
    if (!part) return { iat: null, sessionId: null };
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const iat = Number(json && json.iat);
    const sid = json && (json.session_id || json.sid);
    return { iat: Number.isFinite(iat) ? iat : null, sessionId: sid ? String(sid) : null };
  } catch (_) { return { iat: null, sessionId: null }; }
}

/** Back-compat shorthand for the ordering claim alone. */
function bundleTokenIat(bundle, tool) { return bundleTokenClaims(bundle, tool).iat; }

// -- device registry (stored on the primary ProxyAccount; mysqlAdapter is schemaless JSON) --
function getDevices(account) {
  const d = account && account.syncDevices;
  return Array.isArray(d) ? d : [];
}
function findDevice(account, deviceId) {
  if (!deviceId) return null;
  return getDevices(account).find(x => x && x.deviceId === deviceId) || null;
}
/** Safe public projection - never exposes keyHash or any secret. */
function publicDevice(dev, activeDeviceId, staleMs) {
  if (!dev) return null;
  const lastSeen = dev.lastSeenAt ? new Date(dev.lastSeenAt).getTime() : null;
  const ageSec = lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null;
  return {
    deviceId: dev.deviceId,
    name: dev.name || null,
    hostname: dev.hostname || null,
    agentVersion: dev.agentVersion || null,
    revoked: !!dev.revoked,
    isActiveSource: dev.deviceId === activeDeviceId,
    pairedAt: dev.pairedAt || null,
    lastSeenAt: dev.lastSeenAt || null,
    lastSeenAgeSec: ageSec,
    online: ageSec != null && ageSec * 1000 <= staleMs,
    lastSyncAttemptAt: dev.lastSyncAttemptAt || null,
    lastSyncSuccessAt: dev.lastSyncSuccessAt || null,
    lastResultCode: dev.lastResultCode || null,
    lastError: dev.lastError || null,
    lastErrorAt: dev.lastErrorAt || null,
    syncCount: dev.syncCount || 0,
    promotionCount: dev.promotionCount || 0,
    cdp: (dev.report && dev.report.cdp) || null,
    profile: (dev.report && dev.report.profile) || null,
    chrome: !!(dev.report && dev.report.chrome),
    authCookies: dev.report && typeof dev.report.authCookies === 'number' ? dev.report.authCookies : null,
    reportAt: (dev.report && dev.report.receivedAt) || null,
  };
}

/** Create a single-use pairing code. Returns the PLAINTEXT code (shown to the admin once). */
function createPairingCode(account, name) {
  const code = newPairingCode();
  const live = (Array.isArray(account.pairingCodes) ? account.pairingCodes : [])
    .filter(c => c && !c.usedAt && new Date(c.expiresAt).getTime() > Date.now());
  const entry = {
    codeHash: sha256(code),
    name: cleanName(name, 'DEVICE'),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    usedAt: null,
  };
  account.pairingCodes = live.concat([entry]).slice(-5);
  return { code, expiresAt: entry.expiresAt, name: entry.name };
}

/**
 * Redeem a pairing code -> a new device + its one-time key.
 * Returns { ok, code, deviceId, deviceKey, name } - deviceKey is returned ONCE and never stored.
 */
function redeemPairingCode(account, code, meta) {
  const m = meta || {};
  const list = Array.isArray(account.pairingCodes) ? account.pairingCodes : [];
  const h = sha256(String(code == null ? '' : code).trim().toUpperCase());
  const entry = list.find(c => c && timingEqHex(c.codeHash, h));
  if (!entry) return { ok: false, code: CODES.PAIRING_CODE_INVALID };
  if (entry.usedAt) return { ok: false, code: CODES.PAIRING_CODE_USED };
  if (new Date(entry.expiresAt).getTime() <= Date.now()) return { ok: false, code: CODES.PAIRING_CODE_EXPIRED };

  const devices = getDevices(account);
  if (devices.filter(d => d && !d.revoked).length >= MAX_DEVICES) return { ok: false, code: CODES.DEVICE_LIMIT_REACHED };

  const deviceKey = newDeviceKey();
  const dev = {
    deviceId: newDeviceId(),
    name: entry.name,
    hostname: cleanName(m.hostname, '') || null,
    agentVersion: cleanName(m.agentVersion, '') || null,
    keyHash: sha256(deviceKey),
    pairedAt: new Date(),
    revoked: false,
    lastSeenAt: new Date(),
    lastSeq: 0,
    syncCount: 0,
    promotionCount: 0,
  };
  entry.usedAt = new Date();
  account.pairingCodes = list;
  account.syncDevices = devices.concat([dev]);
  return { ok: true, code: CODES.OK, deviceId: dev.deviceId, deviceKey, name: dev.name };
}

/** Authenticate a push. Returns { ok, code, device }. */
function authenticateDevice(account, deviceId, presentedKey) {
  const dev = findDevice(account, deviceId);
  if (!dev) return { ok: false, code: CODES.DEVICE_UNKNOWN };
  if (dev.revoked) return { ok: false, code: CODES.DEVICE_REVOKED };
  if (!timingEqHex(dev.keyHash, sha256(presentedKey || ''))) return { ok: false, code: CODES.AUTH_INVALID };
  return { ok: true, code: CODES.OK, device: dev };
}

/** Persist a mutated device back into the account's registry array. */
function putDevice(account, dev) {
  account.syncDevices = getDevices(account).map(d => (d && d.deviceId === dev.deviceId ? dev : d));
}

/**
 * Revoke a device. Refuses to revoke the device that is the CURRENT active source unless another
 * paired device could take over - revoking must never strand the working session.
 */
function revokeDevice(account, deviceId, opts) {
  const o = opts || {};
  const dev = findDevice(account, deviceId);
  if (!dev) return { ok: false, code: CODES.DEVICE_UNKNOWN };
  const activeId = account.activeSource && account.activeSource.deviceId;
  if (dev.deviceId === activeId && !o.force) {
    const others = getDevices(account).filter(d => d && !d.revoked && d.deviceId !== deviceId);
    if (!others.length) {
      return {
        ok: false,
        code: CODES.ACTIVE_SOURCE_ONLY_DEVICE,
        message: 'This device is the current active cookie source and no other paired device could take over. The stored session stays in use; pair a replacement device first, or force the revoke.',
      };
    }
  }
  dev.revoked = true;
  dev.revokedAt = new Date();
  putDevice(account, dev);
  // NOTE: the active cookie bundle is deliberately LEFT INTACT - a revoked device loses the
  // right to WRITE, it does not invalidate the session it previously supplied.
  return { ok: true, code: CODES.OK };
}

module.exports = {
  CODES, MAX_ROLLBACKS, PAIRING_TTL_MS, MAX_DEVICES,
  sha256, timingEqHex, cleanName, bundleTokenIat, bundleTokenClaims,
  getDevices, findDevice, publicDevice, putDevice,
  createPairingCode, redeemPairingCode, authenticateDevice, revokeDevice,
};

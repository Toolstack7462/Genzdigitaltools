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
  DEVICE_UNINSTALLED: 'DEVICE_UNINSTALLED',
  DEVICE_SUPERSEDED: 'DEVICE_SUPERSEDED',
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
  ACTIVATION_CLAIMED: 'ACTIVATION_CLAIMED',
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
/** Is a device seen recently enough to count as online? Single definition, used everywhere. */
function isOnline(dev, staleMs) {
  if (!dev || !dev.lastSeenAt) return false;
  return (Date.now() - new Date(dev.lastSeenAt).getTime()) <= staleMs;
}
/**
 * Superseded = the SAME machine enrolled again under a new device id (reinstalling the agent mints
 * a fresh id), leaving an older row behind. The old row is kept for history but must never receive
 * a command or be treated as a real target.
 *
 * This used to live inline in the admin agent-state route, which meant the COMMAND path had no
 * concept of "superseded" at all and would happily dispatch to a dead duplicate. One definition,
 * shared by the dashboard and the router, is the fix.
 */
function isSupersededDevice(account, dev, staleMs) {
  if (!dev || dev.revoked) return false;
  const activeId = account && account.activeSource && account.activeSource.deviceId;
  if (dev.deviceId === activeId) return false;
  if (isOnline(dev, staleMs)) return false;
  return getDevices(account).some(o => o && !o.revoked && o.deviceId !== dev.deviceId
    && (o.name || '') === (dev.name || '')
    && o.lastSeenAt && dev.lastSeenAt && new Date(o.lastSeenAt) > new Date(dev.lastSeenAt));
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
    // NOTE: `lastError` / `lastErrorAt` are defined ONCE, below, as report-first with a fallback to
    // the record-level value. They used to appear twice in this literal — the record-level pair
    // here and the report-native pair below — so the record-level values were silently dead.
    syncCount: dev.syncCount || 0,
    promotionCount: dev.promotionCount || 0,
    cdp: (dev.report && dev.report.cdp) || null,
    profile: (dev.report && dev.report.profile) || null,
    autoRegistered: !!dev.autoRegistered,
    authState: dev.authState || null,
    // Terminal-state bookkeeping, so the admin list can tell "an admin revoked this" from "the
    // software was removed" from "this row is a dead duplicate of a machine that re-enrolled".
    uninstalledAt: dev.uninstalledAt || null,
    revokedAt: dev.revokedAt || null,
    supersededBy: dev.supersededBy || null,
    supersededAt: dev.supersededAt || null,
    demotedAt: dev.demotedAt || null,
    hasCredential: !!dev.keyHash,
    chrome: !!(dev.report && dev.report.chrome),
    authCookies: dev.report && typeof dev.report.authCookies === 'number' ? dev.report.authCookies : null,
    reportAt: (dev.report && dev.report.receivedAt) || null,
    // Report-native aliases so the admin "Agent diagnostics" panel (which reads host/version/
    // uptimeSec/pollCount/lastError/receivedAt from `state.agent`) renders real values instead of
    // "—". The panel binds `state.agent` to this active-device view; without these it only saw the
    // record-level `hostname`/`agentVersion` under different names and had no uptime field at all.
    host: (dev.report && dev.report.host) || dev.hostname || null,
    version: (dev.report && dev.report.version) || dev.agentVersion || null,
    uptimeSec: dev.report && typeof dev.report.uptimeSec === 'number' ? dev.report.uptimeSec : null,
    pollCount: dev.report && typeof dev.report.pollCount === 'number' ? dev.report.pollCount : null,
    lastError: (dev.report && dev.report.lastError) || dev.lastError || null,
    lastErrorAt: (dev.report && dev.report.lastErrorAt) || dev.lastErrorAt || null,
    errorCount: (dev.report && dev.report.errorCount) || 0,
    receivedAt: (dev.report && dev.report.receivedAt) || dev.lastSeenAt || null,
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
  if (liveDevices(account).length >= MAX_DEVICES) return { ok: false, code: CODES.DEVICE_LIMIT_REACHED };

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

/**
 * Self-registration: an agent holding the shared ingest key introduces itself with an id it
 * generated locally, and is recorded without any approval step.
 *
 * This is the normal path now. Manual pairing still exists underneath (createPairingCode /
 * redeemPairingCode / per-device keys) and still works, so a rollback needs no code change - but
 * an operator installing the agent on a new machine should not have to go and fetch a code first.
 *
 * What self-registration deliberately does NOT relax: the device row is still created, so every
 * later guarantee is unchanged - one-time activation claim on first verified sync, candidate
 * verification before promotion, per-device revocation, replay and idempotency tracking. The row
 * carries no keyHash because the shared key is what authenticated it; `autoRegistered` records
 * that, so the admin can tell a self-registered agent from a hand-paired one.
 *
 * The trust boundary is honest about itself: anyone holding the shared key can register an agent
 * and OFFER a candidate. They cannot replace the live session with it - the candidate still has to
 * authenticate as the expected account - so the worst case is a rejected upload, not a takeover.
 */
function autoRegisterDevice(account, agentId, meta) {
  const m = meta || {};
  const id = String(agentId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { ok: false, code: CODES.AUTH_INVALID };

  const existing = findDevice(account, id);
  if (existing) {
    if (existing.revoked) return { ok: false, code: CODES.DEVICE_REVOKED };
    // A reinstall on a machine whose row was retired must not silently reanimate that row. The
    // agent is expected to have archived its old identity and enrolled a NEW one; refusing here is
    // what makes "a revoked device is never silently un-revoked" true on the server side as well.
    if (existing.uninstalledAt) return { ok: false, code: CODES.DEVICE_UNINSTALLED };
    if (existing.supersededBy) return { ok: false, code: CODES.DEVICE_SUPERSEDED };
    // Keep the cosmetic fields current - a machine may be renamed or the agent upgraded.
    if (m.hostname) existing.hostname = cleanName(m.hostname, existing.hostname || '') || existing.hostname;
    if (m.agentVersion) existing.agentVersion = cleanName(m.agentVersion, existing.agentVersion || '') || existing.agentVersion;
    if (!existing.name && m.hostname) existing.name = cleanName(m.hostname, id.slice(0, 12));
    putDevice(account, existing);
    return { ok: true, code: CODES.OK, device: existing, created: false };
  }

  const live = liveDevices(account).length;
  if (live >= MAX_DEVICES) return { ok: false, code: CODES.DEVICE_LIMIT_REACHED };

  // Issue this agent its OWN key at enrolment and hand it back exactly once.
  //
  // The shared key is then only a BOOTSTRAP credential: it gets an agent through the door, and
  // from the next request onward the agent authenticates as itself. That matters for the property
  // the shared key cannot give on its own - revoking one machine without rotating the secret every
  // other machine is using. It also shrinks the blast radius of a leaked shared key to "someone
  // could enrol an agent", which still cannot replace the live session because a candidate must
  // pass account verification regardless.
  const issuedKey = newDeviceKey();
  const dev = {
    deviceId: id,
    name: cleanName(m.hostname, id.slice(0, 12)),
    hostname: cleanName(m.hostname, '') || null,
    agentVersion: cleanName(m.agentVersion, '') || null,
    keyHash: sha256(issuedKey),
    autoRegistered: true,
    pairedAt: new Date(),
    revoked: false,
    lastSeq: 0,
    syncCount: 0,
    promotionCount: 0,
  };
  account.syncDevices = getDevices(account).concat([dev]);
  return { ok: true, code: CODES.OK, device: dev, created: true, issuedKey };
}

/**
 * Authenticate a push. Returns { ok, code, device }.
 *
 * `uninstalledAt` is checked alongside `revoked` because they mean the same thing to this gate: the
 * machine has no standing to write. They are kept as separate states because they are separate
 * FACTS — an admin took the access away vs. the operator removed the software — and the reinstall
 * path treats them differently.
 */
function authenticateDevice(account, deviceId, presentedKey) {
  const dev = findDevice(account, deviceId);
  if (!dev) return { ok: false, code: CODES.DEVICE_UNKNOWN };
  // Most specific reason first, so the agent's stand-down message names what actually happened.
  if (dev.uninstalledAt) return { ok: false, code: CODES.DEVICE_UNINSTALLED };
  if (dev.supersededBy) return { ok: false, code: CODES.DEVICE_SUPERSEDED };
  if (dev.revoked) return { ok: false, code: CODES.DEVICE_REVOKED };
  if (!timingEqHex(dev.keyHash, sha256(presentedKey || ''))) return { ok: false, code: CODES.AUTH_INVALID };
  return { ok: true, code: CODES.OK, device: dev };
}

/**
 * Record whether this device currently holds a working WriteHuman session.
 *
 * THIS USED TO MINT A ONE-TIME "ACTIVATION CLAIM" that let a device seize the active source on its
 * own, the first time it went from signed-out to signed-in. It was well intentioned — it was the
 * only signal that could see the same session being copied onto a second machine — but it is
 * exactly the auto-handover the source policy now forbids: signing out and back in on a standby
 * (or a browser dropping and restoring its cookies) handed that machine the live session with
 * nobody asking for it, which is source ping-pong through a side door.
 *
 * Moving between machines is now an explicit, addressed, verified transaction (see activation.js).
 * So this function records a FACT for the dashboard and the health signals, and grants nothing.
 */
function noteDeviceAuthState(device, isAuthenticated, now) {
  const at = now || new Date();
  const prev = device.authState || null;
  device.authState = isAuthenticated ? 'authenticated' : 'unauthenticated';
  if (device.authState !== prev) device.authStateAt = at;
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
    const others = liveDevices(account).filter(d => d.deviceId !== deviceId);
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

/**
 * The agent on that machine reported its own uninstall.
 *
 * Distinct from revoke on purpose. Revoke is something an admin does TO a machine and is a
 * statement about trust; uninstall is something the operator did ON the machine and is a statement
 * about presence. Both stop the device writing, but only uninstall clears `activeSourceId`:
 *
 *   - the software is gone, so nothing on that machine will ever refresh the session again, and
 *     leaving the pointer aimed at it is the exact contradiction ("active source" that cannot act)
 *     the revoke path had to be fixed for;
 *   - and NOTHING is auto-selected in its place. The last verified bundle keeps serving, the
 *     dashboard says there is no active source, and a human picks the next one with Mark Active.
 *     An automatic fallback here is how a machine nobody chose ends up supplying the session.
 */
function markUninstalled(account, deviceId, opts) {
  const o = opts || {};
  const dev = findDevice(account, deviceId);
  if (!dev) return { ok: false, code: CODES.DEVICE_UNKNOWN };
  const now = o.now || new Date();
  dev.uninstalledAt = now;
  dev.uninstallReason = o.reason ? String(o.reason).slice(0, 80) : null;
  // The credential dies with the installation. A reinstall enrols a NEW identity; it must never be
  // able to reuse this row's key, which is still sitting in this machine's old creds file until
  // the uninstaller wipes it (and might not be, if the uninstall was interrupted).
  dev.keyHash = null;
  dev.revoked = true;
  dev.revokedAt = dev.revokedAt || now;
  putDevice(account, dev);

  let activeSourceCleared = false;
  if (account.activeSource && account.activeSource.deviceId === deviceId) {
    account.activeSource = null;
    activeSourceCleared = true;
  }
  // The stored session is untouched: uninstalling the agent does not sign anybody out.
  return { ok: true, code: CODES.OK, activeSourceCleared, bundlePreserved: !!account.sessionEncrypted };
}

/**
 * Mark older rows for the same machine as SUPERSEDED by a new enrolment.
 *
 * Reinstalling after a revoke mints a brand-new device id, so the old row would otherwise linger
 * as a second entry for one physical machine — visible in the list, countable against the device
 * limit, and (before the shared `isSupersededDevice` rule) addressable by the command router.
 * Recording the supersession explicitly, rather than inferring it from names and timestamps, means
 * the fact survives a rename and cannot be un-inferred by a stale heartbeat.
 */
function supersedePriorDevices(account, newDeviceId, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const fresh = findDevice(account, newDeviceId);
  if (!fresh) return { ok: false, code: CODES.DEVICE_UNKNOWN, superseded: [] };
  const match = (d) => {
    if (!d || d.deviceId === newDeviceId || d.supersededBy) return false;
    const sameHost = (d.hostname || '') && (d.hostname || '') === (fresh.hostname || '');
    const sameName = (d.name || '') && (d.name || '') === (fresh.name || '');
    return !!(sameHost || sameName);
  };
  const superseded = [];
  getDevices(account).forEach((d) => {
    if (!match(d)) return;
    d.supersededBy = newDeviceId;
    d.supersededAt = now;
    // A superseded row keeps its history but loses its credential, so an old agent image still
    // running somewhere with that key cannot authenticate as it.
    d.keyHash = null;
    putDevice(account, d);
    superseded.push(d.deviceId);
    if (account.activeSource && account.activeSource.deviceId === d.deviceId) {
      // Same rule as uninstall: clear the pointer, select nothing automatically.
      account.activeSource = null;
    }
  });
  return { ok: true, code: CODES.OK, superseded };
}

/** Rows that still count as real, live registrations (for the device limit and the UI count). */
function liveDevices(account) {
  return getDevices(account).filter(d => d && !d.revoked && !d.uninstalledAt && !d.supersededBy);
}

module.exports = {
  CODES, MAX_ROLLBACKS, PAIRING_TTL_MS, MAX_DEVICES,
  sha256, timingEqHex, cleanName, bundleTokenIat, bundleTokenClaims,
  getDevices, findDevice, publicDevice, putDevice, isOnline, isSupersededDevice, liveDevices,
  createPairingCode, redeemPairingCode, authenticateDevice, revokeDevice, autoRegisterDevice,
  markUninstalled, supersedePriorDevices, noteDeviceAuthState,
};

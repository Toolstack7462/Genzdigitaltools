'use strict';
/**
 * candidateSync — the two-phase cookie write for live-agent tools.
 *
 *   ACTIVE bundle (untouched)
 *        |
 *        +-- device pushes cookies --> CANDIDATE (staged, encrypted, never served)
 *                                          |
 *                                    verify in isolation
 *                                    /                \
 *                          valid + newer            invalid / older
 *                                |                        |
 *                     ATOMIC PROMOTE + switch        REJECT - active bundle
 *                     source (rollback kept)         stays exactly as it was
 *
 * The rule that makes this safe: a candidate NEVER touches account.sessionEncrypted until it has
 * independently proved it can authenticate as the expected account. A failed candidate also never
 * downgrades the live session's status - a dead device pushing dead cookies is the device's
 * problem, not the session's. That is the difference from the old ingest, which wrote first and
 * asked questions afterwards.
 *
 * Never logs or returns cookie values, tokens, or the full account email.
 */
const ProxyLease = require('../../models/proxy/ProxyLease');
const vaultCrypto = require('./vaultCrypto');
const tools = require('./tools');
const healthAlerts = require('./healthAlerts');
const { verifyAccountCookies } = require('./verify');
const { buildSessionMeta } = require('./applySession');
const {
  normalizeCookieBundle, buildCookieHeader, hasSessionCookie,
  supabaseAuthCookies, authCookieHash, replaceAuthCookies, cookieNames,
} = require('./cookies');
const {
  CODES, MAX_ROLLBACKS, bundleTokenClaims, putDevice,
  noteDeviceAuthState, hasActivationClaim, consumeActivationClaim,
  activeSourceIntentFor, clearActiveSourceIntent,
} = require('./deviceSync');

// -- single-flight: exactly one promotion in flight per account ---------------
// Two devices pushing at the same instant must not interleave read-modify-write on the vault.
// In-process serialization + the trusted-ordering check below make a late loser a no-op rather
// than a clobber. (Multi-worker: the iat ordering still rejects the older bundle, so the worst
// case is a redundant verify, never a downgrade.)
const chains = new Map();
function withAccountLock(accountId, fn) {
  const key = String(accountId);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const guarded = run.catch(() => {});
  chains.set(key, guarded);
  guarded.then(() => { if (chains.get(key) === guarded) chains.delete(key); });
  return run;
}

function decryptBundle(account) {
  try {
    return account.sessionEncrypted ? JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)) : null;
  } catch (_) { return null; }
}

/** Record the outcome of an attempt on the device row - success AND failure are both visible. */
function recordAttempt(account, device, code, opts) {
  const o = opts || {};
  const now = new Date();
  device.lastSyncAttemptAt = now;
  device.lastSeenAt = now;
  device.lastResultCode = code;
  if (o.report !== undefined) device.report = o.report;
  if (o.agentVersion) device.agentVersion = o.agentVersion;
  if (o.hostname) device.hostname = o.hostname;
  if (o.seq != null) device.lastSeq = o.seq;
  if (o.idempotencyKey) device.lastIdempotencyKey = o.idempotencyKey;
  if (o.success) {
    device.lastSyncSuccessAt = now;
    device.syncCount = (device.syncCount || 0) + 1;
    device.lastError = null;
    device.lastErrorAt = null;
  } else if (o.error) {
    device.lastError = String(o.error).slice(0, 200);
    device.lastErrorAt = now;
  }
  putDevice(account, device);
  // Account-level liveness: ANY paired device reporting in keeps the fleet "seen".
  account.lastAgentSeenAt = now;
  account.lastSyncAttemptAt = now;
  account.lastSyncResultCode = code;
}

/**
 * Ingest one device's cookie push.
 *
 * @returns {Promise<{code:string, promoted:boolean, changed:boolean, bundleVersion:number,
 *                    activeSource:object|null, maskedId:string|null, verifyResult:string|null}>}
 */
async function ingestCandidate(account, tool, device, rawCookies, opts) {
  const o = opts || {};
  return withAccountLock(account._id, async () => {
    const ref = (tools.supabaseConfig(tool) || {}).projectRef;
    const host = tools.targetHost(tool);
    const now = new Date();

    const fail = async (code, error) => {
      recordAttempt(account, device, code, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, error: error || code });
      account.candidate = {
        deviceId: device.deviceId, deviceName: device.name || null,
        receivedAt: now, status: 'rejected', code, hash: null,
      };
      await account.save();
      return { code, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId: null, verifyResult: null };
    };

    // -- 1. allowlist: ONLY the WriteHuman Supabase auth cookies, nothing else ever leaves a
    //       device or enters the vault. An empty result can never wipe the stored session.
    const incoming = normalizeCookieBundle(rawCookies);
    if (!incoming || !Array.isArray(incoming.cookies) || !incoming.cookies.length) return fail(CODES.CANDIDATE_SCHEMA_INVALID);
    const incomingAuth = supabaseAuthCookies(incoming, ref);
    if (!incomingAuth.length) return fail(CODES.NO_ALLOWED_COOKIES);

    // -- 2. build the candidate: replace (never merge) the auth cookies onto the stored bundle,
    //       so non-auth cookies the operator saved by hand survive.
    const activeBundle = decryptBundle(account);
    const candidate = replaceAuthCookies(activeBundle || { cookies: [] }, incomingAuth, ref);
    if (!hasSessionCookie(candidate)) return fail(CODES.NO_ALLOWED_COOKIES);

    const candidateHash = authCookieHash(candidate, ref);
    const activeHash = activeBundle ? authCookieHash(activeBundle, ref) : null;
    const candClaims = bundleTokenClaims(candidate, tool);
    const activeClaims = activeBundle ? bundleTokenClaims(activeBundle, tool) : { iat: null, sessionId: null };
    const candIat = candClaims.iat;
    const activeIat = activeClaims.iat;

    // -- 3. unchanged -> cheap liveness only. No decrypt-verify-write cycle, no source switch.
    if (candidateHash && activeHash && candidateHash === activeHash && !o.force) {
      recordAttempt(account, device, CODES.COOKIE_BUNDLE_UNCHANGED, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, success: true });
      await account.save();
      return { code: CODES.COOKIE_BUNDLE_UNCHANGED, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId: null, verifyResult: null };
    }

    // -- 4. TRUSTED ORDERING. Reject a bundle older than the one already active. This is what
    //       stops a lagging device from dragging the account back to a stale session.
    if (!o.force && candIat != null && activeIat != null && candIat < activeIat) {
      return fail(CODES.STALE_BUNDLE);
    }

    // -- 4b. PROMOTION POLICY. "Newest verified wins" is not good enough: two machines both signed
    //        in and both rotating would trade the active-source title back and forth forever, and
    //        every handover revokes client leases. So the ACTIVE SOURCE IS STICKY, and only four
    //        things move it:
    //          (a) nothing holds it yet;
    //          (b) an admin pressed "Make active" for this device;
    //          (c) the active session has FAILED - failover to a verified standby;
    //          (d) a genuinely FRESH SIGN-IN happened on this device.
    //        (d) is the subtle one. A token rotation and a fresh sign-in both produce a newer
    //        `iat`, so recency cannot tell them apart - but a rotation keeps the GoTrue
    //        `session_id` and a sign-in mints a new one. "Fresh" therefore means a session id the
    //        SERVER HAS NEVER SEEN. Every session that arrives is remembered, so an unseen session
    //        is adopted exactly ONCE and every later rotation of it is routine.
    //
    //        Remembering per-account rather than per-device is deliberate. Comparing against what
    //        a device reported LAST cannot answer the first push from a newly paired machine, and
    //        comparing against the active session alone re-fires forever: a standby signed into a
    //        different session would look "fresh" on every single rotation and flip the title back
    //        and forth, which is precisely the ping-pong being designed out. A one-time adoption
    //        followed by stability is the behaviour we want, and it still lets the operator sign
    //        in on any paired machine and have it take over on its own.
    // This device is demonstrably authenticated right now — it just produced auth cookies. If it
    // was previously signed OUT, that transition mints a one-time activation claim, which is the
    // only signal that survives the case where the SAME session is copied onto another paired
    // device (the session id is already known, so nothing else would ever let that machine take
    // over however legitimately it was set up).
    noteDeviceAuthState(device, true, now);

    const activeSource = account.activeSource || null;
    const isActiveSource = !activeSource || activeSource.deviceId === device.deviceId;
    const adminIntent = activeSourceIntentFor(account, device.deviceId, now);
    const activeFailed = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'].includes(account.session_status)
      || !account.sessionEncrypted;
    const known = Array.isArray(account.knownSessionIds) ? account.knownSessionIds : [];
    const freshSignIn = !!(candClaims.sessionId && !known.includes(candClaims.sessionId));
    const activationClaim = hasActivationClaim(device, now);

    const switchSource = !activeSource || adminIntent || activeFailed || freshSignIn || activationClaim;

    // Remember the session either way — including when the push is about to be ignored, so a
    // standby's own rotations settle into "routine" after first contact instead of re-triggering.
    const rememberSession = () => {
      if (!candClaims.sessionId || known.includes(candClaims.sessionId)) return;
      account.knownSessionIds = known.concat([candClaims.sessionId]).slice(-8);
    };

    if (!isActiveSource && !switchSource && !o.force) {
      // A standby quietly keeping its own copy fresh. Nothing to do: promoting it would churn the
      // vault and revoke leases for a session nobody is serving from.
      rememberSession();
      recordAttempt(account, device, CODES.STANDBY_ROUTINE_REFRESH, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey });
      await account.save();
      return { code: CODES.STANDBY_ROUTINE_REFRESH, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId: null, verifyResult: null };
    }

    // -- 5. stage the candidate (encrypted, never served to any client, never returned).
    account.candidate = {
      deviceId: device.deviceId, deviceName: device.name || null,
      receivedAt: now, status: 'validating', code: null,
      hash: candidateHash ? candidateHash.slice(0, 12) : null,
      encrypted: vaultCrypto.encrypt(JSON.stringify(candidate)),
    };
    await account.save();

    // -- 6. VERIFY THE CANDIDATE IN ISOLATION. Read-only: the browser on the device is the sole
    //       token rotator, so the server must never exchange the refresh token here.
    let v = null;
    try {
      const header = buildCookieHeader(candidate, host);
      v = await verifyAccountCookies(tool, header, account.expectedIdentifier, { readOnly: true });
    } catch (err) {
      return fail(CODES.VERIFICATION_INCONCLUSIVE, err && err.message);
    }

    const maskedId = (v && v.maskedId) || null;
    // Wrong account -> never promote. Compare against the configured expected identity, else
    // against the identity the currently active session last proved.
    const prevMasked = (account.verification && account.verification.maskedId) || null;
    if (v.result === 'wrong_account' || (maskedId && prevMasked && maskedId !== prevMasked && !account.expectedIdentifier)) {
      recordAttempt(account, device, CODES.ACCOUNT_MISMATCH, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, error: 'candidate belongs to a different account' });
      account.candidate = { deviceId: device.deviceId, deviceName: device.name || null, receivedAt: now, status: 'rejected', code: CODES.ACCOUNT_MISMATCH, hash: candidateHash ? candidateHash.slice(0, 12) : null, observedMaskedId: maskedId, expectedMaskedId: prevMasked };
      await account.save();
      return { code: CODES.ACCOUNT_MISMATCH, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId, verifyResult: v.result };
    }
    if (v.result === 'session_expired') return fail(CODES.SESSION_EXPIRED);
    if (v.result !== 'working') return fail(CODES.VERIFICATION_INCONCLUSIVE, v.result);

    // -- 7. ATOMIC PROMOTION. Keep the outgoing bundle as rollback FIRST.
    const prevSs = account.session_status;
    const prevEncrypted = account.sessionEncrypted || null;
    const prevMeta = account.sessionMeta || null;
    const prevHash = account.cookieHash || null;
    const prevSource = account.activeSource || null;
    const prevVersion = account.bundleVersion || 0;

    if (prevEncrypted) {
      const rolls = Array.isArray(account.rollbackBundles) ? account.rollbackBundles : [];
      rolls.push({ encrypted: prevEncrypted, hash: prevHash ? prevHash.slice(0, 12) : null, bundleVersion: prevVersion, savedAt: now, deviceId: prevSource && prevSource.deviceId });
      account.rollbackBundles = rolls.slice(-MAX_ROLLBACKS);
    }

    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(candidate));
    account.sessionMeta = buildSessionMeta(tool, candidate);
    account.cookieHash = candidateHash;
    account.bundleVersion = prevVersion + 1;
    account.lastSyncSuccessAt = now;
    account.lastVerifiedAt = now;
    account.verification = { result: 'working', maskedId, httpStatus: v.httpStatus || 200, checkedAt: now };
    account.session_status = 'working';
    if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
    if (switchSource) {
      account.activeSource = {
        deviceId: device.deviceId, name: device.name || null,
        promotedAt: now, bundleVersion: account.bundleVersion,
        hash: candidateHash ? candidateHash.slice(0, 12) : null, tokenIat: candIat,
      };
    } else if (account.activeSource) {
      account.activeSource = Object.assign({}, account.activeSource, { bundleVersion: account.bundleVersion, hash: candidateHash ? candidateHash.slice(0, 12) : null });
    }
    account.candidate = { deviceId: device.deviceId, deviceName: device.name || null, receivedAt: now, status: 'promoted', code: CODES.PROMOTED, hash: candidateHash ? candidateHash.slice(0, 12) : null };
    device.promotionCount = (device.promotionCount || 0) + 1;
    rememberSession();
    // Spend the one-time signals so the same event can never promote twice.
    if (switchSource && activationClaim) consumeActivationClaim(device, now);
    if (switchSource && adminIntent) clearActiveSourceIntent(account);
    recordAttempt(account, device, CODES.PROMOTED, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, success: true });
    await account.save();

    // -- 8. POST-PROMOTION CHECK. Read back what we actually stored and confirm it round-trips to
    //       the same auth-cookie hash - this catches a botched encrypt/serialize, which is the
    //       one failure a pre-write verify cannot see. On failure, restore the previous bundle.
    let postOk = false;
    try {
      const readBack = decryptBundle(account);
      postOk = !!(readBack && hasSessionCookie(readBack) && authCookieHash(readBack, ref) === candidateHash);
    } catch (_) { postOk = false; }

    if (!postOk) {
      account.sessionEncrypted = prevEncrypted;
      account.sessionMeta = prevMeta;
      account.cookieHash = prevHash;
      account.bundleVersion = prevVersion;
      account.activeSource = prevSource;
      account.session_status = prevSs;
      account.candidate = { deviceId: device.deviceId, deviceName: device.name || null, receivedAt: now, status: 'rejected', code: CODES.ROLLBACK_COMPLETED, hash: candidateHash ? candidateHash.slice(0, 12) : null };
      recordAttempt(account, device, CODES.PROMOTION_FAILED, { error: 'post-promotion readback mismatch' });
      await account.save();
      return { code: CODES.ROLLBACK_COMPLETED, promoted: false, changed: false, bundleVersion: prevVersion, activeSource: prevSource, maskedId, verifyResult: v.result };
    }

    // Cookies were REPLACED -> revoke in-flight leases so the next client open re-fetches the new
    // bundle instead of riding a gateway cache of the old one.
    try {
      await ProxyLease.updateMany(
        { accountId: account._id, revoked: false },
        { $set: { revoked: true, revokedReason: 'agent_sync', revokedAt: new Date() } }
      );
    } catch (_) { /* non-fatal: a stale lease self-heals within ~60s */ }

    try { healthAlerts.onVerifyApplied(account, tool, prevSs).catch(() => {}); } catch (_) {}

    return {
      code: CODES.PROMOTED, promoted: true, changed: true,
      bundleVersion: account.bundleVersion, activeSource: account.activeSource,
      maskedId, verifyResult: 'working', sourceSwitched: switchSource,
      cookieCount: cookieNames(candidate, host).length,
    };
  });
}

/**
 * A device reporting a real logout. Unlike the old ingest this does NOT unilaterally expire the
 * account: one device signing out is not evidence that the SESSION is dead, because another
 * paired device may still hold it. It is recorded, and the account is only downgraded when the
 * device saying so is the one currently supplying the active bundle.
 */
async function markDeviceLoggedOut(account, tool, device, opts) {
  const o = opts || {};
  return withAccountLock(account._id, async () => {
    const now = new Date();
    device.report = o.report !== undefined ? o.report : device.report;
    device.loggedOutAt = now;
    // Marking it signed out is what makes the next successful sign-in a TRANSITION, and therefore
    // what lets this device legitimately reclaim the active source afterwards.
    noteDeviceAuthState(device, false, now);
    recordAttempt(account, device, 'DEVICE_LOGGED_OUT', { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey });
    const activeId = account.activeSource && account.activeSource.deviceId;
    const isActiveSource = !activeId || activeId === device.deviceId;
    if (isActiveSource) {
      const prevSs = account.session_status;
      account.status = 'session_expired';
      account.session_status = 'needs_login';
      account.verification = { result: 'session_expired', maskedId: (account.verification && account.verification.maskedId) || null, httpStatus: 0, checkedAt: now };
      await account.save();
      try { healthAlerts.onVerifyApplied(account, tool, prevSs).catch(() => {}); } catch (_) {}
      return { code: 'DEVICE_LOGGED_OUT', downgraded: true };
    }
    await account.save();
    return { code: 'DEVICE_LOGGED_OUT', downgraded: false };
  });
}

module.exports = { ingestCandidate, markDeviceLoggedOut, recordAttempt, withAccountLock, decryptBundle };

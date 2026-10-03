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
  CODES, MAX_ROLLBACKS, bundleTokenClaims, putDevice, findDevice, noteDeviceAuthState,
} = require('./deviceSync');
const deviceState = require('./deviceState');
const activation = require('./activation');

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

    // -- 0. IS THIS AN ACTIVATION CAPTURE? -----------------------------------
    // `o.activation` is the already-validated transaction handed down by the route: it exists only
    // when this exact device presented the activation id AND its one-time nonce, both minted by an
    // admin pressing Mark Active on this exact device. It is a CAPABILITY, never a client claim —
    // the route validates it, this module only consumes it.
    //
    // Note what is no longer here: `o.force`. That used to be set straight from `body.force === true`
    // on the ingest request, which meant any agent holding a valid device key could ask the server
    // to bypass the unchanged-hash check, the trusted-ordering check AND the standby rule, purely
    // by putting a boolean in its own request body. Forcing is now something only the server can
    // authorise, and only inside an activation.
    const act = o.activation || null;

    const fail = async (code, error) => {
      recordAttempt(account, device, code, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, error: error || code });
      account.candidate = {
        deviceId: device.deviceId, deviceName: device.name || null,
        receivedAt: now, status: 'rejected', code, hash: null,
      };
      // An activation must always END. Failing it here is what stops the dashboard sitting on
      // "syncing" when the capture arrived but could not be promoted — the operator sees the real
      // reason, and the previous source and bundle are left exactly as they were.
      if (act) activation.fail(account, { activationId: act.activationId, code, message: error || code, now });
      await account.save();
      return { code, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId: null, verifyResult: null, activationFailed: !!act };
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

    // -- 3. WHO IS THIS DEVICE? Decided BEFORE any short-circuit, because the answer changes what
    //       every later branch means. Asking "have the cookies changed" first was subtly wrong: a
    //       standby holding the same session got COOKIE_BUNDLE_UNCHANGED, which reads as "your push
    //       was accepted and matched", when the truth is "you are not the source and this would not
    //       have been written whatever it contained".
    noteDeviceAuthState(device, true, now);

    const activeSource = account.activeSource || null;
    const isActiveSource = !!activeSource && activeSource.deviceId === device.deviceId;
    const noActiveSource = !activeSource;
    const switchSource = noActiveSource || !!act;

    const known = Array.isArray(account.knownSessionIds) ? account.knownSessionIds : [];
    const rememberSession = () => {
      if (!candClaims.sessionId || known.includes(candClaims.sessionId)) return;
      account.knownSessionIds = known.concat([candClaims.sessionId]).slice(-8);
    };

    if (!isActiveSource && !switchSource) {
      // STANDBY. Authorized, online, signed in — simply not the machine supplying the session. Its
      // cookies are recorded as non-promotable standby data and the active bundle is untouched,
      // whatever their hash, token age or session id says.
      //
      // This is the answer to "the previous Local PC/RDP kept syncing after another device became
      // active": it still talks to the server, and the server still refuses to let it write.
      rememberSession();
      device.lastStandbyRefreshAt = now;
      recordAttempt(account, device, CODES.STANDBY_ROUTINE_REFRESH, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey });
      await account.save();
      return {
        code: CODES.STANDBY_ROUTINE_REFRESH, promoted: false, changed: false,
        bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null,
        maskedId: null, verifyResult: null,
        standby: true,
        hint: 'Recorded as standby data. Only the active source may update the live session; use Mark Active to hand this machine the session.',
      };
    }

    // -- 3b. unchanged -> cheap liveness only. No decrypt-verify-write cycle, no source switch.
    //
    // ★ THE `act` EXEMPTION IS THE WHOLE MARK-ACTIVE FIX. This short-circuit is what made moving to
    //   a new RDP impossible in the most ordinary case there is: the operator signs the new machine
    //   into the SAME WriteHuman account, so its auth cookies hash IDENTICALLY to the live bundle,
    //   so every push from it returned COOKIE_BUNDLE_UNCHANGED right here — before the admin's
    //   "Make active" request was ever consulted, let alone spent. The request then expired unused,
    //   forever, however many times the button was pressed.
    //
    //   An explicit activation is a different question from "have the cookies changed". It asks
    //   "which machine is supplying this session", and the answer can legitimately change while the
    //   bytes stay identical. So an activation capture is never short-circuited: it is captured,
    //   verified and promoted on its own merits. (What it does NOT do is pointlessly rewrite the
    //   encrypted bundle when the bytes really are the same — see step 7.)
    if (candidateHash && activeHash && candidateHash === activeHash && !act) {
      recordAttempt(account, device, CODES.COOKIE_BUNDLE_UNCHANGED, { report: o.report, agentVersion: o.agentVersion, hostname: o.hostname, seq: o.seq, idempotencyKey: o.idempotencyKey, success: true });
      await account.save();
      return { code: CODES.COOKIE_BUNDLE_UNCHANGED, promoted: false, changed: false, bundleVersion: account.bundleVersion || 0, activeSource: account.activeSource || null, maskedId: null, verifyResult: null };
    }

    // -- 4. TRUSTED ORDERING. Reject a bundle older than the one already active. This is what
    //       stops a lagging device from dragging the account back to a stale session.
    //
    //       An activation capture is exempt for the same reason as step 3: the operator has named
    //       this machine, and "which machine supplies the session" is not settled by whose token
    //       was issued most recently. The capture still has to VERIFY before anything is promoted,
    //       so an activation cannot install a dead session — only a differently-sourced live one.
    if (!act && candIat != null && activeIat != null && candIat < activeIat) {
      return fail(CODES.STALE_BUNDLE);
    }

    // -- 4b. PROMOTION POLICY. Two rules, and deliberately no third.
    //
    //        (a) The ACTIVE SOURCE may refresh the active bundle. That is what being the active
    //            source means: its browser rotates the Supabase token, and the new cookies are the
    //            same session moving forward.
    //        (b) The active-source TITLE moves only through an explicit, addressed, verified
    //            ACTIVATION — an admin pressing Mark Active on one named machine — or when nothing
    //            holds the title at all (first ever device, or the holder was uninstalled).
    //
    //        WHAT WAS REMOVED, AND WHY. The old policy also handed the title over on:
    //          • `activeFailed`   — automatic failover to any verified standby when the live
    //            session looked dead. It reads as helpful and is genuinely dangerous: "the session
    //            looks dead" is often a transient verification failure, and the cure was to let a
    //            machine nobody chose start supplying the session — the definition of a fallback
    //            source being selected automatically.
    //          • `freshSignIn`    — a session id the server had never seen. A standby signed into a
    //            different WriteHuman session looked "fresh" and could seize the title.
    //          • `activationClaim`— a signed-out→signed-in transition on any device. Sign out and
    //            back in on the old machine and it took the session straight back. That is the
    //            ping-pong this policy exists to prevent, arriving through a side door.
    //        All three are auto-handovers. None of them can tell "the operator moved machines"
    //        from "a browser hiccuped", and every mistaken handover revokes live client leases.
    //        Moving the session is now a decision a human makes, once, per move — and a device
    //        that is not the active source can never take the title by uploading anything.
    //
    //        The cost is stated plainly: if the active source dies, WriteHuman keeps serving the
    //        last verified bundle and an operator must press Mark Active on a replacement. That is
    //        one click, and it is strictly better than a machine silently promoting itself.
    //
    //        The roles themselves were resolved in step 3, before any short-circuit could hide
    //        them. Everything reaching this point is either the active source refreshing its own
    //        session, an admin-authorised activation, or the bootstrap case.

    // -- 5. stage the candidate (encrypted, never served to any client, never returned).
    account.candidate = {
      deviceId: device.deviceId, deviceName: device.name || null,
      receivedAt: now, status: 'validating', code: null,
      hash: candidateHash ? candidateHash.slice(0, 12) : null,
      encrypted: vaultCrypto.encrypt(JSON.stringify(candidate)),
      activationId: act ? act.activationId : null,
    };
    if (act) activation.advance(account, { activationId: act.activationId, stage: 'VERIFYING_ACCOUNT', now });
    await account.save();

    // -- 6. VERIFY THE CANDIDATE IN ISOLATION. Read-only: the browser on the device is the sole
    //       token rotator, so the server must never exchange the refresh token here.
    //
    //       An ACTIVATION additionally asks for `canary`, which is the difference between "this
    //       JWT has not expired yet" (a local decode — all a routine push needs) and "this session
    //       really does authenticate as this account right now" (one real, non-rotating call to
    //       WriteHuman's own Supabase `/auth/v1/user`, returning the account's real identity).
    //       Handing the live session to a different machine is exactly the moment to pay for the
    //       real check rather than trust a decode, and it is read-only, so it cannot disturb the
    //       browser that owns the token.
    let v = null;
    try {
      const header = buildCookieHeader(candidate, host);
      if (act) activation.advance(account, { activationId: act.activationId, stage: 'TESTING_WRITEHUMAN', now });
      v = await verifyAccountCookies(tool, header, account.expectedIdentifier, act ? { readOnly: true, canary: true } : { readOnly: true });
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

    // Is this bundle byte-for-byte the session we are already serving? For an activation it very
    // often is — the operator signed the new machine into the same account, which is the normal way
    // to move. There is then nothing to replace: rewriting the vault would bump the version, drop a
    // redundant encrypted copy into the rollback ring and revoke every live client lease, all to
    // store the identical cookies. So an identical verified bundle switches the SOURCE METADATA and
    // leaves the encrypted bundle, its version and the client leases alone.
    const bundleIdentical = !!(candidateHash && activeHash && candidateHash === activeHash && prevEncrypted);

    if (prevEncrypted && !bundleIdentical) {
      const rolls = Array.isArray(account.rollbackBundles) ? account.rollbackBundles : [];
      rolls.push({ encrypted: prevEncrypted, hash: prevHash ? prevHash.slice(0, 12) : null, bundleVersion: prevVersion, savedAt: now, deviceId: prevSource && prevSource.deviceId });
      account.rollbackBundles = rolls.slice(-MAX_ROLLBACKS);
    }

    if (!bundleIdentical) {
      account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(candidate));
      account.sessionMeta = buildSessionMeta(tool, candidate);
      account.cookieHash = candidateHash;
      account.bundleVersion = prevVersion + 1;
    }
    account.lastSyncSuccessAt = now;
    account.lastVerifiedAt = now;
    account.verification = { result: 'working', maskedId, httpStatus: v.httpStatus || 200, checkedAt: now };
    account.session_status = 'working';
    if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
    if (act) activation.advance(account, { activationId: act.activationId, stage: 'PROMOTING', now });

    if (switchSource) {
      account.activeSource = {
        deviceId: device.deviceId, name: device.name || null,
        promotedAt: now, bundleVersion: account.bundleVersion,
        hash: candidateHash ? candidateHash.slice(0, 12) : null, tokenIat: candIat,
        // How the title was obtained, for the audit trail: an operator's explicit handover, or the
        // bootstrap case where nothing held it.
        via: act ? 'activation' : 'bootstrap',
        activationId: act ? act.activationId : null,
      };
      // DEMOTE THE PREVIOUS SOURCE explicitly. Being demoted is a fact about that machine, not an
      // absence, and recording it is what lets the dashboard show it as STANDBY (a machine that
      // held the session and no longer does) rather than as an anonymous READY device.
      if (prevSource && prevSource.deviceId && prevSource.deviceId !== device.deviceId) {
        const prevDev = findDevice(account, prevSource.deviceId);
        if (prevDev) {
          prevDev.demotedAt = now;
          prevDev.demotedInFavourOf = device.deviceId;
          putDevice(account, prevDev);
        }
      }
    } else if (account.activeSource) {
      account.activeSource = Object.assign({}, account.activeSource, { bundleVersion: account.bundleVersion, hash: candidateHash ? candidateHash.slice(0, 12) : null });
    }
    account.candidate = { deviceId: device.deviceId, deviceName: device.name || null, receivedAt: now, status: 'promoted', code: CODES.PROMOTED, hash: candidateHash ? candidateHash.slice(0, 12) : null };
    device.promotionCount = (device.promotionCount || 0) + 1;
    device.demotedAt = null;
    rememberSession();
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
      // The rollback restored the previous source, so the activation did NOT happen. Say so.
      if (act) {
        activation.fail(account, {
          activationId: act.activationId, code: CODES.ROLLBACK_COMPLETED,
          message: 'The promotion did not read back cleanly and was rolled back. The previous active source and session are unchanged.', now,
        });
      }
      await account.save();
      return { code: CODES.ROLLBACK_COMPLETED, promoted: false, changed: false, bundleVersion: prevVersion, activeSource: prevSource, maskedId, verifyResult: v.result, activationFailed: !!act };
    }

    // The transaction is only complete once a promotion has actually, verifiably happened.
    if (act) {
      activation.complete(account, {
        activationId: act.activationId, bundleVersion: account.bundleVersion, maskedId, now,
      });
      await account.save();
    }

    // Cookies were REPLACED -> revoke in-flight leases so the next client open re-fetches the new
    // bundle instead of riding a gateway cache of the old one. Skipped when the bundle is byte-for-
    // byte identical: nothing a client is holding has gone stale, so tearing down live sessions
    // would be pure disruption for a change that did not happen.
    if (!bundleIdentical) {
      try {
        await ProxyLease.updateMany(
          { accountId: account._id, revoked: false },
          { $set: { revoked: true, revokedReason: 'agent_sync', revokedAt: new Date() } }
        );
      } catch (_) { /* non-fatal: a stale lease self-heals within ~60s */ }
    }

    try { healthAlerts.onVerifyApplied(account, tool, prevSs).catch(() => {}); } catch (_) {}

    return {
      code: CODES.PROMOTED, promoted: true, changed: !bundleIdentical,
      bundleVersion: account.bundleVersion, activeSource: account.activeSource,
      maskedId, verifyResult: 'working', sourceSwitched: switchSource,
      bundleRewritten: !bundleIdentical,
      activationCompleted: !!act,
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
    // ONLY the active source's logout downgrades the account. This used to also fire when NO device
    // held the title (`!activeId`), which meant that after an uninstall or a revoke cleared the
    // pointer, any standby signing out could mark the whole account needs_login — a machine nobody
    // was serving from taking the session down with it.
    const isActiveSource = !!activeId && activeId === device.deviceId;
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

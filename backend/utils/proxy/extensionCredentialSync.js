'use strict';
/**
 * extensionCredentialSync — propagate an ALREADY-VALIDATED admin-source session into the EXISTING
 * extension-managed Tool record for a tool that also runs through the extension on its official
 * domain (today: WriteHuman on writehuman.ai).
 *
 * WHY THIS EXISTS
 * ---------------
 * WriteHuman has two independent, intentional access paths:
 *   1. the proxy/subdomain gateway flow  (ProxyAccount vault, read server-side by the gateway), and
 *   2. the extension-managed official-domain flow (a Tool record, read by the extension via
 *      GET /api/crm/extension/tools/:toolId/credentials and injected on writehuman.ai).
 * The approved admin-source cookie-sync agent already keeps path 1 fresh: it detects a natural
 * cookie rotation in the authorized source browser, verifies the source + expected account, and
 * atomically promotes the new bundle into the ProxyAccount (see candidateSync.js). Path 2 was still
 * refreshed by hand. This module closes that gap by reusing the SAME validated bundle — no second
 * agent, no second capture, no duplicate credential store, no new verification.
 *
 * WHAT IT IS NOT
 * --------------
 *  - NOT a conversion: the proxy flow is untouched; this only writes a SEPARATE, pre-existing record.
 *  - NOT a mirror of raw/untrusted input: it runs ONLY after candidateSync has promoted (i.e. the
 *    bundle already passed source-auth, expected-account identity, trusted-ordering and a
 *    post-write readback). We never see or trust a customer bundle here.
 *  - NOT a customer action: it updates the ADMIN credential record. Customers pick up the new
 *    revision lazily on their NEXT authorized fetch (standard Tool behaviour). No active customer
 *    session is force-refreshed or logged out.
 *
 * SAFETY INVARIANTS
 *  - OPT-IN + BOUND: fires only for a Tool explicitly opted in (`autoSync.enabled`) and bound to
 *    this proxy source (`autoSync.sourceProxyTool`) with an `autoSync.expectedIdentifier`. No
 *    binding, or no expected identity → refuse (fail-safe), never guess a record.
 *  - WRONG-ACCOUNT REJECTED: the promoted account's verified identity must match the Tool's bound
 *    expected identity, else refuse and record the rejection — the stored credential is left as-is.
 *  - STALE / DUPLICATE REJECTED: a bundle that is not strictly newer than what was last synced
 *    (by Supabase token `iat` when available) or whose auth-cookie hash is unchanged is a no-op.
 *  - VERIFIED-COMMIT-ONLY REVISION: credentials are written ONLY on a clean promote; the Tool
 *    model's own preSave is what bumps `credentialVersion`, so the extension's version-watch sees a
 *    new revision only after a real commit. On any failure the credential fields are not touched,
 *    so a failed sync can never be reported as a fresh valid session.
 *  - TRUTHFUL STATUS: every outcome (synced / unchanged / rejected / failed) is recorded on
 *    `tool.autoSync` for the dashboard — never a cosmetic success.
 *  - BOUNDED: one Tool lookup + at most one save per promoted rotation. No polling, no retry loop
 *    here; a transient failure is recorded and self-heals on the next verified rotation/push.
 */
const vaultCrypto = require('./vaultCrypto');
const toolsReg = require('./tools');
const verify = require('./verify');
const { extractSupabaseSession } = verify;
const { buildCookieHeader } = require('./cookies');
const { encryptCookies } = require('../encryption');
const keyedLock = require('../keyedLock');

// A failed commit or a drift is retried no more often than this on the heartbeat reconcile path, so
// a persistently failing session can never turn into aggressive re-verification.
const RECONCILE_MIN_INTERVAL_MS = 60 * 1000;
// An INCONCLUSIVE verification has two very different causes, and conflating them is what let a
// temporary outage latch this engine permanently:
//   DETERMINISTIC - the stored bundle itself cannot be proven: an 'unknown' aged/expired token, no
//     bundle, or a provider user object carrying no authoritative id. Re-asking changes nothing;
//     only a genuine browser refresh (new hash) or a Tool change can. These keep the no-respin
//     short-circuit, which is what stops a per-cycle verification spin.
//   TRANSIENT - the failure was OURS or the provider's: network, 429, 5xx, a 403 apikey answer or a
//     malformed/HTML body (all of which surface as canary 'inconclusive'), or a thrown verifier
//     error. These MUST be retried, or the sync never resumes after the provider recovers even
//     though nothing is wrong with the credential.
const TRANSIENT_INCONCLUSIVE = new Set(['canary_inconclusive', 'canary_absent', 'verify_error', 'no_verification']);
// BOUNDED retry: at most this many attempts against the SAME unchanged bundle, each one still
// spaced by RECONCILE_MIN_INTERVAL_MS and still driven only by the existing agent heartbeat /
// cookie-push events - no new polling worker, no refresh-token exchange, no extra provider traffic
// per cycle.
const TRANSIENT_MAX_TRIES = Math.max(1, Number(process.env.EXT_CRED_SYNC_TRANSIENT_TRIES || 5));
// ...and the budget refreshes once the last inconclusive is this old, so an outage longer than the
// budget still self-heals on a later heartbeat instead of waiting for a manual cookie update.
const TRANSIENT_RETRY_RESET_MS = Math.max(60 * 1000, Number(process.env.EXT_CRED_SYNC_TRANSIENT_RESET_MS || 30 * 60 * 1000));

const RESULT = { SYNCED: 'synced', OBSERVE: 'observe', UNCHANGED: 'unchanged', REJECTED: 'rejected', FAILED: 'failed', SKIPPED: 'skipped', INCONCLUSIVE: 'verification_inconclusive', AWAITING_APPROVAL: 'awaiting_approval' };
// Verification verdict buckets — an aged/unknown result is NEVER a failure AND NEVER success.
const VERIFY_FAILED = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];

/** Instant global off-switch (hPanel env), so activation can be halted without a DB edit or deploy. */
function globallyDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.EXT_CRED_SYNC_DISABLED || ''));
}

/** Decrypt the bundle the proxy pipeline just committed on the account. Never logs values. */
function committedBundle(account) {
  if (!account || !account.sessionEncrypted) return null;
  try {
    const b = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted));
    return b && Array.isArray(b.cookies) ? b : null;
  } catch (_) { return null; }
}

/** Supabase access-token `iat` of a committed bundle, or null for non-Supabase tools. */
function tokenIatOf(bundle, toolKey) {
  try {
    const cfg = toolsReg.supabaseConfig(toolKey);
    if (!cfg || !cfg.projectRef) return null;
    const header = buildCookieHeader(bundle, toolsReg.targetHost(toolKey));
    const { accessToken } = extractSupabaseSession(header, cfg.projectRef) || {};
    if (!accessToken) return null;
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1] || '', 'base64').toString('utf8'));
    return Number.isFinite(payload && payload.iat) ? payload.iat : null;
  } catch (_) { return null; }
}

/**
 * EXACT binding check (not a re-authentication, and never mask-based). candidateSync already
 * strongly verified the promoted session against the proxy account's full `expectedIdentifier`
 * before we got here; our only job is to confirm the admin bound THIS Tool to THAT same account.
 * We therefore compare exact, full, server-side keys — an account id or the full identifier — so a
 * lossy masked value can never cause a false match.
 */
function boundToAccount(bind, account) {
  const acctId = String((account && account._id) || '');
  const acctIdentity = (account && account.expectedIdentifier) || null;
  if (bind.expectedAccountId) return { ok: String(bind.expectedAccountId) === acctId && acctId !== '', reason: 'id' };
  if (bind.expectedIdentifier) return { ok: acctIdentity != null && String(bind.expectedIdentifier) === String(acctIdentity), reason: 'identifier' };
  return { ok: false, reason: 'unbound' };
}

/**
 * Resolve the EXACT account to bind to. Never silently pick the first of many — ambiguity is an
 * error the admin must resolve by passing an explicit accountId.
 * @returns {{account}|{error,code}}
 */
function resolveBindAccount(accounts, wantAccountId) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return { error: 'no_account', code: 'no_account' };
  if (wantAccountId) {
    const a = list.find(x => String(x._id) === String(wantAccountId));
    return a ? { account: a } : { error: 'account_not_found', code: 'account_not_found' };
  }
  if (list.length === 1) return { account: list[0] };
  const primaries = list.filter(a => a.isPrimary);
  if (primaries.length === 1) return { account: primaries[0] };
  return { error: 'ambiguous_account', code: 'ambiguous_account' };
}

/** Write the validated bundle into the SAME credential field this record already uses. */
function applyBundleToToolShape(tool, bundle) {
  const cookiesJson = JSON.stringify(bundle.cookies);
  // Unified credentials record (type-driven) → refresh its cookie payload in place.
  if (tool.credentials && tool.credentials.type === 'cookies' && 'payloadEncrypted' in tool.credentials) {
    tool.credentials.payloadEncrypted = encryptCookies(cookiesJson);
  }
  // Legacy top-level cookies field (credentialType === 'cookies').
  if (tool.credentialType === 'cookies' || tool.cookiesEncrypted) {
    tool.cookiesEncrypted = encryptCookies(cookiesJson);
  }
  // Modern session bundle — the official-domain cookie-injection path the extension version-watch
  // is keyed on. Always maintained so a cookie-injection tool has an injectable bundle.
  tool.sessionBundle = Object.assign({}, tool.sessionBundle, {
    cookiesEncrypted: encryptCookies(cookiesJson),
  });
  if (bundle.localStorage && Object.keys(bundle.localStorage).length) {
    tool.sessionBundle.localStorageEncrypted = encryptCookies(JSON.stringify(bundle.localStorage));
  }
  if (bundle.sessionStorage && Object.keys(bundle.sessionStorage).length) {
    tool.sessionBundle.sessionStorageEncrypted = encryptCookies(JSON.stringify(bundle.sessionStorage));
  }
}

/**
 * Fresh, AUTHORITATIVE server-side verification of the account's CURRENT stored bundle. Never
 * historical. Always runs the non-rotating `/auth/v1/user` CANARY (`canary:true`) so a credential
 * commit can require server-confirmed liveness (canary:'passed') + the authoritative Supabase user
 * id — not a local-JWT "working" and not the masked/cookie-supplied email. Read-only: never rotates.
 */
async function reVerifyNow(account, toolKey) {
  const bundle = committedBundle(account);
  if (!bundle) return { result: 'no_bundle' };
  try {
    const header = buildCookieHeader(bundle, toolsReg.targetHost(toolKey));
    return await verify.verifyAccountCookies(toolKey, header, account.expectedIdentifier, { readOnly: true, canary: true });
  } catch (_) { return { result: 'verify_error' }; }
}

/**
 * The single engine behind both entry points. Runs under a per-Tool in-process lock and on a
 * FRESHLY-reloaded Tool, so a late loser or an async status save can never clobber a newer record.
 * Status-only outcomes are written with an atomic `$set` on `autoSync` ALONE (credential fields are
 * never rewritten on a non-commit path); a commit is a full save so the model's preSave bumps
 * `credentialVersion` — and only then.
 *
 * @param source 'hook' (fresh promote verify supplied) | 'reconcile' (must re-verify now)
 */
/** Normalize a domain/URL to a bare, lowercased host (no scheme, no www., no port). */
function normDomain(d) {
  let h = String(d || '').trim().toLowerCase();
  try { if (h.includes('://')) h = new URL(h).hostname; } catch (_) {}
  return h.replace(/^www\./, '').replace(/:\d+$/, '');
}
function toolDomain(t) { return normDomain((t && t.domain) || (t && t.targetUrl) || ''); }

async function runEngine(account, toolKey, deps, source) {
  const Tool = deps && deps.Tool;
  const Policy = deps && deps.Policy;                   // dedicated policy record model (own table)
  const now = (deps && deps.now) || new Date();
  const force = !!(deps && deps.force);
  if (!Tool) return { result: RESULT.SKIPPED, code: 'no_model' };
  if (!Policy) return { result: RESULT.SKIPPED, code: 'no_policy_model' };
  if (globallyDisabled()) return { result: RESULT.SKIPPED, code: 'globally_disabled' };

  // The POLICY lives in its OWN record (ExtAutoSyncPolicy), keyed by the approved source account —
  // deliberately NOT on the ProxyAccount, because the hardened agent pipeline whole-record-saves the
  // account and would otherwise restore a stale policy (undoing an admin disable/rebind). It is thus
  // independent of Tool records too (survives Tool delete/recreate). Idle unless an admin EXPLICITLY
  // enabled it; a deliberate disable is respected and never auto-re-enabled (the engine only ever
  // writes the policy's `sync` sub-object; control fields are written solely by the admin endpoint).
  let policy;
  try { policy = await Policy.findOne({ accountId: String(account._id), tool: toolKey }); }
  catch (_) { return { result: RESULT.SKIPPED, code: 'policy_lookup_failed' }; }
  if (!policy || policy.enabled !== true) return { result: RESULT.SKIPPED, code: policy && policy.disabledExplicitly ? 'policy_disabled' : 'policy_idle' };
  const officialDomain = normDomain(policy.officialDomain || toolsReg.targetHost(toolKey));
  const policyId = String(policy._id);

  return keyedLock.withLock('extAutoSync:acct:' + String(account._id), async () => {
    const persistPolicy = async (patch) => {
      const nextSync = Object.assign({}, policy.sync || {}, patch);
      policy.sync = nextSync;
      try { if (typeof Policy.updateJsonPath === 'function') await Policy.updateJsonPath(policyId, 'sync', nextSync); } catch (_) { /* non-fatal; next cycle re-reports */ }
      return { result: patch.lastResult, code: patch.code || null, toolId: patch.eligibleToolId || null, bundleVersion: patch.bundleVersion || null };
    };

    // DYNAMIC eligibility — resolve the single ACTIVE extension Tool on the normalized official
    // domain. NEVER by id. 0 → safely idle (never create a Tool). >1 → ambiguity, STOP (never guess).
    let eligible;
    try { eligible = (await Tool.find({ status: 'active' })).filter(t => toolDomain(t) === officialDomain); }
    catch (e) { return persistPolicy({ lastResult: RESULT.FAILED, lastError: 'lookup_failed', lastFailureAt: now }); }
    if (eligible.length === 0) return persistPolicy({ lastResult: 'idle', lastError: null, lastCheckedAt: now, eligibleToolId: null });
    if (eligible.length > 1) return persistPolicy({ lastResult: 'ambiguous', lastError: 'multiple_eligible_tools', lastFailureAt: now, eligibleToolId: null, eligibleCount: eligible.length });

    const tool = eligible[0];
    const toolIdStr = String(tool._id);
    const st = policy.sync || {};

    if (tool.status && tool.status !== 'active') return persistPolicy({ lastResult: RESULT.FAILED, lastError: 'tool_inactive', lastFailureAt: now, eligibleToolId: toolIdStr });

    const bundle = committedBundle(account);
    if (!bundle || !bundle.cookies.length) return persistPolicy({ lastResult: RESULT.FAILED, lastError: 'no_committed_bundle', lastFailureAt: now, eligibleToolId: toolIdStr });

    const candHash = account.cookieHash || null;
    const candIat = tokenIatOf(bundle, toolKey);
    const deviceId = (deps && deps.deviceId) || (account.activeSource && account.activeSource.deviceId) || null;
    // "In sync" ONLY if the same bundle was last committed TO THIS SAME Tool. A recreated Tool has a
    // new id, so even an unchanged account bundle is NOT in sync with it → it gets a fresh commit.
    const committedInSync = !!(candHash && st.syncedHash === candHash && st.syncedToolId === toolIdStr);

    let v;
    if (source === 'hook') {
      // A promote changed the stored bundle. Do our OWN authoritative (canary) verify — do NOT trust
      // the proxy promote's verdict, which may be a local-JWT 'working' with no server canary.
      v = await (deps.reVerify ? deps.reVerify(account, toolKey) : reVerifyNow(account, toolKey));
    } else {
      if (committedInSync && !st.pending) return persistPolicy({ lastResult: RESULT.UNCHANGED, lastCheckedAt: now, eligibleToolId: toolIdStr });
      // ISSUE-B GUARD: never re-verify the SAME stored bundle every cycle. We only (re)verify when the
      // stored bundle actually CHANGED (a genuine browser refresh → candidateSync promote → new hash)
      // or when a prior commit is pending. An unchanged, already-checked (aged) bundle is a cheap
      // no-op until it refreshes — so we never spin inconclusive verifications.
      if (!force && !st.pending && candHash && st.lastCheckedHash === candHash && st.lastCheckedToolId === toolIdStr && st.lastResult === RESULT.INCONCLUSIVE) {
        // Same stored bundle + same eligible tool + already inconclusive. Whether re-verifying can
        // possibly help depends on WHY it was inconclusive, so the reason decides:
        const transient = TRANSIENT_INCONCLUSIVE.has(String(st.inconclusiveReason || ''));
        const budgetStale = !st.lastInconclusiveAt || (now - new Date(st.lastInconclusiveAt).getTime()) >= TRANSIENT_RETRY_RESET_MS;
        const spent = !budgetStale && Number(st.transientTries || 0) >= TRANSIENT_MAX_TRIES;
        if (!transient || spent) {
          // Deterministic (aged/invalid data), or the bounded budget is spent for now → wait for a
          // genuine refresh (new bundle) or a tool change. No per-cycle respin.
          return persistPolicy({ lastResult: RESULT.INCONCLUSIVE, lastCheckedAt: now, eligibleToolId: toolIdStr });
        }
        // Transient with budget remaining → fall through to the throttle and re-verify, so the
        // commit happens by itself once the provider answers again. No manual cookie update and no
        // second source login are needed.
      }
      if (!force && !st.pending && st.lastReconcileAt && (now - new Date(st.lastReconcileAt).getTime()) < RECONCILE_MIN_INTERVAL_MS) {
        // Preserve a prior INCONCLUSIVE instead of reporting UNCHANGED: the state really is still
        // unproven, and calling it "unchanged" would hide a transient retry that is still pending.
        const keep = st.lastResult === RESULT.INCONCLUSIVE ? RESULT.INCONCLUSIVE : RESULT.UNCHANGED;
        return persistPolicy({ lastResult: keep, lastCheckedAt: now, eligibleToolId: toolIdStr });
      }
      v = await (deps.reVerify ? deps.reVerify(account, toolKey) : reVerifyNow(account, toolKey));
    }

    const reconcileStamp = source === 'reconcile' ? { lastReconcileAt: now } : {};
    const vr = (v && v.result) || 'no_verification';
    const canaryOk = !!(v && v.canary === 'passed');          // server-confirmed via /auth/v1/user
    const accountKey = (v && v.accountKey) || null;           // authoritative, stable Supabase user id
    // Record that we have CHECKED this exact stored bundle (drives the no-respin guard above).
    const detectBase = Object.assign({
      lastDetectedAt: now, lastObservedHash: candHash, lastObservedTokenIat: candIat, lastSourceDeviceId: deviceId,
      eligibleToolId: toolIdStr, lastVerifyResult: vr, lastCanary: (v && v.canary) || null, lastCheckedHash: candHash, lastCheckedToolId: toolIdStr,
    }, reconcileStamp);

    if (vr === 'wrong_account') {
      return persistPolicy(Object.assign({ stage: 'detected', lastResult: RESULT.REJECTED, lastError: 'account_mismatch', lastFailureAt: now, wouldSync: false }, detectBase));
    }
    if (VERIFY_FAILED.includes(vr)) {
      return persistPolicy(Object.assign({ stage: 'detected', lastResult: RESULT.FAILED, lastError: 'verify_failed:' + vr, lastFailureAt: now, pending: false, wouldSync: false }, detectBase));
    }
    // CONCLUSIVE AUTH REQUIRED. Only a server-confirmed canary pass WITH an authoritative account id
    // counts as verified. A local-JWT 'working' (no canary / canary inconclusive), an 'unknown' aged
    // token, or a canary pass without an extractable account id → INCONCLUSIVE: never a commit, never
    // wouldSync, and we NEVER fall back to the masked/cookie-supplied email as the security boundary.
    if (!(vr === 'working' && canaryOk && accountKey)) {
      const why = vr === 'working' ? (canaryOk ? 'no_authoritative_account_id' : 'canary_' + ((v && v.canary) || 'absent')) : vr;
      // Count CONSECUTIVE transient attempts against the SAME stored bundle, so the retry stays
      // bounded. A changed bundle, a different eligible Tool, or a deterministic reason resets it.
      const sameBundle = !!(candHash && st.lastCheckedHash === candHash && st.lastCheckedToolId === toolIdStr);
      const transientWhy = TRANSIENT_INCONCLUSIVE.has(why);
      const transientTries = transientWhy ? ((sameBundle ? Number(st.transientTries || 0) : 0) + 1) : 0;
      return persistPolicy(Object.assign({ stage: 'verification_inconclusive', lastResult: RESULT.INCONCLUSIVE, wouldSync: false, lastError: null, lastInconclusiveAt: now, inconclusiveReason: why, transientTries }, detectBase));
    }

    // VERIFIED (server canary). Identity is the AUTHORITATIVE, stable account id (NEVER maskedId).
    // It is tied to the admin's EXPLICITLY APPROVED account — NOT trust-on-first. The admin approves
    // the authoritative id out-of-band (policy.approvedAccountKey, a control field). Until then we
    // only SURFACE the authenticated id for review; we never auto-bind, never wouldSync, never commit.
    const identity = accountKey;
    const displayId = v.maskedId || null;  // masked — display/telemetry ONLY, never the boundary
    const approved = (policy.approvedAccountKey != null && policy.approvedAccountKey !== '') ? String(policy.approvedAccountKey) : null;
    if (!approved) {
      return persistPolicy(Object.assign({ stage: 'verified', lastResult: RESULT.AWAITING_APPROVAL, wouldSync: false, lastError: null, awaitingApproval: true, observedAccountKey: identity, lastVerifiedAt: now, lastIdentity: displayId }, detectBase));
    }
    if (approved !== String(identity)) {
      // Authenticated, but NOT the approved account → reject (never commit, never overwrite, never re-approve).
      return persistPolicy(Object.assign({ stage: 'verified', lastResult: RESULT.REJECTED, lastError: 'account_not_approved', lastFailureAt: now, lastVerifiedAt: now, observedAccountKey: identity, lastIdentity: displayId, wouldSync: false }, detectBase));
    }
    const boundIdentity = approved;  // == identity, the explicitly-approved authoritative account

    // Stale guard applies only to the SAME tool (a newly bound Tool must accept the current session).
    if (candIat != null && st.syncedTokenIat != null && st.syncedToolId === toolIdStr && candIat < st.syncedTokenIat) {
      return persistPolicy(Object.assign({ stage: 'verified', lastResult: RESULT.REJECTED, lastError: 'stale_bundle', lastFailureAt: now, lastVerifiedAt: now, boundIdentity, lastIdentity: displayId, wouldSync: false }, detectBase));
    }
    if (committedInSync) {
      return persistPolicy(Object.assign({ stage: 'verified', lastResult: RESULT.UNCHANGED, pending: false, lastError: null, lastVerifiedAt: now, lastCheckedAt: now, boundIdentity, lastIdentity: displayId }, detectBase));
    }

    if ((policy.mode === 'enforce' ? 'enforce' : 'observe') === 'observe') {
      // Verified + would commit — but observe is a dry run: write NO credential.
      return persistPolicy(Object.assign({ stage: 'wouldSync', lastResult: RESULT.OBSERVE, wouldSync: true, lastError: null, lastObservedAt: now, lastVerifiedAt: now, boundIdentity, lastIdentity: displayId }, detectBase));
    }

    // -- ENFORCE commit — TARGETED + GUARDED on the resolved Tool. We write ONLY the credential paths
    //    + a bumped credentialVersion (never whole-doc, so unrelated Tool fields are preserved), and
    //    ONLY if the Tool's credentialVersion is unchanged AND it is still active (concurrency +
    //    eligibility at the DB boundary). Policy authorization lives on the account and is enforced
    //    at entry + serialized by the per-account lock the admin endpoint shares. On 0 rows we flag
    //    pending and reconcile retries only while the policy stays enabled and the Tool stays eligible.
    const failPending = (code) =>
      persistPolicy(Object.assign({ lastResult: RESULT.FAILED, lastError: code, lastFailureAt: now, pending: true, pendingSince: st.pendingSince || now, eligibleToolId: toolIdStr }, reconcileStamp));

    if (typeof Tool.patchGuarded !== 'function') return failPending('no_guarded_write'); // fail-closed

    const cookiesJson = JSON.stringify(bundle.cookies);
    const newBundle = Object.assign({}, tool.sessionBundle, {
      cookiesEncrypted: encryptCookies(cookiesJson),
      version: Number((tool.sessionBundle && tool.sessionBundle.version) || 0) + 1,
      bundleUpdatedAt: now,
    });
    if (bundle.localStorage && Object.keys(bundle.localStorage).length) newBundle.localStorageEncrypted = encryptCookies(JSON.stringify(bundle.localStorage));
    if (bundle.sessionStorage && Object.keys(bundle.sessionStorage).length) newBundle.sessionStorageEncrypted = encryptCookies(JSON.stringify(bundle.sessionStorage));

    const newVersion = Number(tool.credentialVersion || 0) + 1;
    const setMap = { sessionBundle: newBundle, credentialVersion: newVersion, credentialUpdatedAt: now };
    if (tool.credentials && tool.credentials.type === 'cookies' && Object.prototype.hasOwnProperty.call(tool.credentials, 'payloadEncrypted')) {
      setMap['credentials.payloadEncrypted'] = encryptCookies(cookiesJson);
    }
    if (tool.credentialType === 'cookies' || tool.cookiesEncrypted) setMap['cookiesEncrypted'] = encryptCookies(cookiesJson);

    const guardMap = { credentialVersion: (tool.credentialVersion == null ? null : tool.credentialVersion), status: 'active' };

    // Cross-process authorization re-check AT the commit boundary. The per-account lock serializes
    // this process; this fresh re-read of the policy catches an admin disable / rebind / mode change
    // that committed from ANOTHER process after we entered, so revoked authorization cannot permit an
    // in-flight update (leaving only a sub-millisecond window between this read and the Tool write).
    if (typeof Policy.findById === 'function') {
      let fp = null;
      try { fp = await Policy.findById(policyId); } catch (_) { return failPending('policy_reread_failed'); }
      if (!fp || fp.enabled !== true) return failPending('policy_revoked');
      if (Number(fp.policyEpoch || 0) !== Number(policy.policyEpoch || 0)) return failPending('policy_changed');
      if ((fp.mode === 'enforce' ? 'enforce' : 'observe') !== 'enforce') return failPending('policy_mode_changed');
      if (normDomain(fp.officialDomain || officialDomain) !== officialDomain) return failPending('policy_rebound');
    }

    let rows;
    try { rows = await Tool.patchGuarded(toolIdStr, setMap, guardMap); }
    catch (e) { return failPending('commit_failed'); }
    if (!rows) return failPending('commit_conflict'); // Tool version changed or it is no longer active

    // Reflect into the in-memory Tool (for any in-process reader) and record the committed policy status.
    tool.sessionBundle = newBundle;
    tool.credentialVersion = newVersion;
    tool.credentialUpdatedAt = now;
    if (setMap.cookiesEncrypted) tool.cookiesEncrypted = setMap.cookiesEncrypted;
    if (setMap['credentials.payloadEncrypted']) tool.credentials = Object.assign({}, tool.credentials, { payloadEncrypted: setMap['credentials.payloadEncrypted'] });
    await persistPolicy(Object.assign({
      stage: 'synced', lastResult: RESULT.SYNCED, lastError: null, pending: false,
      lastDetectedAt: now, lastSyncAt: now, lastVerifiedAt: now,
      syncedHash: candHash, syncedTokenIat: candIat, syncedToolId: toolIdStr,
      boundIdentity, lastIdentity: displayId, lastSourceDeviceId: deviceId, eligibleToolId: toolIdStr,
    }, reconcileStamp));
    return { result: RESULT.SYNCED, code: null, toolId: toolIdStr, bundleVersion: newVersion };
  });
}

/**
 * HOOK entry — called right after candidateSync promoted a rotation. The promote's verify is fresh,
 * so we trust it. No-op unless a Tool is opted in and bound to this source.
 * @param verifyResult { result, maskedId } from the promote
 * @param deps { Tool, now?, deviceId? }
 */
async function syncRotationToExtensionTool(account, toolKey, verifyResult, deps) {
  return runEngine(account, toolKey, Object.assign({}, deps, { verifyResult }), 'hook');
}

/**
 * RECONCILE entry — lightweight, idempotent recovery. Used by the agent heartbeat (periodic, so no
 * extra polling) and by the observe→enforce flip. It re-verifies the account's CURRENT session
 * before committing, recovers a previously-failed extension update WITHOUT waiting for another
 * natural rotation, and is a cheap no-op when already in sync.
 * @param deps { Tool, now?, deviceId?, force?, reVerify? }
 */
async function reconcileExtensionTool(account, toolKey, deps) {
  return runEngine(account, toolKey, deps || {}, 'reconcile');
}

module.exports = {
  syncRotationToExtensionTool,
  reconcileExtensionTool,
  RESULT,
  resolveBindAccount,
  normDomain,
  _internals: { boundToAccount, tokenIatOf, committedBundle, reVerifyNow, normDomain, toolDomain, RECONCILE_MIN_INTERVAL_MS, TRANSIENT_INCONCLUSIVE, TRANSIENT_MAX_TRIES, TRANSIENT_RETRY_RESET_MS },
};

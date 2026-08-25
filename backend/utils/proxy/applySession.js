'use strict';
/**
 * Shared "apply a fresh cookie bundle to a ProxyAccount vault" path.
 *
 * Extracted VERBATIM from the admin `POST /:tool/accounts/:id/session` handler so the admin
 * "Refresh session" button and the RDP Cookie Sync Agent write cookies through ONE code path:
 *   encrypt → sessionMeta → revoke stale leases (so the next open re-fetches) → auto-verify →
 *   set status/session_status/verification.
 * This is the SINGLE source of truth for a vault write. Never logs cookie values/tokens.
 */
const ProxyLease = require('../../models/proxy/ProxyLease');
const ActivityLog = require('../../models/ActivityLog');
const vaultCrypto = require('./vaultCrypto');
const tools = require('./tools');
const { verifyAndApply } = require('./verifyAndApply');
const { countCookies, cookieNames, hasSessionCookie, authCookieHash } = require('./cookies');

// Safe, non-secret metadata about the stored bundle (counts / booleans only — no values).
function buildSessionMeta(tool, bundle) {
  const host = tools.targetHost(tool);
  const ls = bundle && bundle.localStorage;
  return {
    cookieCount: Array.isArray(bundle && bundle.cookies) ? bundle.cookies.length : 0,
    attachableCount: countCookies(bundle, host),
    hasSessionCookie: hasSessionCookie(bundle),
    hasLocalStorage: !!(ls && typeof ls === 'object' && Object.keys(ls).length > 0),
    origin: (bundle && bundle.origin) || '',
    updatedAt: new Date(),
  };
}

/**
 * Encrypt + persist `bundle` into `account`, revoke its in-flight leases, and auto-verify.
 * Mutates and saves `account`. Returns { verifyResult, warning, revokedLeases, cookieNames, maskedId }.
 *
 * opts: { tool, prevMaskedId?, actorType?, actorId?, source?, ip? }
 *   source 'admin' (default) or 'agent' — only affects the lease revoke reason + activity log.
 */
async function applyAccountSession(account, bundle, opts = {}) {
  const tool = opts.tool || account.tool;
  const prevMaskedId = opts.prevMaskedId != null ? opts.prevMaskedId : (account.verification?.maskedId || null);
  const source = opts.source || 'admin';

  account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
  account.sessionMeta = buildSessionMeta(tool, bundle);
  // Keep `cookieHash` describing the bundle that is ACTUALLY stored. It used to be written only
  // by the agent ingest path, so an admin "Refresh session" left the hash describing whatever the
  // agent last pushed — possibly weeks older than the vault. A device would then compare its own
  // cookies against that stale hash and could conclude "unchanged" for a bundle the vault does
  // not hold, silently skipping a real sync. The hash must always describe the active bundle.
  //
  // GATED to live-agent tools (WriteHuman alone) because this function is the shared vault-write
  // path for EVERY proxy tool. `cookieHash` only means anything where a device compares against
  // it; for the other seven tools authCookieHash has no project ref to work with and would just
  // write null onto their accounts. Harmless, but writing to another tool's row to no purpose is
  // not a change worth making — and this keeps the blast radius provably WriteHuman-only while
  // leaving ONE vault-write path, which is what stopped the hash diverging in the first place.
  try {
    if (tools.hasLiveAgent(tool)) {
      const ref = (tools.supabaseConfig(tool) || {}).projectRef;
      account.cookieHash = authCookieHash(bundle, ref);
    }
  } catch (_) { /* the hash is an optimisation, never a correctness requirement */ }
  if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
  account.session_status = 'pending_verification';
  await account.save();

  // Cookies were just REPLACED — revoke in-flight leases bound to this account so the next
  // open mints a FRESH lease (new jti → gateway cache miss → re-fetch of the new bundle).
  let revokedLeases = 0;
  try {
    const r = await ProxyLease.updateMany(
      { accountId: account._id, revoked: false },
      { $set: { revoked: true, revokedReason: source === 'agent' ? 'agent_sync' : 'session_refreshed', revokedAt: new Date() } }
    );
    revokedLeases = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
  } catch (_) { /* non-fatal: cookies are saved; stale lease self-heals within ~60s */ }

  // Auto-verify the just-saved cookies via the shared verify->apply path (ONE place for the
  // verify->status mapping). Live-agent tools (WriteHuman) verify READ-ONLY — the browser is the
  // sole token rotator, so the server never exchanges. Other tools keep the default fast-path.
  // Best-effort; cookies are saved regardless.
  let verifyResult = null, warning = null;
  let names = cookieNames(bundle, tools.targetHost(tool));
  try {
    const r = await verifyAndApply(account, tool, { readOnly: tools.hasLiveAgent(tool), bundle });
    verifyResult = r.result; names = r.cookieNames;
    const v = r.v;
    // Claude: re-uploading the SAME identity's fresh cookies is a legitimate SESSION REFRESH
    // (the operator is updating an aged session for the same account), NOT a botched attempt to
    // switch accounts — so do NOT flag it. The new bundle is already encrypted+replaced, meta
    // (cookieCount/updatedAt) rebuilt, stale leases revoked and the session re-verified above, so
    // the outcome falls through to the real verify result (working / needs_login / session_expired
    // / unknown). Every other tool keeps the "same account as before" guard for account switches.
    // Same-account cookies are a REFRESH, not a mistake, for tools whose whole model is keeping one
    // account's session fresh (claude and every live-agent tool incl. WriteHuman). Only static-vault
    // tools, where re-capturing the same account usually means the operator grabbed the OLD account
    // by mistake while trying to switch, keep the warning.
    if (tool !== 'claude' && !tools.hasLiveAgent(tool) && v && v.maskedId && prevMaskedId && v.maskedId === prevMaskedId) warning = 'cookies_match_previous_account';
    else if (r.result === 'wrong_account') warning = 'cookies_wrong_account';
    else if (r.result === 'needs_login' || r.result === 'session_expired') warning = r.result;
    else if (r.result === 'missing_required_session_cookie') warning = 'missing_required_session_cookie';
  } catch (_) { /* verify is best-effort; the cookies are already saved + leases revoked */ }

  try {
    await ActivityLog.log(opts.actorType || 'ADMIN', opts.actorId || null, 'PROXY_ACCOUNT_SESSION_REFRESHED', {
      tool, accountId: account._id, label: account.label, revokedLeases, verifyResult, warning,
      cookieCount: names.length, source, ip: opts.ip || null,
    });
  } catch (_) { /* non-fatal */ }

  return { verifyResult, warning, revokedLeases, cookieNames: names, maskedId: account.verification?.maskedId || null };
}

module.exports = { applyAccountSession, buildSessionMeta };

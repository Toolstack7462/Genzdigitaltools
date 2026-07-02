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
const { verifyAccountCookies } = require('./verify');
const { buildCookieHeader, countCookies, cookieNames, hasSessionCookie } = require('./cookies');

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

  // Auto-verify the just-saved cookies (immediate, safe feedback). Best-effort; cookies saved regardless.
  let verifyResult = null, warning = null;
  const host = tools.targetHost(tool);
  const names = cookieNames(bundle, host);
  try {
    const cookieHeader = buildCookieHeader(bundle, host);
    if (!cookieHeader || !hasSessionCookie(bundle)) {
      account.verification = { result: 'missing_required_session_cookie', maskedId: null, httpStatus: 0, checkedAt: new Date() };
      account.status = 'session_expired'; account.session_status = 'missing_required_session_cookie';
      verifyResult = 'missing_required_session_cookie'; warning = 'missing_required_session_cookie';
    } else {
      // Agent path is READ-ONLY: never do a server-side refresh exchange (the browser is the
      // rotator). Admin path keeps the existing behavior (fast-path, or exchange when aged).
      const v = await verifyAccountCookies(tool, cookieHeader, account.expectedIdentifier, { readOnly: source === 'agent' });
      account.verification = { result: v.result, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: new Date() };
      account.lastVerifiedAt = new Date();
      if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = v.loggedOut ? 'needs_login' : 'session_expired'; }
      else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
      else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
      else if (v.result === 'unsupported') { account.status = 'blocked'; account.session_status = 'cookies_invalid'; }
      verifyResult = v.result;
      if (v.maskedId && prevMaskedId && v.maskedId === prevMaskedId) warning = 'cookies_match_previous_account';
      else if (v.result === 'wrong_account') warning = 'cookies_wrong_account';
      else if (v.result === 'session_expired') warning = v.loggedOut ? 'needs_login' : 'session_expired';
    }
    await account.save();
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

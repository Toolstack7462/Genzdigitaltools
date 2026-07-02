'use strict';
/**
 * verifyAndApply — the SINGLE canonical "verify an account's stored cookies and apply the result
 * to the account row" path. One place for the verify -> status/session_status/verification
 * mapping, used by: the admin Verify route, the on-sync write path (applyAccountSession), and the
 * periodic auto-verify scheduler. No duplicate verification logic. Never logs cookie values.
 *
 * opts:
 *   forceLive - do the live refresh-token exchange (static-vault tools; the server is the rotator).
 *   readOnly  - NEVER exchange (live-agent tools like WriteHuman; the browser is the sole rotator).
 *   bundle    - pre-decrypted bundle, to avoid a redundant decrypt when the caller already has it.
 *   skipSave  - don't persist (caller will save).
 *
 * Returns { result, effResult, v, cookieNames, cookieCount } (v is the raw verify result or null).
 */
const vaultCrypto = require('./vaultCrypto');
const tools = require('./tools');
const { verifyAccountCookies, applySupabaseRefresh } = require('./verify');
const { buildCookieHeader, countCookies, cookieNames, hasSessionCookie } = require('./cookies');

async function verifyAndApply(account, tool, opts = {}) {
  const host = tools.targetHost(tool);
  let bundle = opts.bundle || null;
  if (!bundle) { try { bundle = account.sessionEncrypted ? JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)) : null; } catch (_) { bundle = null; } }
  let cookieHeader = '';
  try { cookieHeader = buildCookieHeader(bundle, host); } catch (_) { cookieHeader = ''; }
  const names = cookieNames(bundle, host);
  const cookieCount = countCookies(bundle, host);
  const now = new Date();

  // No attachable cookie / no recognizable session cookie -> the bundle can't log in.
  if (!cookieHeader || !hasSessionCookie(bundle)) {
    account.verification = { result: 'missing_required_session_cookie', maskedId: null, httpStatus: 0, checkedAt: now };
    account.status = 'session_expired';
    account.session_status = 'missing_required_session_cookie';
    account.lastVerifiedAt = now;
    if (!opts.skipSave) await account.save();
    return { result: 'missing_required_session_cookie', effResult: 'missing_required_session_cookie', v: null, cookieNames: names, cookieCount };
  }

  const vopts = opts.forceLive ? { forceLive: true } : (opts.readOnly ? { readOnly: true } : {});
  const v = await verifyAccountCookies(tool, cookieHeader, account.expectedIdentifier, vopts);

  // session_expired splits into needs_login (a logged-out shell loaded) vs plain expiry.
  const effResult = (v.result === 'session_expired' && v.loggedOut) ? 'needs_login' : v.result;
  account.verification = { result: effResult, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: now };
  account.lastVerifiedAt = now;
  if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = v.loggedOut ? 'needs_login' : 'session_expired'; }
  else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
  else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
  else if (v.result === 'unsupported') { account.status = 'blocked'; account.session_status = 'cookies_invalid'; }
  // 'unknown' (transient network / read-only aged token): never downgrade a live session; only
  // lift a previously-expired one back to pending so it re-checks. Leaves working as working.
  else if (v.result === 'unknown') { if (account.session_status === 'session_expired') account.session_status = 'pending_verification'; }

  // forceLive success ROTATED the tokens -> persist them so the account stays live. readOnly never
  // sets refreshedSession, so this is a no-op for live-agent tools (no rotation, no competition).
  if (opts.forceLive && v.result === 'working' && v.refreshedSession && bundle) {
    try {
      const ref = (tools.supabaseConfig(tool) || {}).projectRef;
      const updated = applySupabaseRefresh(bundle, ref, v.refreshedSession);
      if (updated) {
        account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(updated));
        account.sessionMeta = Object.assign({}, account.sessionMeta || {}, { updatedAt: now });
      }
    } catch (_) { /* persist is best-effort; the verify result still stands */ }
  }

  if (!opts.skipSave) await account.save();
  return { result: effResult, effResult, v, cookieNames: names, cookieCount };
}

module.exports = { verifyAndApply };

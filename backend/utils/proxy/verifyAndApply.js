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
 *   canary    - with a still-valid access token, prove the session with a REAL non-rotating
 *               authenticated call instead of trusting a local JWT decode. Cheap, and the only way
 *               a read-only check can distinguish "alive" from "revoked but the JWT hasn't expired
 *               yet". Used by the manual Verify Session, the scheduler, and post-promotion.
 *   allowServerRefresh - read-only break-glass: rotate server-side when the access token has
 *               already expired AND the source cannot rotate it. Also requires
 *               WRITEHUMAN_SERVER_REFRESH=1 (see verify.js). Default off.
 *   bundle    - pre-decrypted bundle, to avoid a redundant decrypt when the caller already has it.
 *   skipSave  - don't persist (caller will save). NOTE: the caller then owns the concurrency
 *               problem too - a plain save() of its own snapshot can overwrite a bundle that
 *               another worker promoted while the provider was answering. The returned
 *               `subject` is what such a caller must guard on (see persistVerdictGuarded).
 *               No production caller passes this today, and a test pins that.
 *
 * Returns { result, effResult, v, cookieNames, cookieCount } (v is the raw verify result or null).
 */
const vaultCrypto = require('./vaultCrypto');
const tools = require('./tools');
const { verifyAccountCookies, applySupabaseRefresh } = require('./verify');
const { buildCookieHeader, countCookies, cookieNames, hasSessionCookie } = require('./cookies');
const healthAlerts = require('./healthAlerts');

// ── PERSISTING A VERDICT THAT MAY HAVE BEEN OVERTAKEN ────────────────────────────────────────
//
// The in-memory subject check further down only catches the case where the SAME loaded document
// was mutated. Production does not work that way: two Passenger workers, or two requests in one
// worker, each hold their OWN snapshot. The verifier's object never learns that another writer
// committed a newer bundle, so the in-memory comparison sees nothing wrong and a plain
// `account.save()` replaces the WHOLE row - newer sessionEncrypted, cookieHash, bundleVersion,
// activeSource, status and verification included - with this verifier's stale snapshot. That is a
// provider round-trip's worth of window, seconds wide, on the one row the live session depends on.
//
// Neither obvious half-measure closes it: an extra SELECT before an unconditional save just moves
// the window, and an in-memory lock cannot span workers or processes.
//
// So the DATABASE decides. `patchGuarded` (the adapter's existing primitive, already used by the
// extension-credential sync) writes ONLY the named JSON paths, and only while every guard path
// still equals what this verdict was computed against. On a mismatch it reports 0 rows and we
// treat the verdict as a STALE OBSERVATION: nothing is written, nothing is rolled back, no success
// event is emitted and nothing is retried.
//
// The guard is the verification SUBJECT, which is why `subject` carries all three parts:
//   bundleVersion          a promotion of different bytes bumps it;
//   cookieHash             the bundle's own identity, independent of the counter;
//   activeSource.deviceId  a SOURCE handover that keeps the identical bundle bytes - the case a
//                          version/hash guard alone would miss entirely.
// Absent values guard on IS NULL, so static-vault tools (hix, bypassgpt, grok, ryne, claude),
// which have no agent and no activeSource, keep working unchanged.
async function persistVerdictGuarded(account, setMap, subject) {
  const model = account.__model;
  // A document from a TEST DOUBLE has no model behind it, so there is no stored row to guard
  // against and nothing to race with: fall back to the document's own save(). This is explicitly
  // NOT a production path - `the production ProxyAccount model exposes patchGuarded` pins that the
  // real model has the primitive, so a real row is always written conditionally. Without that test
  // this branch would be a silent way back to the unguarded write.
  if (!model || typeof model.patchGuarded !== 'function') {
    if (typeof account.save === 'function') await account.save();
    return true;
  }
  const guardMap = {
    bundleVersion: subject.bundleVersion,
    cookieHash: subject.cookieHash,
    'activeSource.deviceId': subject.sourceDeviceId,
  };
  const rows = await model.patchGuarded(String(account._id), setMap, guardMap);
  return rows > 0;
}

/** The exact fields a verdict is entitled to write - never the whole document. */
function verdictFields(account, extra) {
  return Object.assign({
    verification: account.verification,
    lastVerifiedAt: account.lastVerifiedAt,
    status: account.status,
    session_status: account.session_status,
  }, extra || {});
}

// Fire a health alert on a meaningful transition (live-agent tools only; fire-and-forget).
function alertTransition(account, tool, prevSs) {
  if (tools.hasLiveAgent(tool)) { try { healthAlerts.onVerifyApplied(account, tool, prevSs).catch(() => {}); } catch (_) {} }
}

async function verifyAndApply(account, tool, opts = {}) {
  const prevSs = account.session_status;
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
    const before = {
      verification: account.verification, status: account.status,
      session_status: account.session_status, lastVerifiedAt: account.lastVerifiedAt,
    };
    account.verification = { result: 'missing_required_session_cookie', maskedId: null, httpStatus: 0, checkedAt: now };
    account.status = 'session_expired';
    account.session_status = 'missing_required_session_cookie';
    account.lastVerifiedAt = now;
    // Guarded for the same reason as the post-call write: this is still a conclusion about the
    // bundle as it was READ, and a concurrent promotion may have supplied one since. Expiring an
    // account because a bundle that is no longer served had no session cookie would be wrong.
    if (!opts.skipSave) {
      const subj0 = {
        bundleVersion: (account.__originalData || {}).bundleVersion === undefined ? null : (account.__originalData || {}).bundleVersion,
        sourceDeviceId: (((account.__originalData || {}).activeSource) || {}).deviceId || null,
        cookieHash: (account.__originalData || {}).cookieHash || null,
      };
      if (!await persistVerdictGuarded(account, verdictFields(account), subj0)) {
        Object.assign(account, before);
        return { result: 'stale_subject', effResult: 'stale_subject', v: null, stale: true, subject: subj0, cookieNames: names, cookieCount };
      }
    }
    alertTransition(account, tool, prevSs);
    return { result: 'missing_required_session_cookie', effResult: 'missing_required_session_cookie', v: null, cookieNames: names, cookieCount };
  }

  const vopts = opts.forceLive ? { forceLive: true } : (opts.readOnly ? { readOnly: true } : {});
  if (opts.canary) vopts.canary = true;
  if (opts.allowServerRefresh) vopts.allowServerRefresh = true;

  // ── CAPTURE THE SUBJECT BEFORE THE PROVIDER CALL ──────────────────────────────────────
  //
  // verifyAccountCookies is an EXTERNAL round-trip and can take seconds. What it answers about
  // is the bundle decrypted above, from the source that held it THEN. If a candidate push
  // promotes a new bundle while we are awaiting, writing the result without saying what it
  // describes leaves a record that reads as proof of whatever is current when it is next
  // serialized - i.e. a passed canary for bundle 7 presented as proof of bundle 8.
  //
  // So the subject is pinned here, travels with the verdict, and is what any consumer must
  // correlate against. `cookieHash` is the bundle's own identity, which survives even if the
  // version counter is rewritten.
  // NOT normalised. These values are used verbatim as the guard, and an ABSENT JSON key guards as
  // `IS NULL`, so coercing an absent bundleVersion to 0 would compare 0 against NULL and the guard
  // could never hold. That would have broken every static-vault tool - hix, bypassgpt, grok, ryne,
  // claude - none of which has a bundleVersion, activeSource or cookieHash at all.
  const subject = {
    bundleVersion: account.bundleVersion === undefined ? null : account.bundleVersion,
    sourceDeviceId: (account.activeSource && account.activeSource.deviceId) || null,
    cookieHash: account.cookieHash || null,
  };
  const v = await verifyAccountCookies(tool, cookieHeader, account.expectedIdentifier, vopts);

  // ── GUARDED APPLY ────────────────────────────────────────────────────────────────────
  //
  // The subject moved on while we were awaiting: another worker's promotion is now the served
  // session. This verdict is about the PREVIOUS one, so it may neither authenticate the new
  // bundle nor overwrite the newer record. It is recorded as a stale observation and dropped.
  //
  // Deliberately NOT a downgrade: a late 'session_expired' about a bundle that is no longer
  // served must not expire the bundle that replaced it.
  // Compared EXACTLY as the subject was captured - no `|| 0`. Normalising here while the subject
  // holds the raw value made this fire on every account that has no bundleVersion at all (every
  // static-vault tool), reporting a stale subject when nothing had moved.
  const curBundle = account.bundleVersion === undefined ? null : account.bundleVersion;
  const movedOn = curBundle !== subject.bundleVersion
    || (account.cookieHash || null) !== subject.cookieHash
    || (((account.activeSource && account.activeSource.deviceId) || null) !== subject.sourceDeviceId);
  if (movedOn) {
    return {
      result: 'stale_subject', effResult: 'stale_subject', v: null, stale: true,
      subject, cookieNames: names, cookieCount,
    };
  }

  // session_expired splits into needs_login (a logged-out shell loaded) vs plain expiry.
  const effResult = (v.result === 'session_expired' && v.loggedOut) ? 'needs_login' : v.result;
  // RECORD HOW IT WAS PROVEN, not just the verdict. `result:'working'` is written both by a real
  // non-rotating /auth/v1/user canary and by a bare local JWT decode, and those are not the same
  // evidence: a Supabase access token stays exp-valid for about an hour after its session is
  // gone. Without this field nothing downstream can tell the two apart, so a decode could be
  // presented as authentication proof. 'passed' | 'failed' | 'inconclusive' | null (= no canary
  // was run on this check).
  // `subject` is what this verdict is ABOUT (pinned before the call). `accountKey` is the
  // provider's own account identity from a passed canary - authoritative, unlike a masked
  // email, and kept server-side only. Consumers correlate on `subject`, never on "current".
  // Everything this verdict is about to touch, kept so a REJECTED guarded write leaves the
  // in-memory document exactly as it was loaded. That matters beyond tidiness: one caller
  // (proxyTools' Claude planDetected path) calls account.save() after this function returns, and
  // an unguarded whole-document save must never be the thing that persists a verdict the database
  // already refused.
  const beforeVerdict = {
    verification: account.verification, status: account.status,
    session_status: account.session_status, lastVerifiedAt: account.lastVerifiedAt,
    lastCanaryAt: account.lastCanaryAt,
    sessionEncrypted: account.sessionEncrypted, sessionMeta: account.sessionMeta,
    cookieHash: account.cookieHash, bundleVersion: account.bundleVersion,
    rollbackBundles: account.rollbackBundles, lastServerRefreshAt: account.lastServerRefreshAt,
  };
  account.verification = {
    result: effResult, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: now,
    canary: v.canary || null, accountKey: v.accountKey || null, subject,
  };
  // The authoritative-proof clock, separate from lastVerifiedAt. Only a CONCLUSIVE canary sets
  // it, so a routine decode-backed promotion cannot make real proof look fresh (and cannot
  // starve the scheduler that produces it).
  if (v.canary === 'passed' || v.canary === 'failed') account.lastCanaryAt = now;
  account.lastVerifiedAt = now;
  if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = v.loggedOut ? 'needs_login' : 'session_expired'; }
  else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
  else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
  // INCONCLUSIVE results — 'unknown' (transient network / read-only aged token) and
  // 'unsupported' (an anti-bot challenge our datacenter IP cannot legitimately pass). Neither
  // is evidence about the COOKIES, so neither may downgrade a live session; both only lift a
  // previously-expired account back to pending so it re-checks. Leaves working as working.
  //
  // 'unsupported' used to mean `status='blocked'` + `session_status='cookies_invalid'`, which
  // was wrong in both halves: verify.js returns it purely on `cf-mitigated: challenge` or a
  // 403+Cloudflare+HTML response, i.e. a statement about OUR REACHABILITY, never about the
  // stored cookies. accountSelect skips blocked accounts, so an admin pressing "Verify" on a
  // healthy account silently removed the tool from every client. Measured from this host on
  // 2026-07-28, hix and bypassgpt both answer 403/challenge to a datacenter IP, so that was
  // the NORMAL outcome for them, not an edge case. Claude and ChatGPT escaped it only via
  // bespoke API verifiers written to never emit 'unsupported' at all — see the header comments
  // in claudeVerify.js and chatgptVerify.js, which already call the old behaviour wrong. This
  // fixes the mapping itself, so hix / bypassgpt / grok / ryne are covered too.
  //
  // The verdict is still RECORDED in account.verification above, so the operator keeps the
  // signal and can act on it; only the destructive status change is gone. Confirmed failures
  // (a sign-in redirect, a missing session cookie) still downgrade exactly as before.
  else if (v.result === 'unknown' || v.result === 'unsupported') {
    if (account.session_status === 'session_expired') account.session_status = 'pending_verification';
  }

  // A successful exchange ROTATED the tokens -> persist them, or the account is left holding a
  // refresh token that has just been consumed. Two callers can reach here:
  //   forceLive              static-vault tools, where the server IS the rotator (unchanged);
  //   allowServerRefresh     the gated WriteHuman break-glass, where we have deliberately taken
  //                          over rotation because the source machine could not do it.
  // In BOTH cases the write is atomic (encrypt-then-assign, previous kept as rollback) and it
  // updates the verification timestamps, so the dashboard reads HEALTHY rather than "expired".
  let refreshPersisted = false;
  if ((opts.forceLive || opts.allowServerRefresh) && v.result === 'working' && v.refreshedSession && bundle) {
    try {
      const ref = (tools.supabaseConfig(tool) || {}).projectRef;
      const updated = applySupabaseRefresh(bundle, ref, v.refreshedSession);
      if (updated) {
        // Keep the outgoing bundle so a bad rotation can be undone, exactly as the agent-sync
        // promotion path does. Bounded, because encrypted session copies are sensitive at rest.
        if (account.sessionEncrypted) {
          const rolls = Array.isArray(account.rollbackBundles) ? account.rollbackBundles : [];
          rolls.push({
            encrypted: account.sessionEncrypted,
            hash: account.cookieHash ? String(account.cookieHash).slice(0, 12) : null,
            bundleVersion: account.bundleVersion || 0,
            savedAt: now,
            deviceId: (account.activeSource && account.activeSource.deviceId) || null,
            reason: opts.allowServerRefresh ? 'server_refresh' : 'force_live_refresh',
          });
          account.rollbackBundles = rolls.slice(-2);
        }
        account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(updated));
        account.sessionMeta = Object.assign({}, account.sessionMeta || {}, { updatedAt: now });
        if (opts.allowServerRefresh) {
          account.bundleVersion = (account.bundleVersion || 0) + 1;
          account.lastServerRefreshAt = now;
        }
        refreshPersisted = true;
      }
    } catch (_) { /* persist is best-effort; the verify result still stands */ }
  }

  if (!opts.skipSave) {
    // Only the fields this verdict owns. A rotation (forceLive / the gated allowServerRefresh)
    // legitimately owns the bundle fields too, because on those paths the SERVER is the rotator -
    // and they are guarded on the same subject, so a rotation can never overwrite a bundle that a
    // source promoted while the exchange was in flight.
    const setMap = verdictFields(account, Object.assign(
      (v.canary === 'passed' || v.canary === 'failed') ? { lastCanaryAt: account.lastCanaryAt } : {},
      refreshPersisted ? {
        sessionEncrypted: account.sessionEncrypted,
        sessionMeta: account.sessionMeta,
        rollbackBundles: account.rollbackBundles,
        bundleVersion: account.bundleVersion,
        lastServerRefreshAt: account.lastServerRefreshAt,
      } : {},
    ));
    if (!await persistVerdictGuarded(account, setMap, subject)) {
      // STALE OBSERVATION. The row moved on while the provider was answering, so this verdict
      // describes a session that is no longer served. Discard it whole: no write, no status
      // change, no rollback of the newer bundle, no restored source, no alert (an alert here
      // would be a success/transition event for something that never happened) and no retry -
      // the scheduler's next ordinary tick will verify whatever is current by then.
      Object.assign(account, beforeVerdict);
      return {
        result: 'stale_subject', effResult: 'stale_subject', v: null, stale: true,
        subject, cookieNames: names, cookieCount, refreshPersisted: false,
      };
    }
    // The row now holds these fields, so the loaded baseline must agree - otherwise a later
    // save() by a caller would "restore" the pre-verdict values it still remembers.
    if (account.__originalData) Object.assign(account.__originalData, setMap);
  }
  alertTransition(account, tool, prevSs);
  return { result: effResult, effResult, v, cookieNames: names, cookieCount, refreshPersisted };
}

module.exports = { verifyAndApply };

'use strict';
/**
 * An INCONCLUSIVE verify must never take a working account away from clients.
 *
 * THE DEFECT THIS PINS (found 2026-07-28, reported by the operator as "verify doesn't work for
 * any proxy tool except Claude and StealthWriter").
 *
 * utils/proxy/verify.js returns `'unsupported'` in exactly ONE situation: the upstream sits
 * behind an anti-bot challenge that a server-side proxy cannot legitimately pass —
 * `cf-mitigated: challenge`, or a 403 from Cloudflare with an HTML body. That is a statement
 * about OUR REACHABILITY FROM A DATACENTER IP. It says nothing whatsoever about whether the
 * stored cookies are valid.
 *
 * verifyAndApply nonetheless mapped it to the harshest possible verdict:
 *
 *     else if (v.result === 'unsupported') { account.status = 'blocked'; … }
 *
 * and accountSelect skips `blocked` accounts, so an admin pressing "Verify" on a perfectly
 * healthy account REMOVED THE TOOL FROM EVERY CLIENT.
 *
 * Measured live from a datacenter IP on 2026-07-28:
 *     hix        HTTP 403  server=cloudflare
 *     bypassgpt  HTTP 403  server=cloudflare  cf-mitigated=challenge
 * so for those tools the destructive path was not hypothetical — it was the normal outcome.
 *
 * Claude and ChatGPT escaped it only because each got a bespoke API verifier whose header
 * comments state the intent plainly: claudeVerify "We NEVER return 'unsupported' here, so the
 * account is never auto-blocked", chatgptVerify "verifyAndApply then WRONGLY marked a perfectly
 * good account BLOCKED". Those were per-tool workarounds; the mapping itself stayed broken for
 * hix, bypassgpt, grok and ryne.
 *
 * The rule this encodes matches the one already applied to 'unknown': an inconclusive result
 * NEVER downgrades a live session. Only a CONFIRMED signal (a sign-in redirect, a missing
 * session cookie) may.
 *
 * Run: node --test tests/verifyUnsupportedNeverBlocks.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || 'v'.repeat(64);

/**
 * Load verifyAndApply with ./verify stubbed so we control the verdict exactly, and with the
 * vault decrypt stubbed so no real encryption key or DB is needed. Everything else — the
 * status mapping under test — is the REAL module.
 */
function loadWithVerdict(verdict) {
  const target = require.resolve('../utils/proxy/verifyAndApply.js');
  const src = require('fs').readFileSync(target, 'utf8');
  const m = new Module(target);
  m.filename = target;
  m.paths = Module._nodeModulePaths(path.dirname(target));

  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === './verify') {
      return {
        verifyAccountCookies: async () => verdict,
        applySupabaseRefresh: () => null,
      };
    }
    if (id === './vaultCrypto') return { decrypt: () => JSON.stringify({ cookies: [{ name: 'session', value: 'x', domain: 'hix.ai' }] }) };
    if (id === './cookies') {
      return {
        buildCookieHeader: () => 'session=x',
        countCookies: () => 1,
        cookieNames: () => ['session'],
        hasSessionCookie: () => true,
      };
    }
    if (id === './healthAlerts') return { onVerifyApplied: async () => {} };
    return realRequire(id);
  };
  m._compile(src, target);
  return m.exports.verifyAndApply;
}

function makeAccount(over = {}) {
  return Object.assign({
    _id: 'acc1',
    tool: 'hix',
    status: 'active',
    session_status: 'working',
    sessionEncrypted: 'ENC',
    verification: null,
    lastVerifiedAt: null,
    save: async function () { this.__saved = (this.__saved || 0) + 1; },
  }, over);
}

const CHALLENGE = { result: 'unsupported', httpStatus: 403, finalPath: '/app', redirectedToSignIn: false, maskedId: null };

test('a Cloudflare challenge (unsupported) must NOT block a working account', async () => {
  const verifyAndApply = loadWithVerdict(CHALLENGE);
  const acc = makeAccount();

  const r = await verifyAndApply(acc, 'hix', { forceLive: true });

  assert.notEqual(acc.status, 'blocked',
    'an anti-bot challenge is about OUR reachability, not the cookies — it must never block ' +
    'the account, because accountSelect then hides the tool from every client');
  assert.equal(acc.status, 'active', 'a live account stays exactly as it was');
  assert.notEqual(acc.session_status, 'cookies_invalid',
    'the cookies were never shown to be invalid, so they must not be labelled invalid');
  assert.equal(r.result, 'unsupported', 'the honest verdict is still REPORTED to the admin');
});

test('the inconclusive verdict is still recorded, so the operator keeps the signal', async () => {
  const verifyAndApply = loadWithVerdict(CHALLENGE);
  const acc = makeAccount();

  await verifyAndApply(acc, 'hix', { forceLive: true });

  assert.equal(acc.verification.result, 'unsupported', 'verification.result still says unsupported');
  assert.equal(acc.verification.httpStatus, 403);
  assert.ok(acc.lastVerifiedAt, 'the check is timestamped');
});

test('an account already expired is nudged to re-check, exactly like the unknown branch', async () => {
  const verifyAndApply = loadWithVerdict(CHALLENGE);
  const acc = makeAccount({ status: 'session_expired', session_status: 'session_expired' });

  await verifyAndApply(acc, 'hix', { forceLive: true });

  assert.equal(acc.session_status, 'pending_verification',
    'a previously-expired account is lifted to pending_verification so it re-checks, ' +
    'matching how unknown already behaves');
});

test('CONFIRMED failures still downgrade — this fix must not make verify toothless', async () => {
  // A sign-in redirect IS proof the cookies no longer authenticate.
  const expired = { result: 'session_expired', httpStatus: 200, finalPath: '/login', redirectedToSignIn: true, loggedOut: true, maskedId: null };
  const verifyAndApply = loadWithVerdict(expired);
  const acc = makeAccount();

  await verifyAndApply(acc, 'hix', { forceLive: true });

  assert.equal(acc.status, 'session_expired', 'a confirmed logout still expires the account');
  assert.equal(acc.session_status, 'needs_login');
});

test('a working verdict still restores an expired account', async () => {
  const ok = { result: 'working', httpStatus: 200, finalPath: '/app', redirectedToSignIn: false, maskedId: 'a***@b.com' };
  const verifyAndApply = loadWithVerdict(ok);
  const acc = makeAccount({ status: 'session_expired', session_status: 'session_expired' });

  await verifyAndApply(acc, 'hix', { forceLive: true });

  assert.equal(acc.status, 'active', 'a confirmed working session reactivates the account');
  assert.equal(acc.session_status, 'working');
});

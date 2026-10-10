/**
 * Sanitised provider error classification (WriteHuman / Supabase GoTrue).
 *
 * WHY THIS EXISTS: an HTTP 400 from GoTrue's token endpoint is not self-explanatory.
 * It is the answer for a refresh token another holder already rotated, for a token
 * that no longer exists, AND for a session the provider ended on its own schedule.
 * Those are different root causes with different fixes. The body used to be
 * discarded, so every logout looked identical and the cause could not be proven.
 *
 * SAFETY CONTRACT pinned here: the classifier returns ONLY an allowlisted constant.
 * No token, cookie, email, or body fragment can ever escape through it, even when
 * the provider echoes one in an error message.
 */
const test = require('node:test');
const assert = require('node:assert');

const { classifyProviderError, PROVIDER_ERROR_CODES } = require('../utils/proxy/verify');

const ALLOWED = new Set(Object.values(PROVIDER_ERROR_CODES));

test('the diagnostic that proves a MULTI-WRITER REFRESH RACE', () => {
  // GoTrue's answer when the presented refresh token was valid but already
  // exchanged by another holder -- i.e. more than one process is rotating.
  const body = JSON.stringify({ code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' });
  assert.strictEqual(classifyProviderError(body), 'refresh_token_already_used');
});

test('the diagnostic that proves PROVIDER-ENFORCED REAUTHENTICATION', () => {
  // A session the provider itself ended (timebox / inactivity policy). No amount
  // of refreshing or re-architecting the rotator can prevent this one.
  const body = JSON.stringify({ code: 400, error_code: 'session_expired', msg: 'Session Expired' });
  assert.strictEqual(classifyProviderError(body), 'session_expired');
});

test('the remaining distinguishable causes map to their own constants', () => {
  const cases = {
    refresh_token_not_found: 'refresh_token_not_found',
    session_not_found: 'session_not_found',
    user_banned: 'user_banned',
    user_not_found: 'user_not_found',
    over_request_rate_limit: 'over_request_rate_limit',
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.strictEqual(classifyProviderError(JSON.stringify({ error_code: code })), expected, code);
  }
});

test('legacy invalid_grant + an already-used message still classifies as reuse', () => {
  const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' });
  assert.strictEqual(classifyProviderError(body), 'refresh_token_already_used');
});

test('legacy invalid_grant WITHOUT an already-used message stays generic', () => {
  const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
  assert.strictEqual(classifyProviderError(body), 'other');
});

test('SAFETY: an unknown code never echoes provider text', () => {
  const body = JSON.stringify({ error_code: 'some_brand_new_code', msg: 'contains refresh_token=eyJhbGciOi.SECRET.sig' });
  const out = classifyProviderError(body);
  assert.strictEqual(out, 'other');
  assert.ok(ALLOWED.has(out), 'result must be an allowlisted constant');
});

test('SAFETY: a token or email embedded anywhere can never be returned', () => {
  const leaky = [
    JSON.stringify({ error_code: 'eyJhbGciOiJIUzI1NiJ9.leak.sig' }),
    JSON.stringify({ error: 'master@provider.com' }),
    JSON.stringify({ error_code: 'refresh_token_already_used', msg: 'sb-x-auth-token=base64-SECRET' }),
    'refresh_token=eyJhbGciOi.PLAINTEXT.sig',
    '<html>500 oops eyJhbGciOi.SECRET.sig</html>',
  ];
  for (const body of leaky) {
    const out = classifyProviderError(body);
    if (out === null) continue;
    assert.ok(ALLOWED.has(out), 'leaked non-allowlisted value: ' + out);
    assert.ok(!/eyJ|@|base64-|PLAINTEXT|SECRET/.test(out), 'result must carry no payload fragment: ' + out);
  }
});

test('SAFETY: non-JSON and empty bodies degrade to null, never throw', () => {
  for (const body of ['', null, undefined, 'not json at all', '{broken', '<html></html>', Buffer.from('x').toString()]) {
    const out = classifyProviderError(body);
    assert.ok(out === null || ALLOWED.has(out), 'unexpected: ' + out);
  }
});

test('SAFETY: a non-JSON body containing an allowlisted code is still bounded', () => {
  const out = classifyProviderError('garbage "error_code": "refresh_token_already_used" trailing');
  assert.strictEqual(out, 'refresh_token_already_used');
});

test('verify.js exports the classifier and the frozen code table', () => {
  assert.strictEqual(typeof classifyProviderError, 'function');
  assert.ok(Object.isFrozen(PROVIDER_ERROR_CODES), 'code table must be frozen');
});

test('REGRESSION LOCK: the expiry branch records the sanitised code', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vsrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'proxy', 'verify.js'), 'utf8');
  assert.ok(/providerErrorCode:\s*classifyProviderError\(body\)|const providerErrorCode = classifyProviderError\(body\)/.test(vsrc),
    'the 400/401/403 branch must classify the provider error');

  const asrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'proxy', 'verifyAndApply.js'), 'utf8');
  assert.ok(/account\.verification\.providerErrorCode = v\.providerErrorCode/.test(asrc),
    'verifyAndApply must persist the code onto account.verification');
  // Additive only: it must be written behind a guard so non-expiry results are untouched.
  assert.ok(/if \(v\.providerErrorCode\)/.test(asrc), 'persistence must be guarded (additive, optional field)');
});

// -- The rule the operator asked for explicitly -------------------------------
test('CRITICAL: a bare 400 with NO error_code is never reported as reuse', () => {
  // This is the whole point of the classifier. HTTP 400 is also GoTrue's answer
  // for an ordinary revoked token and a provider-ended session, so a 400 with no
  // machine-readable reason must yield NO cause at all.
  for (const body of ['', '{}', JSON.stringify({ code: 400 }), JSON.stringify({ msg: 'Bad Request' }), JSON.stringify({ code: 400, msg: 'Invalid Refresh Token' })]) {
    const out = classifyProviderError(body);
    assert.notStrictEqual(out, 'refresh_token_already_used', 'a bare 400 must never claim reuse: ' + body);
    assert.ok(out === null || out === 'other', 'expected null/other, got ' + out + ' for ' + body);
  }
});

test('MFA / step-up codes classify distinctly so recovery can stop', () => {
  assert.strictEqual(classifyProviderError(JSON.stringify({ error_code: 'insufficient_aal' })), 'insufficient_aal');
  assert.strictEqual(classifyProviderError(JSON.stringify({ error_code: 'mfa_verification_failed' })), 'mfa_verification_failed');
});

test('an account restriction is distinguishable from a session problem', () => {
  assert.strictEqual(classifyProviderError(JSON.stringify({ error_code: 'user_banned' })), 'user_banned');
  assert.notStrictEqual(classifyProviderError(JSON.stringify({ error_code: 'user_banned' })), 'session_expired');
});

test('PURITY: the classifier performs no network I/O and cannot rotate a token', () => {
  // It must be safe to call on any response body. Fetch is replaced with a throw
  // for the duration -- a classifier that reached the network would fail here.
  const realFetch = global.fetch;
  global.fetch = () => { throw new Error('classifier must not perform network I/O'); };
  try {
    assert.strictEqual(classifyProviderError(JSON.stringify({ error_code: 'session_expired' })), 'session_expired');
  } finally {
    global.fetch = realFetch;
  }
});

test('NO NEW ROTATION: the read-only guard still returns before any token exchange', () => {
  // The browser-owned refresh design must be untouched: a readOnly verify with an
  // aged token returns 'unknown' WITHOUT calling the rotating token endpoint. This
  // asserts the guard clause and its env gate are both still in the source, ahead
  // of the fetch to /auth/v1/token.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'proxy', 'verify.js'), 'utf8');
  const guard = src.indexOf("if (opts.readOnly && !(opts.allowServerRefresh && serverRefreshEnabled))");
  const exchange = src.indexOf("grant_type=refresh_token");
  assert.ok(guard > 0, 'the read-only no-exchange guard must still exist');
  assert.ok(exchange > 0, 'the exchange call must still exist');
  assert.ok(guard < exchange, 'the read-only guard must come BEFORE the rotating exchange');
  assert.ok(/WRITEHUMAN_SERVER_REFRESH === '1'/.test(src), 'the env gate on server-side refresh must be intact');
  // And the diagnostic must be derived from the response we ALREADY have, never
  // from a fresh request made for diagnostic purposes.
  assert.ok(/const providerErrorCode = classifyProviderError\(body\)/.test(src),
    'the code must be classified from the existing response body');
});

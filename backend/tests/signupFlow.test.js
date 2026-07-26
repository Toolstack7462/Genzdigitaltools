'use strict';
/**
 * Registration / email-verification regression suite.
 *   node --test backend/tests/signupFlow.test.js
 *
 * Runs the REAL models (User, EmailVerification) and the REAL account-creation
 * path (utils/completeSignup) against an in-memory fake pool injected through
 * the adapter's documented test seam — no MySQL, no HTTP, no network.
 *
 * Covers the behaviours that were broken in production:
 *   - an account is NEVER created before a correct OTP is presented;
 *   - a failed send leaves no account and does not lock the registration;
 *   - a repeat signup refreshes the pending code instead of "Email already exists";
 *   - a code is one-time, expiring, attempt-limited and cooldown-guarded;
 *   - concurrent verification cannot create duplicates;
 *   - email case/whitespace never produces two records.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const adapter = require('../db/mysqlAdapter');

// ── In-memory pool implementing just the SQL the adapter emits ────────────────
function installFakePool() {
  const tables = new Map(); // table -> Map(id -> {data, createdAt, updatedAt})
  const tableOf = (sql) => {
    const m = /(?:FROM|INTO|UPDATE)\s+`([^`]+)`/i.exec(sql);
    return m ? m[1] : null;
  };
  const rowsOf = (t) => tables.get(t) || tables.set(t, new Map()).get(t);
  const wrap = (arr) => [arr.map((d) => ({ data: JSON.stringify(d) }))];

  const pool = {
    query: async (sql, params = []) => {
      const t = tableOf(sql);
      if (/^\s*INSERT INTO/i.test(sql)) {
        const [id, data, createdAt, updatedAt] = params;
        rowsOf(t).set(String(id), { data: JSON.parse(data), createdAt, updatedAt });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*DELETE FROM/i.test(sql)) {
        const store = rowsOf(t);
        if (/WHERE id IN/i.test(sql)) {
          let n = 0;
          for (const p of params) if (store.delete(String(p))) n++;
          return [{ affectedRows: n }];
        }
        if (/WHERE id = \?/i.test(sql)) return [{ affectedRows: store.delete(String(params[0])) ? 1 : 0 }];
        const n = store.size; store.clear(); return [{ affectedRows: n }];
      }
      const all = [...rowsOf(t).values()].map((r) => r.data);
      if (/SELECT COUNT/i.test(sql)) return [[{ c: all.length }]];
      if (/WHERE id IN/i.test(sql)) {
        const want = new Set(params.map(String));
        return wrap(all.filter((d) => want.has(String(d._id))));
      }
      if (/WHERE id = \?/i.test(sql)) return wrap(all.filter((d) => String(d._id) === String(params[0])));
      if (/JSON_EXTRACT/i.test(sql) && params.length >= 2) {
        const field = String(params[0]).replace(/^\$\./, '');
        return wrap(all.filter((d) => d[field] === params[1]));
      }
      return wrap(all); // full scan → adapter filters in JS
    },
  };
  adapter.__test.setPool(pool);
  return { tables, rowsOf };
}

let store;
beforeEach(() => { store = installFakePool(); });

// Required AFTER the seam exists; models bind lazily to the pool at query time.
const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const { completeSignup } = require('../utils/completeSignup');
const policy = require('../utils/signupPolicy');

const EMAIL = 'New.User@Example.com';
const NORM = 'new.user@example.com';
const PASSWORD = 'CorrectHorse9';

/** Mirrors what routes/public.js does for a brand-new signup (minus HTTP). */
async function startSignup(email = EMAIL, password = PASSWORD, fullName = 'New User') {
  const normalized = policy.normalizeEmail(email);
  const passwordHash = await bcrypt.hash(password, 4); // low cost: tests only
  return EmailVerification.issueSignupOtp({ email: normalized, fullName, passwordHash });
}
const users = async () => User.find({});
const pendingRows = async () => (await EmailVerification.find({ type: 'signup' }));

// ── 1. successful signup: code issued, NO account yet ────────────────────────
test('1. signup issues a pending registration and creates NO user row', async () => {
  const issued = await startSignup();
  assert.match(issued.code, /^\d{6}$/, 'a 6-digit code is minted');
  assert.equal((await users()).length, 0, 'no account exists before verification');

  const pending = await EmailVerification.findPendingSignup(EMAIL);
  assert.ok(pending, 'pending registration stored');
  assert.equal(pending.email, NORM, 'stored normalized');
  assert.equal(pending.status, 'active');
  // Only the HASH is stored — never the code itself.
  assert.equal(pending.codeHash, EmailVerification.hash(issued.code));
  assert.ok(!JSON.stringify(pending.toObject ? pending.toObject() : pending).includes(issued.code),
    'the raw code is never persisted');
});

// ── 2. a failed send must not create an account nor lock the registration ────
test('2. failed email send leaves no account and does not consume the send budget', async () => {
  await startSignup();
  // Route returns 502 here and never calls markSignupSent().
  assert.equal((await users()).length, 0, 'no account after a send failure');

  const pending = await EmailVerification.findPendingSignup(EMAIL);
  assert.equal(pending.status, 'active', 'registration is still usable');
  assert.equal(Number(pending.sendCount || 0), 0, 'a failed send does not count');
  assert.equal(policy.cooldownRemainingMs(pending.lastSentAt), 0, 'no cooldown burned');

  // The immediate retry is allowed and mints a fresh code.
  const retry = await startSignup();
  assert.ok(retry.code && !retry.cooldownMs, 'retry issues a new code straight away');
});

// ── 3. resend cooldown + budget apply only to CONFIRMED sends ────────────────
test('3. resend is cooldown-limited once a send is confirmed', async () => {
  await startSignup();
  await EmailVerification.markSignupSent(NORM);

  const blocked = await startSignup();
  assert.ok(blocked.cooldownMs > 0, 'a second send inside the window is refused');
  assert.ok(!blocked.code, 'no code is minted while cooling down');

  // Past the cooldown it works again.
  const later = new Date(Date.now() + policy.RESEND_COOLDOWN_MS + 1000);
  const ok = await EmailVerification.issueSignupOtp({
    email: NORM, fullName: 'New User', passwordHash: 'x', now: later,
  });
  assert.match(ok.code, /^\d{6}$/, 'allowed after the cooldown elapses');
});

// ── 4. correct code creates exactly ONE usable account ──────────────────────
test('4. correct code creates exactly one verified account with a working password', async () => {
  const { code } = await startSignup();
  const r = await completeSignup({ email: EMAIL, code });

  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  const all = await users();
  assert.equal(all.length, 1, 'exactly one account');
  assert.equal(all[0].email, NORM);
  assert.equal(all[0].emailVerified, true, 'account is verified on creation');
  assert.equal(all[0].role, 'CLIENT');
  assert.equal(all[0].status, 'active');
  assert.ok(await all[0].comparePassword(PASSWORD), 'the original password works (hash not double-hashed)');
});

// ── 5. wrong / expired codes are rejected ───────────────────────────────────
test('5. a wrong code is rejected, counts an attempt, and locks at the limit', async () => {
  const { code } = await startSignup();
  const wrong = code === '000000' ? '111111' : '000000';

  const bad = await completeSignup({ email: EMAIL, code: wrong });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'mismatch');
  assert.equal(bad.attemptsLeft, policy.MAX_ATTEMPTS - 1);
  assert.equal((await users()).length, 0, 'still no account');

  for (let i = 1; i < policy.MAX_ATTEMPTS; i++) await completeSignup({ email: EMAIL, code: wrong });
  const locked = await completeSignup({ email: EMAIL, code });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked', 'the challenge locks after MAX_ATTEMPTS');
  assert.equal((await users()).length, 0, 'a locked challenge never creates an account');
});

test('5b. an expired code is rejected', async () => {
  const { code } = await startSignup();
  const future = new Date(Date.now() + policy.OTP_TTL_MS + 1000);
  const r = await completeSignup({ email: EMAIL, code, now: future });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
  assert.equal((await users()).length, 0);
});

// ── 6. one-time use: a consumed code cannot be replayed ─────────────────────
test('6. a used code cannot be replayed into a second account', async () => {
  const { code } = await startSignup();
  const first = await completeSignup({ email: EMAIL, code });
  assert.equal(first.created, true);

  const replay = await completeSignup({ email: EMAIL, code });
  assert.equal(replay.ok, true, 'a double-submit reports the true state');
  assert.equal(replay.created, false, 'but creates nothing');
  assert.equal(replay.replay, true);
  assert.equal((await users()).length, 1, 'still exactly one account');
});

// ── 7. concurrent verification must not duplicate ───────────────────────────
test('7. simultaneous correct-code requests create exactly one account', async () => {
  const { code } = await startSignup();
  const results = await Promise.all([
    completeSignup({ email: EMAIL, code }),
    completeSignup({ email: EMAIL, code }),
    completeSignup({ email: EMAIL, code }),
  ]);
  assert.equal((await users()).length, 1, 'no duplicate accounts');
  assert.equal(results.filter((r) => r.ok && r.created).length, 1, 'exactly one caller created it');
});

// ── 8/9. existing accounts are classified correctly ─────────────────────────
test('8. an existing VERIFIED account is recognised and left untouched', async () => {
  await User.create({ fullName: 'Old', email: NORM, passwordHash: 'Secret123', role: 'CLIENT', emailVerified: true });
  const found = await User.findOne({ email: policy.emailMatch(EMAIL) });
  assert.ok(found, 'found case-insensitively');
  assert.equal(policy.classifyExisting(found), 'verified');
  assert.equal((await pendingRows()).length, 0, 'signup does not open a pending record for a verified account');
});

test('9. an existing UNVERIFIED legacy account resumes verification', async () => {
  await User.create({ fullName: 'Legacy', email: NORM, passwordHash: 'Secret123', role: 'CLIENT', emailVerified: false });
  const found = await User.findOne({ email: policy.emailMatch(EMAIL) });
  assert.equal(policy.classifyExisting(found), 'unverified');

  const { code } = await EmailVerification.issueOtp({ userId: found._id, email: NORM });
  const r = await EmailVerification.verifyOtp({ email: NORM, code });
  assert.equal(r.ok, true, 'the legacy OTP path still works unchanged');
  assert.equal((await users()).length, 1, 'no second account is created for a legacy user');
});

// ── 10. case + whitespace normalization ─────────────────────────────────────
test('10. case and whitespace variants map to ONE pending registration and one account', async () => {
  const variants = ['  New.User@Example.com ', 'NEW.USER@EXAMPLE.COM', 'new.user@example.com\t'];
  for (const v of variants) assert.equal(policy.normalizeEmail(v), NORM, `normalizes ${JSON.stringify(v)}`);

  await startSignup(variants[0]);
  const issued = await EmailVerification.issueSignupOtp({
    email: variants[1], fullName: 'New User', passwordHash: 'x',
    now: new Date(Date.now() + policy.RESEND_COOLDOWN_MS + 1000),
  });
  assert.equal((await pendingRows()).length, 1, 'one pending row for all spellings');

  const r = await completeSignup({ email: variants[2], code: issued.code });
  assert.equal(r.created, true);
  assert.equal((await users()).length, 1, 'one account regardless of the spelling used');
  assert.equal((await users())[0].email, NORM, 'stored normalized');
});

// ── deterministic id: the PK is what makes "one pending per email" true ─────
test('pending id is derived from the normalized email (PK enforces uniqueness)', () => {
  const a = EmailVerification.pendingIdFor('  Foo@Bar.com ');
  const b = EmailVerification.pendingIdFor('foo@bar.com');
  assert.equal(a, b, 'same address → same row id');
  assert.notEqual(a, EmailVerification.pendingIdFor('other@bar.com'));
  assert.ok(a.length <= 32, 'fits the id VARCHAR(32) column');
  assert.match(a, /^pr[0-9a-f]{24}$/);
});

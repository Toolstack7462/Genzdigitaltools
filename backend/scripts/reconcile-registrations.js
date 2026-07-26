'use strict';
/**
 * reconcile-registrations.js — READ-ONLY registration/verification report.
 *
 * Classifies every account and pending registration so the fallout of the old
 * "create the account first, email best-effort afterwards" signup flow can be
 * seen and acted on deliberately.
 *
 * IT DELETES NOTHING AND CHANGES NOTHING. There is no --fix flag by design:
 * an unverified account may well belong to a real, paying member (the old flow
 * let them log in), so removal is a human decision, per account.
 *
 * Usage (from backend/ on the server):
 *   node scripts/reconcile-registrations.js              # summary + counts
 *   node scripts/reconcile-registrations.js --detail     # list every account
 *   node scripts/reconcile-registrations.js --csv > report.csv
 *
 * Categories reported:
 *   verified              — emailVerified true. Healthy.
 *   unverified            — account exists, never verified. Can log in today.
 *                           Fixable by the user via signup → "resume verification".
 *   pending               — a pending registration with NO account (new flow).
 *   no_verification_record— unverified account with no OTP record ever issued:
 *                           created before verification existed, or the email
 *                           send failed outright. These are the accounts the
 *                           reported bug produced.
 *   duplicate_normalized  — two or more accounts whose emails are equal after
 *                           trim+lowercase. Requires a manual merge decision.
 *   alias_collision       — distinct addresses that collapse to the same gmail
 *                           identity (dots / +tags). REPORTED ONLY: these are
 *                           deliberately NOT treated as duplicates, because for
 *                           most providers they are different mailboxes.
 *
 * Prints no passwords, hashes, OTP codes or tokens.
 */
const dotenv = require('dotenv');
const path = require('path');
const mysqlAdapter = require('../db/mysqlAdapter');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const { normalizeEmail } = require('../utils/signupPolicy');

const DETAIL = process.argv.includes('--detail');
const CSV = process.argv.includes('--csv');

/** gmail-style identity, used ONLY to flag possible alias collisions. */
function aliasIdentity(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return null;
  if (!/^(gmail|googlemail)\.com$/i.test(domain)) return null;
  return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
}

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

async function main() {
  await mysqlAdapter.connect();

  const users = await User.find({});
  const verifications = await EmailVerification.find({});

  // Index the verification records by normalized email.
  const otpByEmail = new Map();
  const pendingByEmail = new Map();
  for (const v of verifications) {
    const key = normalizeEmail(v.email);
    if (!key) continue;
    if (v.type === 'signup') pendingByEmail.set(key, v);
    if (v.type === 'verify') {
      const list = otpByEmail.get(key) || [];
      list.push(v);
      otpByEmail.set(key, list);
    }
  }

  const byNormalized = new Map();
  const byAlias = new Map();
  const rows = [];

  for (const u of users) {
    const raw = String(u.email || '');
    const norm = normalizeEmail(raw);
    const otps = otpByEmail.get(norm) || [];

    let category;
    if (u.emailVerified) category = 'verified';
    else if (otps.length === 0) category = 'no_verification_record';
    else category = 'unverified';

    rows.push({
      id: String(u._id),
      email: raw,
      normalized: norm,
      role: u.role || '',
      status: u.status || '',
      category,
      otpRecords: otps.length,
      anomalies: [
        raw !== norm ? 'email_not_normalized' : null,
        /\s/.test(raw) ? 'whitespace_in_email' : null,
        !/^\$2[aby]\$/.test(String(u.passwordHash || '')) ? 'password_not_bcrypt' : null,
      ].filter(Boolean).join('|'),
      createdAt: iso(u.createdAt),
    });

    byNormalized.set(norm, (byNormalized.get(norm) || []).concat(String(u._id)));
    const alias = aliasIdentity(norm);
    if (alias) byAlias.set(alias, (byAlias.get(alias) || []).concat(norm));
  }

  // Pending registrations that have NO account (the healthy new-flow state).
  const accountEmails = new Set(rows.map((r) => r.normalized));
  const orphanPending = [];
  for (const [key, p] of pendingByEmail) {
    if (accountEmails.has(key)) continue;
    orphanPending.push({
      email: key,
      status: p.status || '',
      attempts: Number(p.attempts || 0),
      sendCount: Number(p.sendCount || 0),
      expiresAt: iso(p.expiresAt),
      expired: p.expiresAt ? new Date(p.expiresAt).getTime() <= Date.now() : true,
    });
  }

  const duplicates = [...byNormalized.entries()].filter(([, ids]) => ids.length > 1);
  const aliasCollisions = [...byAlias.entries()].filter(([, list]) => new Set(list).size > 1);

  if (CSV) {
    console.log('id,email,normalized,role,status,category,otp_records,anomalies,created_at');
    for (const r of rows) {
      console.log([r.id, r.email, r.normalized, r.role, r.status, r.category, r.otpRecords, r.anomalies, r.createdAt]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    await mysqlAdapter.close();
    return;
  }

  const count = (c) => rows.filter((r) => r.category === c).length;

  console.log('\n══ REGISTRATION RECONCILIATION (read-only) ══════════════════════');
  console.log(`accounts total ............... ${rows.length}`);
  console.log(`  verified ................... ${count('verified')}`);
  console.log(`  unverified ................. ${count('unverified')}   (has an OTP record — can resume verification)`);
  console.log(`  no_verification_record ..... ${count('no_verification_record')}   (created without any code ever issued)`);
  console.log(`pending registrations (no account) ... ${orphanPending.length}`);
  console.log(`duplicate normalized emails .......... ${duplicates.length}`);
  console.log(`gmail alias collisions (informational) ${aliasCollisions.length}`);

  const anomalies = rows.filter((r) => r.anomalies);
  console.log(`rows with data anomalies ............. ${anomalies.length}`);

  if (duplicates.length) {
    console.log('\n── DUPLICATE NORMALIZED EMAILS (manual merge decision) ──');
    for (const [norm, ids] of duplicates) console.log(`  ${norm}  → ${ids.length} accounts: ${ids.join(', ')}`);
  }
  if (aliasCollisions.length) {
    console.log('\n── GMAIL ALIAS COLLISIONS (NOT merged — informational only) ──');
    for (const [alias, list] of aliasCollisions) console.log(`  ${alias}  ← ${[...new Set(list)].join(', ')}`);
  }
  if (anomalies.length) {
    console.log('\n── DATA ANOMALIES ──');
    for (const r of anomalies) console.log(`  ${r.normalized}  [${r.anomalies}]`);
  }
  if (orphanPending.length) {
    console.log('\n── PENDING REGISTRATIONS WITHOUT AN ACCOUNT ──');
    for (const p of orphanPending) {
      console.log(`  ${p.email}  status=${p.status} attempts=${p.attempts} sends=${p.sendCount} ${p.expired ? 'EXPIRED' : 'active'} (expires ${p.expiresAt})`);
    }
  }

  const needsAction = rows.filter((r) => r.category !== 'verified');
  if (needsAction.length) {
    console.log('\n── ACCOUNTS THAT NEVER COMPLETED VERIFICATION ──');
    console.log('   Remedy: the user signs up again with the same address — the new flow');
    console.log('   detects the unverified account and emails a fresh code (their existing');
    console.log('   password is preserved and never overwritten).');
    if (DETAIL) {
      for (const r of needsAction) {
        console.log(`  ${r.normalized.padEnd(38)} ${r.category.padEnd(24)} role=${r.role} status=${r.status} created=${r.createdAt}`);
      }
    } else {
      console.log(`   ${needsAction.length} account(s). Re-run with --detail to list them.`);
    }
  }

  console.log('\nNothing was modified.\n');
  await mysqlAdapter.close();
}

main().catch(async (err) => {
  console.error('reconcile-registrations failed:', err.message);
  try { await mysqlAdapter.close(); } catch (_) {}
  process.exit(1);
});

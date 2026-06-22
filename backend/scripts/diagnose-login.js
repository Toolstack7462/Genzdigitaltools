'use strict';
/**
 * diagnose-login.js — READ-ONLY login diagnostic for ONE account.
 *
 * Connects to the same MySQL/MariaDB the app uses (via .env DATABASE_URL),
 * looks up an account the EXACT same way the login route does, and prints why
 * a login would be rejected — without changing any data and without ever
 * printing passwords, hashes, tokens or cookies.
 *
 * Usage (run from the backend/ dir on the server):
 *   node scripts/diagnose-login.js <email>
 *   node scripts/diagnose-login.js <email> "<password-to-test>"
 *
 * The optional 2nd arg only prints MATCH / NO MATCH for the password — it is
 * never echoed or logged. Omit it if you don't know the password.
 */
const dotenv = require('dotenv');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysqlAdapter = require('../db/mysqlAdapter');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Same anchored, case-insensitive, whitespace-tolerant match the login route uses.
function emailMatch(email) {
  const esc = String(email || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: `^\\s*${esc}\\s*$`, $options: 'i' };
}

function hashFmt(h) {
  const s = String(h || '');
  const isBcrypt = /^\$2[aby]\$/.test(s);
  return `${isBcrypt ? 'bcrypt' : 'NON-BCRYPT'} prefix=${s.slice(0, 7)} len=${s.length}`;
}

async function main() {
  const rawEmail = (process.argv[2] || '').trim();
  const testPassword = process.argv[3]; // optional
  if (!rawEmail) {
    console.error('Usage: node scripts/diagnose-login.js <email> ["<password-to-test>"]');
    process.exit(1);
  }
  const email = rawEmail.toLowerCase();

  await mysqlAdapter.connect();
  const User = require('../models/User');
  const DeviceProfile = require('../models/DeviceProfile');
  const DeviceBinding = require('../models/DeviceBinding');
  const ActivityLog = require('../models/ActivityLog');

  console.log('\n==================================================');
  console.log(`LOGIN DIAGNOSTIC for: ${email}`);
  console.log('==================================================\n');

  // 1) Every row matching this email, case-insensitively (duplicates included).
  const all = await User.find({ email: emailMatch(email) });
  console.log(`1) Accounts matching this email (case-insensitive): ${all.length}`);
  if (all.length === 0) {
    console.log('   ❌ NO account found with this email. Login would return "Invalid credentials".');
    console.log('      → Check for typos / a different email than the one registered.\n');
    await mysqlAdapter.close();
    return;
  }
  all.forEach((u, i) => {
    console.log(`   [${i}] id=${u._id}`);
    console.log(`        storedEmail="${u.email}"  role=${JSON.stringify(u.role)}  status=${u.status || 'unset'}`);
    console.log(`        emailVerified=${u.emailVerified}  password=${hashFmt(u.passwordHash)}`);
    console.log(`        devicePolicy=${JSON.stringify(u.devicePolicy || null)}`);
  });

  // 2) Login route only treats role==CLIENT (case-insensitive) as a client login.
  const clientRows = all.filter(u => String(u.role || '').toUpperCase() === 'CLIENT');
  console.log(`\n2) Rows usable as a CLIENT login: ${clientRows.length}`);
  if (clientRows.length === 0) {
    console.log('   ❌ The account(s) exist but role is NOT "CLIENT" — client login returns "Invalid credentials".');
    console.log('      → Fix the role value, or log in via the correct portal.\n');
  }

  // 3) Status / verification gates.
  clientRows.forEach((u, i) => {
    if (u.status === 'disabled') {
      console.log(`   [${i}] ❌ status=disabled → 403 "account has been disabled".`);
    }
  });

  // 4) Password test (optional, never echoed).
  if (testPassword !== undefined) {
    let matched = false;
    for (const u of clientRows) {
      try { if (await bcrypt.compare(testPassword, u.passwordHash || '')) { matched = true; break; } } catch (_) {}
    }
    console.log(`\n4) Password test: ${matched ? '✅ MATCH (password is correct for a CLIENT row)' : '❌ NO MATCH against any CLIENT row'}`);
    if (!matched) console.log('      → Wrong password OR the stored hash is stale/legacy. Consider a password reset.');
  } else {
    console.log('\n4) Password test: skipped (no password arg supplied).');
  }

  // 5) Device gate — the most common "correct password but still blocked" cause.
  console.log('\n5) Device profiles (the actual login gate when devicePolicy.enabled=true):');
  let anyGate = false;
  for (const u of clientRows) {
    const profiles = await DeviceProfile.find({ clientId: u._id });
    const bindings = await DeviceBinding.find({ clientId: u._id });
    console.log(`   client ${u._id}: ${profiles.length} device profile(s), ${bindings.length} legacy binding(s)`);
    profiles.forEach((p, i) => {
      const flag = (p.status === 'pending' || p.status === 'blocked') ? '  ⬅ BLOCKS LOGIN' : '';
      if (flag) anyGate = true;
      console.log(`        [${i}] status=${p.status} os=${p.os || '?'} browser=${p.browser || '?'} lastSeen=${p.lastSeenAt || '?'}${flag}`);
    });
    if ((u.devicePolicy && u.devicePolicy.enabled) === false) {
      console.log('        (devicePolicy DISABLED for this account → device gate is skipped entirely)');
    }
  }
  if (anyGate) {
    console.log('\n   ❗ A pending/blocked device profile will reject login with a 403 (DEVICE_PENDING/DEVICE_BLOCKED).');
    console.log('      FIX: Admin → Security → Device Profiles → Approve, OR disable device binding for this client.');
  }

  // 6) Recent failed-login audit entries for this email.
  try {
    const fails = (await ActivityLog.find({ action: 'CLIENT_LOGIN_FAILED' }))
      .filter(l => String(l.meta?.email || '').toLowerCase() === email)
      .slice(-5);
    console.log(`\n6) Recent CLIENT_LOGIN_FAILED audit entries for this email: ${fails.length}`);
    fails.forEach(l => console.log(`        ${l.createdAt} reason="${l.meta?.reason || '?'}" ip=${l.meta?.ip || '?'}`));
  } catch (_) {
    console.log('\n6) (Could not read ActivityLog — skipping.)');
  }

  console.log('\n==================================================\n');
  await mysqlAdapter.close();
}

main().catch(async (err) => {
  console.error('Diagnostic failed:', err);
  try { await mysqlAdapter.close(); } catch (_) {}
  process.exit(1);
});

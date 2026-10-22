'use strict';
/**
 * REAL-DATABASE self-test for the verification-subject guard in utils/proxy/verifyAndApply.js.
 *
 * WHY THIS EXISTS. The guard that shipped first compared the subject against fields on the SAME
 * in-memory document. Production does not work that way: two Passenger workers, or two requests in
 * one worker, each hold their OWN snapshot. The verifier's object never learns that another writer
 * committed a newer bundle, so the in-memory comparison sees nothing wrong and a plain
 * `account.save()` replaces the WHOLE row — newer sessionEncrypted, cookieHash, bundleVersion,
 * activeSource, status and verification — with the verifier's stale snapshot. The window is one
 * provider round-trip wide, on the single row the live session depends on.
 *
 * A mocked model cannot show this. A fixture whose `find()` hands back the same object, with
 * `save() { return Promise.resolve(this); }`, has no independent snapshots and no storage, so it
 * cannot distinguish a guarded write from an unguarded one. This test therefore uses the REAL
 * model and the REAL adapter against a REAL engine, with genuinely separate reads:
 *
 *     verifier loads A  →  provider call waits  →  another writer commits B
 *                       →  release A's answer   →  inspect the STORED row
 *
 * The only stub is the provider HTTP call itself (utils/proxy/verify.verifyAccountCookies), which
 * is the one thing that must not reach WriteHuman from a test. Storage is real.
 *
 * ISOLATION (required). Point DATABASE_URL at a SCRATCH database on the SAME engine/version as
 * production — never the production schema — and set VERIFYGUARD_SELFTEST_DB=1 plus
 * VERIFYGUARD_EXPECTED_DB=<scratch db name>. The test re-reads DATABASE() from the live connection,
 * refuses if it is not the expected scratch name, and refuses if the connecting account holds any
 * global privilege beyond the baseline `USAGE ON *.*`. It only ever creates/updates/deletes rows
 * whose id begins `selftest-`, and it deletes them at the end. It never reads, writes or depends on
 * any real ProxyAccount, session, cookie or credential, and it performs no network request.
 *
 *   DATABASE_URL="mysql://user:pass@host:3306/scratch_db" VERIFYGUARD_SELFTEST_DB=1 \
 *     VERIFYGUARD_EXPECTED_DB=scratch_db node scripts/verifyguard-db-selftest.js
 *
 * Exit 0 = every case passed. Non-zero = a failure; do not deploy the guard until it passes.
 */
if (!/^(1|true|yes)$/i.test(String(process.env.VERIFYGUARD_SELFTEST_DB || ''))) {
  console.error('REFUSING TO RUN: set VERIFYGUARD_SELFTEST_DB=1 and point DATABASE_URL at an ISOLATED scratch database (same engine/version as prod, never the production schema).');
  process.exit(2);
}

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY
  || require('crypto').randomBytes(32).toString('hex');

// Stub the provider BEFORE verifyAndApply is required: it destructures its import at module load,
// so reassigning the module property afterwards would not change what it calls.
const verifyMod = require('../utils/proxy/verify');
let verifyImpl = async () => ({ result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' });
verifyMod.verifyAccountCookies = async (...a) => verifyImpl(...a);

const ProxyAccount = require('../models/proxy/ProxyAccount');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const { verifyAndApply } = require('../utils/proxy/verifyAndApply');
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, extra != null ? JSON.stringify(extra) : ''); }
};

const REF = 'hicfsbrfkzsxbwayibfm';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const jwt = (iat) => b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, session_id: 's' }) + '.sig';
const cookieBundle = (iat) => ({
  cookies: [{
    name: 'sb-' + REF + '-auth-token',
    value: 'base64-' + Buffer.from(JSON.stringify({ access_token: jwt(iat), refresh_token: 'rt', user: { email: 'operator@example.com' } })).toString('base64'),
    domain: '.writehuman.ai', path: '/',
  }],
});

/** Write the starting row straight through the real model. */
async function seed(id, over) {
  await ProxyAccount.create(Object.assign({
    _id: id, tool: 'writehuman', isPrimary: true, label: 'selftest',
    status: 'active', session_status: 'working',
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(cookieBundle(1000))),
    cookieHash: 'hashA', bundleVersion: 7,
    activeSource: { deviceId: 'dev-A', name: 'RDP-A', promotedAt: new Date(), bundleVersion: 7 },
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, canary: null },
  }, over || {}));
  return load(id);
}
/** An INDEPENDENT read — a different worker's snapshot of the same row. */
// Deliberately _findRaw + _hydrate rather than findOne(): it is then unambiguous that every call
// goes back to the database and builds a NEW document with its own __originalData, which is the
// whole point of this file. A query object with its own caching would undermine the test silently.
const raw = async (id) => (await ProxyAccount._findRaw({ _id: id }))[0] || null;
const load = async (id) => { const r = await raw(id); return r ? ProxyAccount._hydrate(r) : null; };

const IDS = [];
const newId = (n) => { const id = 'selftest-vg-' + Date.now() + '-' + n; IDS.push(id); return id; };

(async () => {
  // ── (1) ISOLATION PROOF, before anything is written ────────────────────────────────────────
  const expectedDb = String(process.env.VERIFYGUARD_EXPECTED_DB || '');
  if (!expectedDb) { console.error('REFUSING TO RUN: set VERIFYGUARD_EXPECTED_DB to the scratch database name you provisioned.'); process.exit(2); }
  let mysql; try { mysql = require('mysql2/promise'); } catch (_) {
    console.error('mysql2 not installed in this environment.'); process.exit(2);
  }
  {
    const conn = await mysql.createConnection(process.env.DATABASE_URL);
    const [[idrow]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS ver');
    let grants = [];
    try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER()'); grants = g.map((r) => String(Object.values(r)[0] || '')); } catch (_) {}
    await conn.end();
    console.log(`[selftest] db=${idrow.db} user=${idrow.usr} engine/version=${idrow.ver}`);
    console.log('[selftest] grants:\n    ' + grants.join('\n    '));
    if (idrow.db !== expectedDb) { console.error(`REFUSING TO RUN: connected to '${idrow.db}', not the expected scratch db '${expectedDb}'.`); process.exit(2); }
    const over = grants.find((l) => /\bON\s+\*\.\*/i.test(l) && !/\bGRANT\s+USAGE\s+ON\s+\*\.\*/i.test(l));
    if (over) { console.error(`REFUSING TO RUN: the scratch account has a global privilege beyond USAGE:\n    ${over}`); process.exit(2); }
  }

  // ── (2) NEGATIVE CONTROL: the race is real, and an unguarded whole-doc save loses data ─────
  // This is the behaviour the first guard could not prevent. It is reproduced deliberately, with
  // the SAME independent-snapshot shape, so the positive cases below are measured against a
  // demonstrated failure rather than an assumed one.
  {
    const id = newId('neg');
    await seed(id);
    const stale = await load(id);                       // worker 1 loads A
    const other = await load(id);                       // worker 2's own snapshot
    other.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle(9000)));
    other.cookieHash = 'hashB';
    other.bundleVersion = 8;
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 8 };
    await other.save();                                 // worker 2 commits B
    // worker 1 now persists its own snapshot the old way
    stale.verification = { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, canary: 'passed' };
    stale.lastVerifiedAt = new Date();
    await stale.save();
    const row = await raw(id);
    check('NEGATIVE CONTROL: an unguarded whole-document save DOES clobber the newer bundle',
      row.bundleVersion === 7 && row.cookieHash === 'hashA' && row.activeSource.deviceId === 'dev-A',
      { bundleVersion: row.bundleVersion, cookieHash: row.cookieHash, source: row.activeSource && row.activeSource.deviceId });
  }

  // ── (3) A LATE POSITIVE VERDICT MUST NOT LAND ON THE NEW BUNDLE ────────────────────────────
  {
    const id = newId('late-pos');
    await seed(id);
    const verifier = await load(id);                    // loads A (bundleVersion 7 / hashA / dev-A)
    let release;
    const gate = new Promise((r) => { release = r; });
    verifyImpl = async () => { await gate; return { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' }; };
    const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });

    const other = await load(id);                       // a genuinely separate snapshot
    other.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle(9000)));
    other.cookieHash = 'hashB';
    other.bundleVersion = 8;
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 8 };
    other.verification = { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, canary: null, subject: { bundleVersion: 8, sourceDeviceId: 'dev-B', cookieHash: 'hashB' } };
    await other.save();
    const bEncrypted = other.sessionEncrypted;

    release();
    const res = await inflight;
    const row = await raw(id);
    check('a late POSITIVE verdict is reported as a stale observation', res.result === 'stale_subject' && res.stale === true, res.result);
    check('  B bundle bytes intact', row.sessionEncrypted === bEncrypted);
    check('  B hash intact', row.cookieHash === 'hashB', row.cookieHash);
    check('  B version intact', Number(row.bundleVersion) === 8, row.bundleVersion);
    check('  B source intact', row.activeSource && row.activeSource.deviceId === 'dev-B', row.activeSource);
    check('  B newer verification intact (no canary invented for B)', !row.verification || row.verification.canary === null, row.verification);
    check('  B status intact', row.status === 'active' && row.session_status === 'working', { s: row.status, ss: row.session_status });
  }

  // ── (4) A LATE NEGATIVE VERDICT MUST NOT EXPIRE THE NEW BUNDLE ─────────────────────────────
  {
    const id = newId('late-neg');
    await seed(id);
    const verifier = await load(id);
    let release;
    const gate = new Promise((r) => { release = r; });
    verifyImpl = async () => { await gate; return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' }; };
    const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });

    const other = await load(id);
    other.cookieHash = 'hashB'; other.bundleVersion = 8;
    other.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle(9000)));
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 8 };
    await other.save();

    release();
    const res = await inflight;
    const row = await raw(id);
    check('a late NEGATIVE verdict is a stale observation too', res.result === 'stale_subject', res.result);
    check('  the newer session is NOT expired', row.session_status === 'working' && row.status === 'active', { s: row.status, ss: row.session_status });
    check('  the newer bundle is NOT rolled back', row.cookieHash === 'hashB' && Number(row.bundleVersion) === 8);
    check('  no needs_login was invented', row.session_status !== 'needs_login');
  }

  // ── (5) A SOURCE HANDOVER THAT KEEPS THE IDENTICAL BUNDLE BYTES ────────────────────────────
  // The case a version/hash guard alone would miss: same bytes, same hash, same version, but the
  // session now belongs to a different machine. A verdict computed for dev-A must not be recorded
  // as if it described dev-B's tenure.
  {
    const id = newId('src-only');
    await seed(id);
    const verifier = await load(id);
    let release;
    const gate = new Promise((r) => { release = r; });
    verifyImpl = async () => { await gate; return { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' }; };
    const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });

    const other = await load(id);
    // ONLY the source changes. Bytes, hash and version are untouched.
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 7 };
    await other.save();

    release();
    const res = await inflight;
    const row = await raw(id);
    check('a SOURCE change with identical bundle bytes still refuses the verdict', res.result === 'stale_subject', res.result);
    check('  the new source is preserved', row.activeSource && row.activeSource.deviceId === 'dev-B', row.activeSource);
    check('  the old source is NOT restored', !(row.activeSource && row.activeSource.deviceId === 'dev-A'));
    check('  no proof was attributed to the new source', !(row.verification && row.verification.canary === 'passed'), row.verification);
  }

  // ── (6) THE UNCONTENDED PATH STILL WORKS, AND WRITES ONLY ITS OWN FIELDS ───────────────────
  {
    const id = newId('clean');
    await seed(id, { status: 'session_expired', session_status: 'session_expired' });
    const before = await raw(id);
    const verifier = await load(id);
    verifyImpl = async () => ({ result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' });
    const res = await verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
    const row = await raw(id);
    check('an uncontended verdict lands', res.result === 'working', res.result);
    check('  the canary and its subject are recorded', row.verification.canary === 'passed'
      && row.verification.subject && Number(row.verification.subject.bundleVersion) === 7
      && row.verification.subject.cookieHash === 'hashA'
      && row.verification.subject.sourceDeviceId === 'dev-A', row.verification);
    check('  the authoritative proof clock is stamped', !!row.lastCanaryAt);
    check('  status recovered to active/working', row.status === 'active' && row.session_status === 'working', { s: row.status, ss: row.session_status });
    check('  the bundle was NOT rewritten by a verification', row.sessionEncrypted === before.sessionEncrypted);
    check('  hash/version/source untouched', row.cookieHash === 'hashA' && Number(row.bundleVersion) === 7
      && row.activeSource.deviceId === 'dev-A');
    check('  the label and unrelated fields are untouched', row.label === 'selftest' && row.isPrimary === true);
  }

  // ── (7) A REJECTED VERDICT LEAVES NO TRACE IN MEMORY EITHER ────────────────────────────────
  // One caller (proxyTools' Claude planDetected path) calls account.save() AFTER verifyAndApply.
  // If the rejected verdict were still sitting on the in-memory document, that unguarded whole-doc
  // save would persist exactly what the database refused.
  {
    const id = newId('mem');
    await seed(id);
    const verifier = await load(id);
    let release;
    const gate = new Promise((r) => { release = r; });
    verifyImpl = async () => { await gate; return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' }; };
    const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
    const other = await load(id);
    other.cookieHash = 'hashB'; other.bundleVersion = 8;
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 8 };
    await other.save();
    release();
    await inflight;
    check('the in-memory doc shows no rejected verdict', verifier.session_status === 'working'
      && (!verifier.verification || verifier.verification.canary !== 'failed'),
      { ss: verifier.session_status, v: verifier.verification });
    // ...and even a later unguarded save by that caller cannot resurrect it.
    await verifier.save();
    const row = await raw(id);
    check('a later caller-owned save cannot persist the refused verdict', row.session_status !== 'needs_login'
      && !(row.verification && row.verification.canary === 'failed'),
      { ss: row.session_status, v: row.verification });
  }

  // ── cleanup ───────────────────────────────────────────────────────────────────────────────
  for (const id of IDS) { try { await ProxyAccount.deleteOne({ _id: id }); } catch (_) {} }
  const leftovers = [];
  for (const id of IDS) { if (await raw(id)) leftovers.push(id); }
  check('every throwaway row was removed', leftovers.length === 0, leftovers);

  console.log(`\n[selftest] ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('[selftest] crashed:', e && e.stack || e); process.exitCode = 1; });

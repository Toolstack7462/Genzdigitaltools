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
const DEFAULT_VERIFY = verifyImpl;
verifyMod.verifyAccountCookies = async (...a) => verifyImpl(...a);

const adapter = require('../db/mysqlAdapter');
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
/** claude.ai is its own cookie session on its own host - a writehuman bundle attaches nothing. */
const claudeBundle = () => ({
  cookies: [{ name: 'sessionKey', value: 'sk-ant-selftest-not-a-real-key', domain: '.claude.ai', path: '/' }],
});
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

// `id` is VARCHAR(32), so no timestamp: 'selftest-vg-' + a tag stays inside it, and the scratch
// schema is created fresh for every run and these rows are deleted at the end, so uniqueness
// across runs buys nothing. The `selftest-` prefix is still not a valid ProxyAccount id, so one of
// these can never collide with a real account.
// ── the REAL admin router, for case (8) ───────────────────────────────────────
//
// Only AUTH is stubbed, and it is stubbed in require.cache BEFORE the router loads because the
// router destructures { requireAuth, requireAdmin, getClientIp } at module load. Everything else -
// the route body, the model, verifyAndApply, the response shape - is the real thing, so this
// exercises the production-reachable sequence rather than a ported copy of the handler.
const authPath = require.resolve('../middleware/authEnhanced');
const realAuth = require(authPath);
require.cache[authPath].exports = Object.assign({}, realAuth, {
  requireAuth: (req, _res, next) => { req.userId = 'selftest-admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  getClientIp: () => '127.0.0.1',
});
const express = require('express');
const adminProxyTools = require('../routes/admin/proxyTools');
let ADMIN_PORT = 0, adminServer = null;
async function startAdmin() {
  const app = express();
  app.use(express.json());
  app.use('/api/crm/admin/proxy', adminProxyTools);
  await new Promise((resolve) => {
    adminServer = require('http').createServer(app);
    adminServer.listen(0, '127.0.0.1', () => { ADMIN_PORT = adminServer.address().port; resolve(); });
  });
}
async function adminPost(p, body) {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

const IDS = [];
const newId = (n) => {
  const id = 'selftest-vg-' + n;
  if (id.length > 32) throw new Error('selftest id exceeds the id column (VARCHAR(32)): ' + id);
  IDS.push(id);
  return id;
};

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

  // The adapter opens its pool explicitly at startup; nothing here can read or write until it
  // has. Done AFTER the isolation proof above, so a refusal never opens a pool at all.
  await adapter.connect();
  await startAdmin();

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

  // ── (7) A REJECTED VERDICT LEAVES NO TRACE, AND CANNOT COST THE NEWER BUNDLE ─────────
  //
  // CORRECTION TO AN EARLIER CLAIM. This case used to be described as covering "proxyTools' Claude
  // planDetected path, which calls account.save() after verifyAndApply". That was wrong about
  // reachability: on a REJECTED verdict verifyAndApply returns `v: null`, and that caller's branch
  // is guarded on `r.v && r.v.plan`, so it never runs in the rejected case. The save below is a
  // HYPOTHETICAL worst case - any caller that saved its own snapshot anyway - not the production
  // sequence. The production-reachable sequence is the SUCCESS path, in (8).
  //
  // It also used to assert only that needs_login / canary:'failed' were not persisted. That does
  // not prove the thing that actually matters: that B's bundle survived. It now checks the whole
  // record after every subsequent write.
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
    other.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle(9000)));
    other.activeSource = { deviceId: 'dev-B', name: 'RDP-B', promotedAt: new Date(), bundleVersion: 8 };
    await other.save();
    const b = await raw(id);

    release();
    const res = await inflight;
    check('rejected: verifyAndApply returns v:null, so the Claude plan branch is UNREACHABLE here',
      res.result === 'stale_subject' && res.v === null, { result: res.result, v: res.v });
    check('rejected: the in-memory doc carries no verdict', verifier.session_status === 'working'
      && (!verifier.verification || verifier.verification.canary !== 'failed'),
      { ss: verifier.session_status, v: verifier.verification });

    // The hypothetical: some caller saves its own snapshot anyway.
    //
    // MEASURED RESULT, and it is NOT a clean pass - recorded as the truth rather than asserted
    // away. The refused VERDICT does not come back, because verifyAndApply rolls those fields back
    // in memory. But the verifier's snapshot still holds the bundle it loaded, so a whole-document
    // save reverts B to A. That is inherent to writing a whole document from a stale snapshot; it
    // cannot be fixed from inside verifyAndApply, and fixing it inside Document.save() would change
    // persistence for every model in the system.
    //
    // It is not exploitable on any production path, and the check above this proves why rather than
    // claiming it: the rejected verdict returns v:null, so the one caller that saves after
    // verifyAndApply never runs. It is exactly why that caller's save was narrowed to a conditional
    // field write, and why verifyAndApply no longer saves whole documents at all. These assertions
    // pin the real behaviour, so if a future change makes a stale save safe - or makes one
    // reachable - this file notices.
    await verifier.save();
    let row = await raw(id);
    check('hypothetical save: the refused verdict is still not persisted',
      row.session_status !== 'needs_login' && !(row.verification && row.verification.canary === 'failed'),
      { ss: row.session_status, v: row.verification });
    check('hypothetical save: unrelated fields are untouched', row.label === 'selftest' && row.isPrimary === true,
      { label: row.label, isPrimary: row.isPrimary });
    check('hypothetical save: a stale whole-document save DOES revert the bundle (documented limitation, no production caller does one)',
      row.cookieHash === 'hashA' && Number(row.bundleVersion) === 7
      && row.activeSource && row.activeSource.deviceId === 'dev-A'
      && row.sessionEncrypted !== b.sessionEncrypted,
      { hash: row.cookieHash, v: row.bundleVersion, src: row.activeSource && row.activeSource.deviceId });

    // Repeating it is at least idempotent - it does not keep drifting further.
    const after1 = await raw(id);
    await verifier.save();
    row = await raw(id);
    check('a SECOND hypothetical save changes nothing further (idempotent)',
      row.cookieHash === after1.cookieHash && Number(row.bundleVersion) === Number(after1.bundleVersion)
      && row.sessionEncrypted === after1.sessionEncrypted
      && row.session_status === after1.session_status,
      { hash: row.cookieHash, v: row.bundleVersion });
  }

  // ── (8) THE PRODUCTION-REACHABLE CALLER SAVE: admin Verify on CLAUDE, on SUCCESS ───────
  //
  // This is the sequence that really exists. POST /:tool/accounts/:id/verify succeeds, and for
  // claude the route then records the detected plan. That write runs AFTER an external provider
  // round-trip on a document loaded BEFORE it, so an operator who changed the plan or any other
  // field meanwhile would be overwritten by a whole-document save.
  //
  // Driven through the REAL router (real model, real verifyAndApply, real route body) with only
  // auth and the provider stubbed - not a ported copy of the handler.
  {
    const id = newId('claude');
    await ProxyAccount.create({
      _id: id, tool: 'claude', isPrimary: true, label: 'selftest-claude',
      status: 'active', session_status: 'working', plan: 'unknown', notes: 'original note',
      sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(claudeBundle())),
    });
    IDS.push(id);

    let release;
    const gate = new Promise((r) => { release = r; });
    verifyImpl = async () => { await gate; return { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', plan: 'pro' }; };

    const inflight = adminPost(`/api/crm/admin/proxy/claude/accounts/${id}/verify`);

    // While the provider is answering, the operator picks a plan AND edits a note.
    await new Promise((r) => setTimeout(r, 50));
    const operator = await load(id);
    operator.plan = 'max20';
    operator.notes = 'operator edit during verification';
    await operator.save();

    release();
    const resp = await inflight;
    const row = await raw(id);
    check('claude verify succeeded through the real route', resp.status === 200, resp.status);
    check('the operator PLAN selection survives the verification write', row.plan === 'max20', row.plan);
    check('the operator NOTE survives too', row.notes === 'operator edit during verification', row.notes);
    check('the verification verdict still landed', row.verification && row.verification.result === 'working',
      row.verification);
    check('no stale planDetected overwrote a manual choice',
      !(row.planDetected && row.plan !== 'max20'), { plan: row.plan, detected: row.planDetected });

    // UNCONTENDED: with no operator edit the detection is recorded and adopted as before, so the
    // guard has not simply disabled the feature.
    const id2 = newId('claude2');
    await ProxyAccount.create({
      _id: id2, tool: 'claude', isPrimary: false, label: 'selftest-claude2',
      status: 'active', session_status: 'working', plan: 'unknown',
      sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(claudeBundle())),
    });
    IDS.push(id2);
    verifyImpl = async () => ({ result: 'working', httpStatus: 200, maskedId: 'op***@example.com', plan: 'max5' });
    const r2 = await adminPost(`/api/crm/admin/proxy/claude/accounts/${id2}/verify`);
    const row2 = await raw(id2);
    check('uncontended: the detected plan is still recorded', r2.status === 200
      && row2.planDetected && row2.planDetected.plan === 'max5', { s: r2.status, d: row2.planDetected });
    check('uncontended: it is adopted while the operator plan was unknown', row2.plan === 'max5', row2.plan);
    verifyImpl = DEFAULT_VERIFY;
  }

  // ── (9) THE PROOF INVARIANT, SWEPT OVER EVERY ROW THIS RUN TOUCHED ─────────────────
  //
  // candidateSync has the same await-then-save shape as the verifier did: it verifies a candidate
  // (external call) and then saves the whole document. That is PRE-EXISTING and unchanged by this
  // release - the save is the same statement it always was; this release only added `canary` and
  // `subject` to the verification object written inside it. It is NOT silently called safe: a lost
  // concurrent promotion is a real sync/availability concern, separately tracked, with
  // trusted-ordering, hash comparison, STALE_BUNDLE refusals, device authority and rollbackBundles
  // already in that path.
  //
  // What matters for THIS release is narrower: can any writer leave a row whose recorded proof
  // describes a bundle that is not the stored one? That is the single guarantee the agent's halt
  // resolution rests on. It cannot, and structurally rather than luckily: every writer puts the
  // bundle and its own verification+subject in the SAME document write, so whoever lands last
  // leaves an internally consistent row. A lost promotion costs a bundle, never a false proof.
  //
  // This sweeps that invariant across every row the run touched - after all the interleavings
  // above, including the late-positive, late-negative, source-only and double-save cases.
  {
    let swept = 0, bad = [];
    for (const id of IDS) {
      const row = await raw(id);
      if (!row) continue;
      swept++;
      const v = row.verification || null;
      const subj = (v && v.subject) || null;
      if (!subj) continue;                       // no claim recorded -> nothing to contradict
      const hashOk = String(subj.cookieHash == null ? '' : subj.cookieHash) === String(row.cookieHash == null ? '' : row.cookieHash);
      const verOk = Number(subj.bundleVersion || 0) === Number(row.bundleVersion || 0);
      if (!hashOk || !verOk) {
        bad.push({ id, subject: subj, storedHash: row.cookieHash, storedVersion: row.bundleVersion });
      }
    }
    check(`proof invariant holds on every stored row (${swept} swept)`, bad.length === 0, bad);
    check('the sweep actually inspected rows', swept > 0, swept);
  }

  // ── cleanup ───────────────────────────────────────────────────────────────────────────────
  for (const id of IDS) { try { await ProxyAccount.deleteOne({ _id: id }); } catch (_) {} }
  const leftovers = [];
  for (const id of IDS) { if (await raw(id)) leftovers.push(id); }
  check('every throwaway row was removed', leftovers.length === 0, leftovers);

  console.log(`\n[selftest] ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})()
  .catch((e) => { console.error('[selftest] crashed:', e && e.stack || e); process.exitCode = 1; })
  // CLOSE THE POOL, ALWAYS.
  //
  // The first complete run printed `26 passed, 0 failed` on all three engines and was then
  // CANCELLED at the job's 12-minute timeout: adapter.connect() opens a mysql2 pool, an open
  // pool keeps the event loop alive, and setting process.exitCode does not exit - it only
  // decides the code for when the loop drains. So every check was green and the job still went
  // red, which is the worst possible failure shape for a gate.
  //
  // Deliberately NOT process.exit(): that is exactly what produced the Windows 0xC0000409
  // abort in verify-agent-distribution.cjs by tearing down mid-close. Draining the pool and
  // letting node exit on its own keeps the exit code readable.
  .finally(async () => {
    try { if (adminServer) adminServer.close(); } catch (_) {}
    try { await adapter.close(); } catch (_) {}
  });

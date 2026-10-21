'use strict';

/**
 * REAL-ENGINE self-test for Business CRM financial safety.
 *
 * WHY: the Release 1 UI tests prove what the browser SENDS (one request per intended payment, a
 * stable key, a frozen payload on an unknown outcome). They cannot prove what the ENGINE does with
 * a repeated key under concurrency, whether a balance can be overpaid by two simultaneous writers,
 * or whether a replay produces a second financial row and a second audit event. Those are
 * transaction-isolation and locking questions, and only a real database answers them.
 *
 * It exercises the REAL services (`services/paymentService`, `services/salesService`) against the
 * REAL schema (`modules/business-crm/schema.sql`), not a reimplementation.
 *
 * SAFETY, same contract as scripts/extcredsync-db-selftest.js:
 *   - refuses to run without CRM_SELFTEST_DB=1;
 *   - refuses unless CRM_SELFTEST_EXPECTED_DB matches the live `SELECT DATABASE()`;
 *   - refuses if the connecting account holds any `ON *.*` grant beyond the baseline USAGE, i.e.
 *     if it could reach another schema;
 *   - creates its own throwaway contacts/sales and no customer record is read or written.
 * It is a dev/CI utility and is NOT part of the production deploy set.
 *
 *   DATABASE_URL="mysql://user:pass@127.0.0.1:3306/crm_scratch" \
 *   CRM_SELFTEST_DB=1 CRM_SELFTEST_EXPECTED_DB=crm_scratch node scripts/crm-db-selftest.js
 *
 * Exit 0 = every case passed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!/^(1|true|yes)$/i.test(String(process.env.CRM_SELFTEST_DB || ''))) {
  console.error('REFUSING TO RUN: set CRM_SELFTEST_DB=1 and point DATABASE_URL at an ISOLATED scratch database.');
  process.exit(2);
}
const EXPECTED_DB = String(process.env.CRM_SELFTEST_EXPECTED_DB || '');
if (!EXPECTED_DB) {
  console.error('REFUSING TO RUN: set CRM_SELFTEST_EXPECTED_DB to the scratch database name you provisioned.');
  process.exit(2);
}

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'business-crm');
const db = require(path.join(MODULE_DIR, 'db'));
const payments = require(path.join(MODULE_DIR, 'services', 'paymentService'));
const sales = require(path.join(MODULE_DIR, 'services', 'salesService'));

let passed = 0; let failed = 0;
function check(name, condition, extra) {
  if (condition) { passed += 1; console.log('  ✓', name); }
  else { failed += 1; console.error('  ✗', name, extra != null ? JSON.stringify(extra) : ''); }
}

// A request object shaped like the one the routes build, with no HTTP involved. The actor carries
// the module's full permission set: route-level authorisation is covered by the mocked route tests
// and by businessCrmAuditResponse.test.js, whereas THIS script is about engine behaviour -
// locking, replay and balance arithmetic. An under-permissioned actor here only hides those.
// (First CI run failed exactly this way: createSale refused the opening payment with "Client
// receipt permission is required" - a harness defect, not a product one.)
const { PERMISSIONS } = require(path.join(MODULE_DIR, 'permissions'));
const makeReq = (userId) => ({ userId, user: { _id: userId }, headers: {}, get: () => 'crm-selftest', ip: '127.0.0.1', businessAccess: { role: 'OWNER', permissions: PERMISSIONS.slice() } });

const ACTOR = 'selftest-actor-1';
const OTHER_ACTOR = 'selftest-actor-2';

async function applySchema() {
  const sql = fs.readFileSync(path.join(MODULE_DIR, 'schema.sql'), 'utf8');
  const statements = typeof db.splitSql === 'function' ? db.splitSql(sql) : sql.split(/;\s*\n/);
  const pool = db.getPool();
  for (const statement of statements) {
    const text = String(statement || '').trim();
    if (!text || text.startsWith('--')) continue;
    await pool.query(text);
  }
}

async function seedSale({ currency = 'PKR', total = '1000.00', cost = '400.00' } = {}) {
  const pool = db.getPool();
  const clientId = crypto.randomUUID();
  const vendorId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  await pool.query('INSERT INTO biz_crm_clients (id,name,status,created_by) VALUES (?,?,?,?)', [clientId, 'Selftest Client', 'active', ACTOR]);
  await pool.query('INSERT INTO biz_crm_vendors (id,name,status,created_by) VALUES (?,?,?,?)', [vendorId, 'Selftest Vendor', 'active', ACTOR]);
  await pool.query(
    `INSERT INTO biz_crm_sales (id,invoice_number,client_id,vendor_id,sale_date,order_type,currency_code,subtotal_sale,subtotal_cost,client_paid,vendor_paid,status,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,'0.00','0.00','open',?)`,
    [saleId, `SELF-${Date.now()}-${Math.floor(Math.random() * 1000)}`, clientId, vendorId, '2026-10-01', 'new', currency, total, cost, ACTOR],
  );
  return { saleId, clientId, vendorId };
}

const countPayments = async (saleId) => {
  const rows = await db.query('SELECT COUNT(*) c FROM biz_crm_payments WHERE sale_id=:id', { id: saleId });
  return Number(rows[0].c);
};
const countAudit = async (entityType) => {
  const rows = await db.query('SELECT COUNT(*) c FROM biz_crm_audit_logs WHERE entity_type=:t', { t: entityType });
  return Number(rows[0].c);
};
const clientPaid = async (saleId) => {
  const rows = await db.query('SELECT client_paid FROM biz_crm_sales WHERE id=:id', { id: saleId });
  return String(rows[0].client_paid);
};

(async () => {
  // ── identity + privilege isolation, before any write ─────────────────────────────────────────
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [[ident]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS ver');
  let grants = [];
  try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER()'); grants = g.map((r) => String(Object.values(r)[0] || '')); } catch (_) { grants = []; }
  await conn.end();
  console.log(`[crm-selftest] db=${ident.db} user=${ident.usr} engine=${ident.ver}`);
  if (String(ident.db) !== EXPECTED_DB) {
    console.error(`REFUSING TO RUN: connected to "${ident.db}" but CRM_SELFTEST_EXPECTED_DB is "${EXPECTED_DB}".`);
    process.exit(2);
  }
  const globalGrants = grants.filter((line) => /\sON\s+\*\.\*/i.test(line) && !/^GRANT\s+USAGE\s+ON\s+\*\.\*/i.test(line));
  if (globalGrants.length) {
    console.error('REFUSING TO RUN: the connecting account holds a global grant and could reach other schemas:', globalGrants);
    process.exit(2);
  }

  await applySchema();
  console.log('[crm-selftest] schema applied\n');

  // ── 1. the SAME key, sent twice, is ONE financial operation ─────────────────────────────────
  {
    const { saleId } = await seedSale();
    const key = crypto.randomUUID();
    const payload = { partyType: 'client', amount: '250.00', paymentDate: '2026-10-02', idempotencyKey: key };
    const auditBefore = await countAudit('payment');
    const first = await payments.recordPayment(makeReq(ACTOR), saleId, payload);
    const second = await payments.recordPayment(makeReq(ACTOR), saleId, payload);

    check('repeated key creates ONE payment row', await countPayments(saleId) === 1, await countPayments(saleId));
    check('repeated key reports the second call as a replay', second.replayed === true && first.replayed === false);
    check('repeated key returns the SAME payment id', String(first.payment.id) === String(second.payment.id));
    check('repeated key moves the balance ONCE', await clientPaid(saleId) === '250.00', await clientPaid(saleId));
    check('repeated key writes ONE audit event', (await countAudit('payment')) - auditBefore === 1);
  }

  // ── 2. the same key sent CONCURRENTLY is still one operation ────────────────────────────────
  {
    const { saleId } = await seedSale();
    const key = crypto.randomUUID();
    const payload = { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', idempotencyKey: key };
    const results = await Promise.allSettled([
      payments.recordPayment(makeReq(ACTOR), saleId, payload),
      payments.recordPayment(makeReq(ACTOR), saleId, payload),
      payments.recordPayment(makeReq(ACTOR), saleId, payload),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    check('concurrent same-key payments create ONE row', await countPayments(saleId) === 1, { rows: await countPayments(saleId), settled: results.map((r) => r.status) });
    check('concurrent same-key payments leave ONE balance movement', await clientPaid(saleId) === '100.00', await clientPaid(saleId));
    check('at least one concurrent caller succeeded', ok.length >= 1, results.map((r) => r.status));
  }

  // ── 3. a DIFFERENT key is a genuinely separate payment ──────────────────────────────────────
  {
    const { saleId } = await seedSale();
    await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() });
    await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '150.00', paymentDate: '2026-10-03', idempotencyKey: crypto.randomUUID() });
    check('two distinct keys create TWO payments', await countPayments(saleId) === 2, await countPayments(saleId));
    check('two distinct keys sum into the balance', await clientPaid(saleId) === '250.00', await clientPaid(saleId));
  }

  // ── 4. overpayment is refused, including under concurrency ──────────────────────────────────
  {
    const { saleId } = await seedSale({ total: '100.00' });
    let refused = 0;
    try { await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '150.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() }); }
    catch (error) { refused += 1; check('a single overpayment is refused with PAYMENT_EXCEEDS_BALANCE', error.code === 'PAYMENT_EXCEEDS_BALANCE', error.code); }
    check('the refused overpayment wrote nothing', await countPayments(saleId) === 0 && await clientPaid(saleId) === '0.00');

    const results = await Promise.allSettled([
      payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '60.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() }),
      payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '60.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() }),
    ]);
    const paid = Number(await clientPaid(saleId));
    check('two concurrent payments cannot together exceed the invoice', paid <= 100, { paid, settled: results.map((r) => r.status) });
  }

  // ── 5. a key belonging to a different operation is rejected, not silently replayed ──────────
  {
    const { saleId } = await seedSale();
    const key = crypto.randomUUID();
    await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', idempotencyKey: key });
    let conflict = null;
    try { await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '999.00', paymentDate: '2026-10-02', idempotencyKey: key }); }
    catch (error) { conflict = error.code; }
    check('the same key with a DIFFERENT amount is refused', conflict === 'PAYMENT_IDEMPOTENCY_CONFLICT', conflict);

    let otherUser = null;
    try { await payments.recordPayment(makeReq(OTHER_ACTOR), saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', idempotencyKey: key }); }
    catch (error) { otherUser = error.code; }
    check('the same key from a DIFFERENT actor is refused', otherUser === 'PAYMENT_IDEMPOTENCY_CONFLICT', otherUser);
    check('neither refusal created a row', await countPayments(saleId) === 1, await countPayments(saleId));
  }

  // ── 6. THE BOUNDARY THE UI DEPENDS ON: metadata is NOT compared on replay ────────────────────
  {
    const { saleId } = await seedSale();
    const key = crypto.randomUUID();
    await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', method: 'Cash', reference: 'ORIGINAL', idempotencyKey: key });
    const replay = await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-12-31', method: 'Bank', reference: 'EDITED', idempotencyKey: key });
    check('a replay keeps the ORIGINAL metadata (date/method/reference are not compared)',
      replay.replayed === true && String(replay.payment.reference) === 'ORIGINAL' && String(replay.payment.method) === 'Cash',
      { replayed: replay.replayed, reference: replay.payment.reference, method: replay.payment.method });
    check('the replay did not create a second row', await countPayments(saleId) === 1);
  }

  // ── 7. currencies stay separate ─────────────────────────────────────────────────────────────
  {
    const pkr = await seedSale({ currency: 'PKR', total: '1000.00' });
    const inr = await seedSale({ currency: 'INR', total: '1000.00' });
    await payments.recordPayment(makeReq(ACTOR), pkr.saleId, { partyType: 'client', amount: '100.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() });
    const inrPaid = await clientPaid(inr.saleId);
    check('a PKR payment does not move an INR invoice', inrPaid === '0.00', inrPaid);
    const rows = await db.query('SELECT currency_code FROM biz_crm_payments WHERE sale_id=:id', { id: pkr.saleId });
    check('the payment inherits the invoice currency', rows[0] && rows[0].currency_code === 'PKR', rows[0]);
  }

  // ── 8. sale creation: a repeated key does not duplicate the invoice or its opening payment ──
  {
    const pool = db.getPool();
    const clientId = crypto.randomUUID();
    await pool.query('INSERT INTO biz_crm_clients (id,name,status,created_by) VALUES (?,?,?,?)', [clientId, 'Selftest Sale Client', 'active', ACTOR]);
    const key = crypto.randomUUID();
    const payload = {
      clientId, vendorId: null, saleDate: '2026-10-05', orderType: 'new', currencyCode: 'PKR',
      items: [{ name: 'Selftest item', accountType: 'private', salePrice: '500.00', purchaseCost: '200.00' }],
      openingClientPayment: '100.00', openingVendorPayment: '0.00', idempotencyKey: key,
    };
    const before = await db.query('SELECT COUNT(*) c FROM biz_crm_sales WHERE client_id=:id', { id: clientId });
    const first = await sales.createSale(makeReq(ACTOR), payload);
    const second = await sales.createSale(makeReq(ACTOR), payload);
    const after = await db.query('SELECT COUNT(*) c FROM biz_crm_sales WHERE client_id=:id', { id: clientId });

    check('a repeated sale key creates ONE sale', Number(after[0].c) - Number(before[0].c) === 1, { before: before[0].c, after: after[0].c });
    check('a repeated sale key returns the same sale id', String(first.id) === String(second.id));
    const openings = await db.query('SELECT COUNT(*) c FROM biz_crm_payments WHERE sale_id=:id', { id: first.id });
    check('the opening payment is not posted twice', Number(openings[0].c) === 1, openings[0].c);
    const invoices = await db.query('SELECT COUNT(DISTINCT invoice_number) c FROM biz_crm_sales WHERE client_id=:id', { id: clientId });
    check('only one invoice number was consumed', Number(invoices[0].c) === 1, invoices[0].c);
  }

  // ── 9. reversal keeps the ledger and the history honest ─────────────────────────────────────
  {
    const { saleId } = await seedSale();
    const made = await payments.recordPayment(makeReq(ACTOR), saleId, { partyType: 'client', amount: '300.00', paymentDate: '2026-10-02', idempotencyKey: crypto.randomUUID() });
    check('balance moved before reversal', await clientPaid(saleId) === '300.00', await clientPaid(saleId));

    await payments.reversePayment(makeReq(ACTOR), made.payment.id, 'selftest reversal');
    check('reversal returns the balance to zero', await clientPaid(saleId) === '0.00', await clientPaid(saleId));
    check('reversal is append-only - the original row survives',
      (await db.query('SELECT COUNT(*) c FROM biz_crm_payments WHERE id=:id', { id: made.payment.id }))[0].c === 1);

    let doubleReverse = null;
    try { await payments.reversePayment(makeReq(ACTOR), made.payment.id, 'again'); } catch (error) { doubleReverse = error.code || error.message; }
    check('a payment cannot be reversed twice', doubleReverse !== null, doubleReverse);
    check('the balance is unchanged after the refused second reversal', await clientPaid(saleId) === '0.00', await clientPaid(saleId));
  }

  console.log(`\n[crm-selftest] passed=${passed} failed=${failed}`);
  await db.close().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('[crm-selftest] fatal:', error && error.stack ? error.stack : error);
  process.exit(1);
});

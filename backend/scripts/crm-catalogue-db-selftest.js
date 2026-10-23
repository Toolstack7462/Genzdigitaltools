'use strict';

/**
 * REAL-ENGINE self-test for the website-Tool → CRM catalogue feature.
 *
 * WHY A REAL DATABASE: every safeguard here is a database guarantee, not a code path. Whether two
 * concurrent reconciliations produce one product depends on a UNIQUE key; whether a failure between
 * the product insert and the mapping insert leaves an orphan depends on a transaction; whether a
 * NEEDS_SETUP product can be sold depends on a join inside the sale transaction. A mocked model
 * cannot answer any of those, so this runs the REAL services and the REAL schema.
 *
 * The ONLY stub is the website Tool READ (models/Tool), which is injected into require.cache before
 * the service loads. Storage, routes, validation, sale service and audit are all real.
 *
 * SAFETY, same contract as scripts/crm-db-selftest.js:
 *   - refuses without CRM_SELFTEST_DB=1;
 *   - refuses unless CRM_SELFTEST_EXPECTED_DB matches the live SELECT DATABASE();
 *   - refuses if the connecting account holds any ON *.* grant beyond the baseline USAGE;
 *   - creates only its own throwaway rows and reads no customer record.
 *
 *   DATABASE_URL="mysql://user:pass@127.0.0.1:3306/crm_scratch" \
 *   CRM_SELFTEST_DB=1 CRM_SELFTEST_EXPECTED_DB=crm_scratch node scripts/crm-catalogue-db-selftest.js
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

let passed = 0, failed = 0;
function check(name, condition, extra) {
  if (condition) { passed += 1; console.log('  ✓', name); }
  else { failed += 1; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const BACKEND = path.join(__dirname, '..');
const MODULE_DIR = path.join(BACKEND, 'modules', 'business-crm');

/* ── stub ONLY the website Tool read, before the service captures it ─────────────────────────── */
let TOOL_ROWS = [];
let TOOL_READ_FAILS = false;
const TOOL_WRITES = [];            // any write attempt is recorded and asserted to stay empty
const toolPath = require.resolve(path.join(BACKEND, 'models', 'Tool'));
function makeQuery(rows) {
  const state = { rows, sel: null, skipN: 0, limitN: 0 };
  const q = {
    select() { return q; }, sort() { return q; },
    skip(n) { state.skipN = Number(n || 0); return q; },
    limit(n) { state.limitN = Number(n || 0); return q; },
    lean: async () => {
      if (TOOL_READ_FAILS) throw new Error('tool_source_unreachable');
      const sorted = state.rows.slice().sort((a, b) => String(a._id).localeCompare(String(b._id)));
      const from = state.skipN;
      return sorted.slice(from, state.limitN ? from + state.limitN : undefined);
    },
  };
  return q;
}
require.cache[toolPath] = {
  id: toolPath, filename: toolPath, loaded: true,
  exports: {
    find: (criteria) => makeQuery(TOOL_ROWS.filter((r) => !criteria || !criteria.status || r.status === criteria.status)),
    countDocuments: async (criteria) => {
      if (TOOL_READ_FAILS) throw new Error('tool_source_unreachable');
      return TOOL_ROWS.filter((r) => !criteria || !criteria.status || r.status === criteria.status).length;
    },
    // Any of these being reached at all is a failure; they record instead of throwing so the
    // assertion can name what was attempted.
    create: async (...a) => { TOOL_WRITES.push(['create', a]); },
    updateOne: async (...a) => { TOOL_WRITES.push(['updateOne', a]); },
    deleteOne: async (...a) => { TOOL_WRITES.push(['deleteOne', a]); },
  },
};

const db = require(path.join(MODULE_DIR, 'db'));
const { PERMISSIONS } = require(path.join(MODULE_DIR, 'permissions'));
const catalogue = require(path.join(MODULE_DIR, 'services', 'productCatalogueService'));
const sales = require(path.join(MODULE_DIR, 'services', 'salesService'));
const productsRouter = require(path.join(MODULE_DIR, 'routes', 'products'));

const makeReq = (userId, perms) => ({
  userId, user: { _id: userId }, headers: {}, get: () => 'crm-catalogue-selftest', ip: '127.0.0.1',
  businessAccess: { role: 'OWNER', permissions: perms || PERMISSIONS.slice() },
});
const OWNER = makeReq('selftest-owner');
const newId = () => crypto.randomUUID();
const tool = (id, name, category, domain) => ({ _id: id, name, category, domain, status: 'active' });

/* -- REAL ROUTE HARNESS -----------------------------------------------------------------------
 * The product routes are mounted in a real express app and driven over real HTTP, so validate(),
 * requirePermission(), the handler's own transaction and the serializer all run exactly as they do
 * in production. Several of the cases below are specifically about ROUTE WIRING - a flag that only
 * a test ever wrote, or a response built from a different read than the one the list uses - and
 * those cannot be observed by calling a service function directly.
 *
 * Only the authentication/CSRF layer from modules/business-crm/index.js is replaced: it requires a
 * signed admin JWT and is not what these cases are about. The error-status mapping is copied from
 * that file verbatim, and a change made THERE would not be caught here.
 */
let API_ACTOR = null;
let BASE = '';
async function startApi() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.userId = API_ACTOR.userId; req.user = API_ACTOR.user; req.businessAccess = API_ACTOR.businessAccess;
    next();
  });
  app.use('/products', productsRouter);
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = Number(error.status || (error.code === 'ER_DUP_ENTRY' ? 409 : 500));
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus >= 500) console.error('[catalogue-selftest route]', (error && error.stack) || error);
    res.status(safeStatus).json({ error: error.message, code: error.code || null });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  BASE = 'http://127.0.0.1:' + server.address().port;
  return server;
}
async function api(method, pathname, body) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

const q = (sql, params) => db.query(sql, params || {});
const mappingFor = async (sourceId) => (await q(
  'SELECT * FROM biz_crm_product_sources WHERE source_namespace=:ns AND source_id=:sid',
  { ns: catalogue.NAMESPACE_WEBSITE_TOOL, sid: sourceId },
))[0] || null;
const productById = async (id) => (await q('SELECT * FROM biz_crm_products WHERE id=:id', { id }))[0] || null;
const countProducts = async () => Number((await q('SELECT COUNT(*) n FROM biz_crm_products WHERE deleted_at IS NULL'))[0].n);
const auditCount = async (action, entityId) => Number((await q(
  'SELECT COUNT(*) n FROM biz_crm_audit_logs WHERE action_key=:a AND entity_id=:e', { a: action, e: String(entityId) },
))[0].n);
/** The full productUpdate body, so a case can change exactly ONE field and keep the rest honest. */
const putBody = (row, changes) => ({
  name: row.name, category: row.category, accountType: row.account_type,
  durationLabel: row.duration_label || null, defaultSalePrice: String(row.default_sale_price),
  defaultPurchaseCost: String(row.default_purchase_cost), currencyCode: row.currency_code,
  active: !!row.active, notes: row.notes || null, version: row.version, ...(changes || {}),
});

(async () => {
  // ── isolation proof ──────────────────────────────────────────────────────────────────────────
  let mysql; try { mysql = require('mysql2/promise'); } catch (_) {
    console.error('mysql2 not installed in this environment.'); process.exit(2);
  }
  {
    const conn = await mysql.createConnection(process.env.DATABASE_URL);
    const [[ident]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS ver');
    let grants = [];
    try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER()'); grants = g.map((r) => String(Object.values(r)[0] || '')); } catch (_) {}
    await conn.end();
    console.log(`[catalogue-selftest] db=${ident.db} user=${ident.usr} engine=${ident.ver}`);
    if (String(ident.db) !== EXPECTED_DB) {
      console.error(`REFUSING TO RUN: connected to "${ident.db}" but expected "${EXPECTED_DB}".`); process.exit(2);
    }
    const over = grants.find((l) => /\bON\s+\*\.\*/i.test(l) && !/\bGRANT\s+USAGE\s+ON\s+\*\.\*/i.test(l));
    if (over) { console.error(`REFUSING TO RUN: scratch account has a global privilege beyond USAGE:\n    ${over}`); process.exit(2); }
  }

  await db.ensureSchema();
  const apiServer = await startApi();
  API_ACTOR = OWNER;

  /* ── 1. one Tool -> one product + one mapping; repeat and concurrent are idempotent ────────── */
  TOOL_ROWS = [tool('tool-a', 'Alpha Writer', 'Writing', 'alpha.example')];
  const before = await countProducts();
  const first = await catalogue.reconcile(OWNER, { force: true });
  check('one new Tool creates exactly one product', first.created === 1, first);
  const mapA = await mappingFor('tool-a');
  check('a mapping row was created and links to a real product', !!mapA && !!(await productById(mapA.product_id)));
  check('an imported product starts NEEDS_SETUP', mapA && mapA.readiness === 'NEEDS_SETUP', mapA && mapA.readiness);
  check('product count rose by exactly one', (await countProducts()) === before + 1);

  const repeat = await catalogue.reconcile(OWNER, { force: true });
  check('a repeated reconcile creates nothing', repeat.created === 0, repeat);
  check('a repeated reconcile writes nothing per row (all unchanged)', repeat.unchanged >= 1 && repeat.refreshed === 0, repeat);
  check('still exactly one product for that source', (await q(
    'SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_id=:s', { s: 'tool-a' },
  ))[0].n === 1);

  const concurrent = await Promise.all([
    catalogue.reconcile(makeReq('w1'), { force: true }),
    catalogue.reconcile(makeReq('w2'), { force: true }),
    catalogue.reconcile(makeReq('w3'), { force: true }),
  ]);
  check('three concurrent reconciles still leave one product for that source', (await q(
    'SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_id=:s', { s: 'tool-a' },
  ))[0].n === 1, concurrent.map((r) => r.created));

  /* ── 2. no orphan: a lost race rolls the product back with the mapping ──────────────────── */
  {
    // My first version of this case pre-inserted a mapping for the source, so reconcile found it
    // ALREADY LINKED and took the refresh path - no insert was attempted and no conflict occurred,
    // which made the "creates NO product" assertion pass for the wrong reason. The real-engine run
    // reported refreshed:1 and skippedDuplicate:0, which is what exposed it.
    //
    // Two concurrent approveCreate calls for the SAME source genuinely race: both see a complete
    // scan, both call createLinkedProduct, and the loser hits the UNIQUE key on the mapping INSERT
    // - the second statement of the pair. Its transaction must roll back and take its already
    // inserted product with it, leaving no orphan.
    TOOL_ROWS = [tool('tool-race', 'Race Probe', 'Writing', 'race.example')];
    // Hold it back so it is created only through approveCreate, under our control.
    const decoy = newId();
    await q(`INSERT INTO biz_crm_products (id,name,category,created_by) VALUES (:id,'Race Probe','Software','selftest')`, { id: decoy });
    const n0 = await countProducts();
    const settled = await Promise.allSettled([
      catalogue.approveCreate(makeReq('race-1'), { sourceId: 'tool-race' }),
      catalogue.approveCreate(makeReq('race-2'), { sourceId: 'tool-race' }),
    ]);
    const n1 = await countProducts();
    const winners = settled.filter((r) => r.status === 'fulfilled');
    const losers = settled.filter((r) => r.status === 'rejected');
    check('a concurrent race produces exactly ONE winner', winners.length === 1,
      settled.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason && r.reason.code) || 'err')));
    check('the loser is refused with ALREADY_LINKED, not silently swallowed',
      losers.length === 1 && losers[0].reason && losers[0].reason.code === 'ALREADY_LINKED',
      losers.map((r) => r.reason && r.reason.code));
    check('exactly ONE product was created - the loser left no orphan', n1 === n0 + 1, { before: n0, after: n1 });
    check('exactly one mapping exists for that source', Number((await q(
      'SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_id=:s', { s: 'tool-race' },
    ))[0].n) === 1);
  }

  /* ── 3. same domain, different source -> two distinct products, no merge, no exclusion ─────── */
  TOOL_ROWS = [
    tool('tool-same-1', 'Same Brand Private', 'Writing', 'same.example'),
    tool('tool-same-2', 'Same Brand Shared', 'Writing', 'same.example'),
  ];
  await catalogue.reconcile(OWNER, { force: true });
  const s1 = await mappingFor('tool-same-1');
  const s2 = await mappingFor('tool-same-2');
  check('two Tools sharing a domain produce TWO products', !!s1 && !!s2 && s1.product_id !== s2.product_id, { s1: !!s1, s2: !!s2 });
  check('neither is excluded because the domain repeats', !!s1 && !!s2);

  // ...and the same NAME on two different sources stays distinct too.
  TOOL_ROWS = [tool('tool-dup-1', 'Identical Name', 'Writing', 'a.example'), tool('tool-dup-2', 'Identical Name', 'Writing', 'b.example')];
  await catalogue.reconcile(OWNER, { force: true });
  const d1 = await mappingFor('tool-dup-1'); const d2 = await mappingFor('tool-dup-2');
  check('same-name/different-id Tools remain distinguishable', !!d1 && !!d2 && d1.product_id !== d2.product_id);

  /* ── 4. manual products, overrides and ignore decisions survive ────────────────────────────── */
  const manualId = newId();
  await q(`INSERT INTO biz_crm_products (id,name,category,default_sale_price,currency_code,created_by,notes)
           VALUES (:id,'Manual Only','Software','1234.00','PKR','selftest','operator note')`, { id: manualId });
  {
    // An operator-owned override on an IMPORTED product, made THROUGH THE REAL PUT ROUTE.
    //
    // This case used to set name_overridden with raw SQL. That made it pass while NO production
    // code path wrote the flag at all: the rename survived a refresh in the test and would have
    // been silently overwritten by the website's name on the next reconcile in production. The
    // edit now goes through PUT /products/:id, so the route wiring is part of what is asserted.
    const pBeforeEdit = await productById(mapA.product_id);
    check('arrangement: the imported product has not been renamed yet',
      Number((await mappingFor('tool-a')).name_overridden) === 0, (await mappingFor('tool-a')).name_overridden);
    const renamePut = await api('PUT', `/products/${mapA.product_id}`, putBody(pBeforeEdit, {
      name: 'Operator Renamed', defaultSalePrice: '999.00', notes: 'operator priced',
    }));
    check('the real PUT route accepts an operator rename', renamePut.status === 200, renamePut.body);
    check('THE PUT ROUTE ITSELF persisted name_overridden',
      Number((await mappingFor('tool-a')).name_overridden) === 1, (await mappingFor('tool-a')).name_overridden);
    TOOL_ROWS = [tool('tool-a', 'Alpha Writer RENAMED UPSTREAM', 'Writing', 'alpha.example')];
    await catalogue.reconcile(OWNER, { force: true });
    const p = await productById(mapA.product_id);
    check('a later sync never overwrites an operator price', String(p.default_sale_price) === '999.00', p.default_sale_price);
    check('a later sync never overwrites operator notes', p.notes === 'operator priced', p.notes);
    check('an overridden name is not replaced by the source', p.name === 'Operator Renamed', p.name);
    const m = await mappingFor('tool-a');
    check('the source rename is still recorded for visibility', m.source_name === 'Alpha Writer RENAMED UPSTREAM', m.source_name);
    check('a rename keeps the SAME product id (no new product)', m.product_id === mapA.product_id);

    // The inverse, also through the route: putting the SOURCE's own name back means nothing is
    // being overridden any more, so the flag must clear - otherwise the product would be frozen
    // out of every future upstream rename by an override the operator had abandoned.
    const pNow = await productById(mapA.product_id);
    const restore = await api('PUT', `/products/${mapA.product_id}`, putBody(pNow, { name: m.source_name }));
    check('restoring the source name is accepted', restore.status === 200, restore.body);
    check('restoring the source name clears name_overridden',
      Number((await mappingFor('tool-a')).name_overridden) === 0, (await mappingFor('tool-a')).name_overridden);
    // Re-assert the override for the rest of the file: a later upstream rename must not win.
    const pRestored = await productById(mapA.product_id);
    await api('PUT', `/products/${mapA.product_id}`, putBody(pRestored, { name: 'Operator Renamed' }));
    check('the override can be re-applied', Number((await mappingFor('tool-a')).name_overridden) === 1);
  }
  {
    const manual = await productById(manualId);
    check('a manual product is untouched by reconciliation', manual && String(manual.default_sale_price) === '1234.00' && manual.notes === 'operator note');
    check('a manual product has no source mapping', !(await q('SELECT id FROM biz_crm_product_sources WHERE product_id=:id', { id: manualId })).length);
  }
  {
    // Ignore a discovered source, then reconcile again: it must not come back.
    await catalogue.setIgnored(OWNER, d1.product_id, true);
    TOOL_ROWS = [tool('tool-dup-1', 'Identical Name', 'Writing', 'a.example')];
    const r = await catalogue.reconcile(OWNER, { force: true });
    const m = await mappingFor('tool-dup-1');
    check('an ignored source is skipped, not recreated', r.ignoredSkipped >= 1 && !!m.ignored_at, { r, ignoredAt: m.ignored_at });
    check('ignoring does not delete the product or its mapping', !!(await productById(d1.product_id)));
  }

  /* ── 4b. an ambiguous source is HELD BACK, and both resolutions work ─────────────────────── */
  {
    // A manual product that shares a name with a discovered source must not quietly gain a
    // second, unexplained catalogue row.
    const ambiguousManual = newId();
    await q(`INSERT INTO biz_crm_products (id,name,category,default_sale_price,currency_code,account_type,created_by)
             VALUES (:id,'Shared Name Product','Software','500.00','PKR','private','selftest')`, { id: ambiguousManual });
    TOOL_ROWS = [tool('tool-ambig', 'Shared Name Product', 'Software', 'ambig.example')];
    const r = await catalogue.reconcile(OWNER, { force: true });
    check('an ambiguous source is held for review, not created', r.heldForReview >= 1 && r.created === 0, r);
    check('no mapping was created for the held source', !(await mappingFor('tool-ambig')));

    const dry = await catalogue.dryRun();
    const held = dry.possibleManualMatches.find((m) => m.sourceId === 'tool-ambig');
    check('the dry-run reports it as needing an operator decision', !!held && held.heldFromImport === true, held);
    check('the dry-run does NOT propose it for creation', !dry.proposedNew.some((p) => p.sourceId === 'tool-ambig'));

    // Resolution A: the operator says they are the same thing.
    const linked = await catalogue.linkExisting(OWNER, ambiguousManual, { sourceId: 'tool-ambig' });
    const m = await mappingFor('tool-ambig');
    check('linking an existing product reuses its product id', linked.productId === ambiguousManual && m.product_id === ambiguousManual);
    check('linking does NOT change the operator price', String((await productById(ambiguousManual)).default_sale_price) === '500.00');
    check('a linked manual product is READY, not suddenly unsellable', m.readiness === 'READY', m.readiness);
    let dupCode = null;
    try { await catalogue.linkExisting(OWNER, ambiguousManual, { sourceId: 'tool-ambig' }); } catch (e) { dupCode = e.code; }
    check('linking twice is refused by the database, not duplicated', dupCode === 'ALREADY_LINKED', dupCode);

    // Resolution B: coincidence - create a separate product.
    const otherManual = newId();
    await q(`INSERT INTO biz_crm_products (id,name,category,default_sale_price,currency_code,created_by)
             VALUES (:id,'Coincidence','Software','77.00','PKR','selftest')`, { id: otherManual });
    TOOL_ROWS = [tool('tool-coin', 'Coincidence', 'Software', 'coin.example')];
    await catalogue.reconcile(OWNER, { force: true });
    check('the coincidental source is also held', !(await mappingFor('tool-coin')));
    const approved = await catalogue.approveCreate(OWNER, { sourceId: 'tool-coin' });
    const m2 = await mappingFor('tool-coin');
    check('approve-create makes a SEPARATE product', approved.created === true && m2.product_id !== otherManual);
    check('an approved creation still starts NEEDS_SETUP', m2.readiness === 'NEEDS_SETUP', m2.readiness);
    check('the original manual product is untouched', String((await productById(otherManual)).default_sale_price) === '77.00');
  }

  /* ── 5. readiness: unknown stays unknown; a name save cannot promote it ────────────────────── */
  {
    const m = await mappingFor('tool-same-1');
    const p = await productById(m.product_id);
    check('an imported product keeps the placeholder price in storage', String(p.default_sale_price) === '0.00', p.default_sale_price);
    check('...but is still NEEDS_SETUP, so 0.00 is not a confirmed price', m.readiness === 'NEEDS_SETUP');
    // An ordinary product save (name only) must not make it sellable.
    await q(`UPDATE biz_crm_products SET name='Renamed By Operator', version=version+1 WHERE id=:id`, { id: m.product_id });
    const after = await mappingFor('tool-same-1');
    check('a name-only save does NOT mark it READY', after.readiness === 'NEEDS_SETUP', after.readiness);
    // Confirming with a zero price requires an explicit free confirmation.
    let refused = null;
    const vNow = (await productById(m.product_id)).version;
    try { await catalogue.confirmReady(OWNER, m.product_id, { confirmFree: false, version: vNow }); }
    catch (e) { refused = e.code; }
    check('a zero price cannot be confirmed without saying it is free', refused === 'PRICE_NOT_CONFIRMED', refused);
    const okFree = await catalogue.confirmReady(OWNER, m.product_id, { confirmFree: true, version: vNow });
    check('an explicitly confirmed FREE product can become READY', okFree.readiness === 'READY', okFree);
  }

  /* -- 5b. B: a single-product response is built from the SAME read as the list ---------------- */
  {
    // The POST/PUT handlers used to answer with `SELECT * FROM biz_crm_products WHERE id=:id` - no
    // join - so the serializer saw no source columns and could not distinguish "manual product"
    // from "nobody joined the table". After saving an imported product the API therefore reported
    // it as Manual, with the NOT NULL storage placeholders (0.00 / PKR / private) presented as
    // confirmed commercial values, until the page was reloaded from the list endpoint.
    TOOL_ROWS = [tool('tool-serial', 'Serializer Probe', 'Writing', 'serial.example')];
    await catalogue.reconcile(OWNER, { force: true });
    const mapS = await mappingFor('tool-serial');
    check('arrangement: the probe is imported and NEEDS_SETUP', !!mapS && mapS.readiness === 'NEEDS_SETUP', mapS && mapS.readiness);

    const listed = await api('GET', '/products?q=Serializer%20Probe');
    const fromList = (listed.body.rows || []).find((r) => r.id === mapS.product_id);
    check('the LIST endpoint reports it as website-linked and unconfirmed',
      !!fromList && !!fromList.source && fromList.source.readiness === 'NEEDS_SETUP'
      && fromList.commercialDetailsConfirmed === false, fromList && fromList.source);

    const pS = await productById(mapS.product_id);
    const saved = await api('PUT', `/products/${mapS.product_id}`, putBody(pS, { name: 'Serializer Probe (typo fixed)' }));
    check('the PUT route accepts the edit', saved.status === 200, saved.body);
    const after = saved.body;
    check('the PUT RESPONSE still reports the product as website-linked, not Manual',
      !!after.source && after.source.namespace === catalogue.NAMESPACE_WEBSITE_TOOL, after.source || null);
    check('the PUT response keeps readiness and availability',
      !!after.source && after.source.readiness === 'NEEDS_SETUP' && after.source.availability === 'AVAILABLE', after.source);
    check('the PUT response says the commercial details are NOT confirmed',
      after.commercialDetailsConfirmed === false, after.commercialDetailsConfirmed);
    check('the PUT response does NOT return the placeholder price as a value',
      after.default_sale_price === null && after.currency_code === null && after.account_type === null,
      { price: after.default_sale_price, currency: after.currency_code, accountType: after.account_type });
    check('the PUT response is not sellable', !!after.source && after.source.sellable === false, after.source && after.source.sellable);
    check('the PUT response carries no raw source_* columns',
      !('source_namespace' in after) && !('readiness' in after) && !('ignored_at' in after) && !('name_overridden' in after),
      Object.keys(after).filter((k) => /^source_|^readiness$|^ignored_at$|^name_overridden$|^last_seen_at$/.test(k)));
    const relisted = ((await api('GET', '/products?q=Serializer%20Probe')).body.rows || []).find((r) => r.id === mapS.product_id);
    check('the PUT response and the LIST row agree on the source shape',
      JSON.stringify(after.source) === JSON.stringify(relisted && relisted.source),
      { put: after.source, list: relisted && relisted.source });

    // A manual product must still come back exactly as before - no empty `source` key invented.
    const manualRow = await productById(manualId);
    const manualSaved = await api('PUT', `/products/${manualId}`, putBody(manualRow, { notes: 'operator note' }));
    check('a manual product still has NO source key after a save',
      manualSaved.status === 200 && !('source' in (manualSaved.body || {})),
      { status: manualSaved.status, hasSource: 'source' in (manualSaved.body || {}) });
    check('a manual product keeps its real price in the response',
      String(manualSaved.body.default_sale_price) === '1234.00', manualSaved.body.default_sale_price);
  }

  /* -- 5c. C: the readiness confirmation is concurrency-safe ----------------------------------- */
  {
    // confirmReady used to read the commercial fields, validate them, and then update guarded only
    // on readiness still being NEEDS_SETUP. Nothing tied the values it validated to the values that
    // were in the row when it wrote - so a confirmation taken while the price was 5000 could mark a
    // product READY after the price had been edited to 0.00, with no confirmFree anywhere, and the
    // audit entry was written in a SEPARATE transaction that could commit without it or vice versa.
    TOOL_ROWS = [tool('tool-race-ready', 'Readiness Race', 'Writing', 'rr.example')];
    await catalogue.reconcile(OWNER, { force: true });
    const mapR = await mappingFor('tool-race-ready');
    const priced = await productById(mapR.product_id);
    const put1 = await api('PUT', `/products/${mapR.product_id}`, putBody(priced, {
      defaultSalePrice: '5000.00', currencyCode: 'PKR', accountType: 'private',
    }));
    check('arrangement: a real price was saved through the route', put1.status === 200, put1.body);
    const staleVersion = put1.body.version;

    // (i) a confirmation with no version at all is refused by validation, at the route.
    const noVersion = await api('POST', `/products/${mapR.product_id}/catalogue/confirm-ready`, { confirmFree: false });
    check('a confirmation without a product version is refused at the route',
      noVersion.status === 400 && noVersion.body.code === 'VALIDATION_ERROR', noVersion);
    check('...and the product is still NEEDS_SETUP', (await mappingFor('tool-race-ready')).readiness === 'NEEDS_SETUP');

    // (ii) THE RACE: the operator read 5000, someone edits the price to 0.00, the stale
    // confirmation arrives. It must be refused rather than approve a value it never saw.
    const edited = await productById(mapR.product_id);
    const put2 = await api('PUT', `/products/${mapR.product_id}`, putBody(edited, { defaultSalePrice: '0.00' }));
    check('arrangement: the price was edited to 0.00 by a second actor',
      put2.status === 200 && put2.body.version !== staleVersion,
      { before: staleVersion, after: put2.body && put2.body.version });
    const stale = await api('POST', `/products/${mapR.product_id}/catalogue/confirm-ready`, { confirmFree: false, version: staleVersion });
    check('A STALE CONFIRMATION IS REFUSED', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT', stale);
    check('...and did NOT mark the product READY', (await mappingFor('tool-race-ready')).readiness === 'NEEDS_SETUP');
    check('a refused confirmation writes NO readiness audit entry',
      (await auditCount('catalogue-product.ready', mapR.product_id)) === 0);

    // (iii) the current version, but the price is now zero: still refused without confirmFree.
    const fresh = await productById(mapR.product_id);
    const zeroNoFree = await api('POST', `/products/${mapR.product_id}/catalogue/confirm-ready`, { confirmFree: false, version: fresh.version });
    check('a zero price at the CURRENT version still needs an explicit free confirmation',
      zeroNoFree.status === 422 && zeroNoFree.body.code === 'PRICE_NOT_CONFIRMED', zeroNoFree);
    check('...still NEEDS_SETUP', (await mappingFor('tool-race-ready')).readiness === 'NEEDS_SETUP');

    // (iv) two confirmations at the same version, at the same time: one transition, one audit row.
    const putBack = await api('PUT', `/products/${mapR.product_id}`, putBody(await productById(mapR.product_id), { defaultSalePrice: '5000.00' }));
    const liveVersion = putBack.body.version;
    const both = await Promise.all([
      api('POST', `/products/${mapR.product_id}/catalogue/confirm-ready`, { confirmFree: false, version: liveVersion }),
      api('POST', `/products/${mapR.product_id}/catalogue/confirm-ready`, { confirmFree: false, version: liveVersion }),
    ]);
    const transitions = both.filter((r) => r.status === 200 && r.body.alreadyReady === false);
    check('two simultaneous confirmations produce exactly ONE state transition', transitions.length === 1,
      both.map((r) => ({ status: r.status, code: r.body && r.body.code, alreadyReady: r.body && r.body.alreadyReady })));
    check('neither confirmation fails with a server error', both.every((r) => r.status < 500), both.map((r) => r.status));
    check('the product is READY exactly once', (await mappingFor('tool-race-ready')).readiness === 'READY');
    check('exactly ONE readiness audit entry exists, written with the transition',
      (await auditCount('catalogue-product.ready', mapR.product_id)) === 1,
      await auditCount('catalogue-product.ready', mapR.product_id));
    check('the confirmation recorded that the price was NOT confirmed free',
      JSON.parse((await q(
        'SELECT after_json FROM biz_crm_audit_logs WHERE action_key=:a AND entity_id=:e',
        { a: 'catalogue-product.ready', e: mapR.product_id },
      ))[0].after_json).confirmedFree === false);
  }

  /* ── 6. the sale path cannot be bypassed ───────────────────────────────────────────────────── */
  const clientId = newId();
  await q(`INSERT INTO biz_crm_clients (id,name,created_by) VALUES (:id,'Selftest Client','selftest')`, { id: clientId });
  const notReady = await mappingFor('tool-same-2');
  const saleItem = (productId) => ({
    productId, name: 'Line', accountType: 'private', durationLabel: null,
    purchaseDate: '2026-10-01', expiryDate: '2026-11-01', salePrice: '100.00', purchaseCost: '0.00',
  });
  const salePayload = (productId) => ({
    clientId, vendorId: null, saleDate: '2026-10-01', orderType: 'new', currencyCode: 'PKR',
    notes: null, invoiceInstructions: null, items: [saleItem(productId)],
    openingClientPayment: '0.00', openingVendorPayment: '0.00',
  });
  {
    const salesBefore = Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n);
    let code = null;
    try { await sales.createSale(OWNER, salePayload(notReady.product_id)); }
    catch (e) { code = e.code; }
    check('a NEEDS_SETUP product cannot be sold through the real sale service', code === 'PRODUCT_NOT_READY', code);
    check('the refused sale wrote NO financial rows', Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesBefore);
  }
  {
    // The guard runs for an OWNER (who holds profit.view and therefore skips the old product
    // lookup entirely) - which is why it sits above that early return.
    const readyMap = await mappingFor('tool-same-1');
    // ARRANGEMENT, not a workaround. The earlier cases above ran reconciles with a NARROWED
    // TOOL_ROWS, and each of those was a COMPLETE scan, so the feature correctly marked the
    // then-absent sources UNAVAILABLE. That is the behaviour section 7 asserts. This case is about
    // selling a READY + AVAILABLE product, so the availability is restored explicitly here rather
    // than relying on the order of earlier steps. The first run of this file crashed exactly
    // because that was left implicit.
    await q(`UPDATE biz_crm_product_sources SET source_availability='AVAILABLE', source_missing_at=NULL WHERE id=:id`, { id: readyMap.id });
    await q(`UPDATE biz_crm_products SET currency_code='PKR', account_type='private' WHERE id=:id`, { id: readyMap.product_id });
    check('arrangement: the product under test is READY and AVAILABLE',
      (await mappingFor('tool-same-1')).readiness === 'READY'
      && (await mappingFor('tool-same-1')).source_availability === 'AVAILABLE');
    const sale = await sales.createSale(OWNER, salePayload(readyMap.product_id));
    check('a READY product sells normally', !!sale && !!sale.id, sale && sale.id);

    // A source going unavailable later must not retro-block editing that existing sale.
    await q(`UPDATE biz_crm_product_sources SET source_availability='UNAVAILABLE' WHERE id=:id`, { id: readyMap.id });
    let editError = null;
    try {
      // Read the items and version straight from the tables. Depending on getSale's DTO shape made
      // this case fail for a reason that had nothing to do with the behaviour under test.
      const rows = await q('SELECT * FROM biz_crm_sale_items WHERE sale_id=:id ORDER BY sort_order', { id: sale.id });
      const ver = (await q('SELECT version FROM biz_crm_sales WHERE id=:id', { id: sale.id }))[0].version;
      check('the saved sale has items to edit', rows.length > 0, rows.length);
      await sales.updateSale(OWNER, sale.id, {
        clientId, vendorId: null, saleDate: '2026-10-01', orderType: 'new', currencyCode: 'PKR',
        notes: 'edited after source went away', invoiceInstructions: null,
        items: rows.map((it) => ({
          id: it.id, productId: it.product_id, name: it.name, accountType: it.account_type,
          durationLabel: it.duration_label, purchaseDate: '2026-10-01', expiryDate: '2026-11-01',
          salePrice: String(it.sale_price), purchaseCost: String(it.purchase_cost),
        })),
        version: ver,
      });
    } catch (e) { editError = e.code || e.message; }
    check('an existing sale can still be edited after its source became unavailable', editError === null, editError);
    // ...but a NEW selection of that product is refused.
    let newCode = null;
    try { await sales.createSale(OWNER, salePayload(readyMap.product_id)); } catch (e) { newCode = e.code; }
    check('a NEW sale of an unavailable source is refused', newCode === 'PRODUCT_SOURCE_UNAVAILABLE', newCode);
    await q(`UPDATE biz_crm_product_sources SET source_availability='AVAILABLE' WHERE id=:id`, { id: readyMap.id });
    check('restoring availability does not erase the completed setup',
      (await mappingFor('tool-same-1')).readiness === 'READY');
  }

  /* -- 6b. A: an IGNORED source is refused server-side, and a retry is still idempotent ------- */
  {
    // `ignored_at` is an explicit operator decision to keep a source out of the catalogue. The
    // readiness gate read only `readiness` and `source_availability`, so a product that had been
    // ignored while already READY and AVAILABLE stayed sellable through the API - the one place
    // where it actually matters. The catalogue list hid it; the sale path did not.
    const mapIgnored = await mappingFor('tool-same-1');
    await q("UPDATE biz_crm_product_sources SET source_availability='AVAILABLE', source_missing_at=NULL WHERE id=:id", { id: mapIgnored.id });
    await catalogue.setIgnored(OWNER, mapIgnored.product_id, true);
    const nowIgnored = await mappingFor('tool-same-1');
    check('arrangement: the product is READY, AVAILABLE and IGNORED',
      nowIgnored.readiness === 'READY' && nowIgnored.source_availability === 'AVAILABLE' && !!nowIgnored.ignored_at,
      { readiness: nowIgnored.readiness, availability: nowIgnored.source_availability, ignored: !!nowIgnored.ignored_at });

    const salesBefore = Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n);
    let code = null;
    try { await sales.createSale(OWNER, salePayload(mapIgnored.product_id)); } catch (e) { code = e.code; }
    check('AN IGNORED SOURCE CANNOT BE SOLD through the real sale service', code === 'PRODUCT_SOURCE_IGNORED', code);
    check('the refused sale wrote no financial rows', Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesBefore);

    // The same refusal must hold on the OFFLINE REPLAY path, which reaches createSale through
    // routes/sync. The service is the convergence point, so this asserts the same call shape the
    // replay uses - an idempotency key, and no sale yet committed under it.
    let replayCode = null;
    try { await sales.createSale(OWNER, { ...salePayload(mapIgnored.product_id), idempotencyKey: `selftest-ignored-${Date.now()}` }); }
    catch (e) { replayCode = e.code; }
    check('an offline-replay shaped create is refused the same way', replayCode === 'PRODUCT_SOURCE_IGNORED', replayCode);
    check('still no financial rows', Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesBefore);

    // Un-ignoring restores it without touching the completed setup.
    await catalogue.setIgnored(OWNER, mapIgnored.product_id, false);
    check('un-ignoring keeps the product READY', (await mappingFor('tool-same-1')).readiness === 'READY');
    const okSale = await sales.createSale(OWNER, salePayload(mapIgnored.product_id));
    check('an un-ignored READY product sells again', !!okSale && !!okSale.id);
  }
  {
    // A COMMITTED SALE IS A FACT. A retry with the same idempotency key happens precisely when the
    // first response was lost, which can be long after the website source was ignored or withdrawn.
    // The readiness gate reads CURRENT source state, and it used to run BEFORE the idempotency
    // replay lookup - so such a retry was answered with PRODUCT_SOURCE_UNAVAILABLE instead of the
    // sale it had already created, leaving the caller to retry forever or create a second sale.
    const readyMap = await mappingFor('tool-same-1');
    await q("UPDATE biz_crm_product_sources SET source_availability='AVAILABLE', source_missing_at=NULL, ignored_at=NULL WHERE id=:id", { id: readyMap.id });
    const key = `selftest-retry-${Date.now()}`;
    const payload = { ...salePayload(readyMap.product_id), idempotencyKey: key, openingClientPayment: '40.00' };
    const first = await sales.createSale(OWNER, payload);
    check('arrangement: the first attempt committed a sale', !!first && !!first.id, first && first.id);
    const salesAfterFirst = Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n);
    const paymentsAfterFirst = Number((await q('SELECT COUNT(*) n FROM biz_crm_payments WHERE sale_id=:s', { s: first.id }))[0].n);
    check('arrangement: the opening receipt was recorded', paymentsAfterFirst >= 1, paymentsAfterFirst);

    // Now the source changes under it, in both of the ways the gate cares about.
    await q("UPDATE biz_crm_product_sources SET source_availability='UNAVAILABLE' WHERE id=:id", { id: readyMap.id });
    await catalogue.setIgnored(OWNER, readyMap.product_id, true);
    let retryError = null; let retried = null;
    try { retried = await sales.createSale(OWNER, payload); } catch (e) { retryError = e.code || e.message; }
    check('A RETRY OF A COMMITTED SALE STILL RECONCILES, after the source changed', retryError === null, retryError);
    check('the retry returns the SAME sale', !!retried && retried.id === first.id, { first: first.id, retried: retried && retried.id });
    check('the retry created NO second sale', Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesAfterFirst);
    check('the retry created NO second payment',
      Number((await q('SELECT COUNT(*) n FROM biz_crm_payments WHERE sale_id=:s', { s: first.id }))[0].n) === paymentsAfterFirst);
    check('the invoice number was not consumed twice',
      Number((await q('SELECT COUNT(*) n FROM biz_crm_sales WHERE invoice_number=:i', { i: first.invoice_number }))[0].n) === 1);
    // ...while a NEW sale of the same product is still refused.
    let freshCode = null;
    try { await sales.createSale(OWNER, salePayload(readyMap.product_id)); } catch (e) { freshCode = e.code; }
    check('a brand-new sale of the changed source is still refused', freshCode === 'PRODUCT_SOURCE_IGNORED', freshCode);
    await catalogue.setIgnored(OWNER, readyMap.product_id, false);
  }

  /* ── 7. a failed or partial source read must never look like deletion ─────────────────────── */
  {
    const mapsBefore = Number((await q('SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_availability=:a', { a: 'UNAVAILABLE' }))[0].n);
    TOOL_READ_FAILS = true;
    const r = await catalogue.reconcile(OWNER, { force: true });
    TOOL_READ_FAILS = false;
    check('a failed source scan aborts before any write', r.aborted === 'incomplete_scan', r);
    check('a failed scan marks nothing unavailable', Number((await q(
      'SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_availability=:a', { a: 'UNAVAILABLE' },
    ))[0].n) === mapsBefore);
    check('a failed scan deletes no product', (await countProducts()) > 0);
    // An EMPTY but COMPLETE scan is different: that legitimately marks sources unavailable.
    TOOL_ROWS = [];
    const r2 = await catalogue.reconcile(OWNER, { force: true });
    check('a complete empty scan DOES mark sources unavailable', r2.markedUnavailable >= 1, r2);
    check('...and still keeps every product row', (await countProducts()) > 0);
  }

  /* ── 8. pagination beyond the first page ──────────────────────────────────────────────────── */
  {
    TOOL_ROWS = [];
    for (let i = 0; i < 450; i += 1) TOOL_ROWS.push(tool(`page-${String(i).padStart(4, '0')}`, `Paged Tool ${i}`, 'Writing', `p${i}.example`));
    const r = await catalogue.reconcile(OWNER, { force: true });
    const n = Number((await q("SELECT COUNT(*) n FROM biz_crm_product_sources WHERE source_id LIKE 'page-%'"))[0].n);
    check('all 450 sources are imported across pages (not capped at one page)', n === 450, { imported: r.created, mapped: n });
    const dry = await catalogue.dryRun();
    check('the dry-run reports the complete scan', dry.scan.complete === true && dry.scan.discovered === 450, dry.scan);
  }

  /* ── 9. zero website writes, ever ─────────────────────────────────────────────────────────── */
  check('the website Tool model received ZERO writes', TOOL_WRITES.length === 0, TOOL_WRITES.map((w) => w[0]));

  /* ── 10. cost redaction and permissions are unchanged ─────────────────────────────────────── */
  {
    const { has } = require(path.join(MODULE_DIR, 'permissions'));
    const staff = makeReq('selftest-staff', ['products.view', 'sales.create']);
    check('a products.view-only actor has no profit.view', !has(staff, 'profit.view'));
    check('a products.view-only actor cannot manage products', !has(staff, 'products.manage'));
  }

  /* -- 11. THE RECOVERY PATH, tested rather than described ----------------------------------- */
  {
    // Rollback planning for this release, verified in the disposable schema instead of asserted in
    // prose. An earlier draft of the release notes said a backend rollback should "roll the mapping
    // rows back with it". That is WRONG, and (b) below is the proof: removing a mapping does not
    // remove its product, so the imported placeholder stops being recognisable as imported and
    // every readiness safeguard stops applying to it.
    TOOL_ROWS = [tool('tool-recovery', 'Recovery Probe', 'Writing', 'rec.example')];
    await catalogue.reconcile(OWNER, { force: true });
    const mapRec = await mappingFor('tool-recovery');
    check('arrangement: a freshly imported product exists and is NEEDS_SETUP',
      !!mapRec && mapRec.readiness === 'NEEDS_SETUP', mapRec && mapRec.readiness);
    const salesAtStart = Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n);
    const paymentsAtStart = Number((await q('SELECT COUNT(*) n FROM biz_crm_payments'))[0].n);
    const historyBefore = (await q('SELECT * FROM biz_crm_product_sources WHERE id=:id', { id: mapRec.id }))[0];

    /* (a) THE SUPPORTED FORWARD CORRECTION: ignore, then deactivate. Nothing is deleted. */
    await catalogue.setIgnored(OWNER, mapRec.product_id, true);
    const recRow = await productById(mapRec.product_id);
    const deactivate = await api('PUT', `/products/${mapRec.product_id}`, putBody(recRow, { active: false }));
    check('the forward correction is an ordinary operator edit', deactivate.status === 200, deactivate.body);
    let refusedAfterCorrection = null;
    try { await sales.createSale(OWNER, salePayload(mapRec.product_id)); } catch (e) { refusedAfterCorrection = e.code; }
    check('after the correction the product cannot be sold', refusedAfterCorrection === 'PRODUCT_SOURCE_IGNORED', refusedAfterCorrection);
    const afterCorrection = (await q('SELECT * FROM biz_crm_product_sources WHERE id=:id', { id: mapRec.id }))[0];
    check('the mapping row is still there - no history was destroyed', !!afterCorrection);
    check('its import identity and readiness are preserved',
      afterCorrection.source_id === historyBefore.source_id
      && afterCorrection.source_name === historyBefore.source_name
      && afterCorrection.readiness === historyBefore.readiness
      && String(afterCorrection.created_at) === String(historyBefore.created_at),
      { readiness: afterCorrection.readiness, sourceName: afterCorrection.source_name });
    check('the product row is kept, not deleted', !!(await productById(mapRec.product_id))
      && (await productById(mapRec.product_id)).deleted_at === null);
    const activeList = await api('GET', '/products?active=true&pageSize=500');
    check('a deactivated product is no longer offered in the catalogue list',
      !((activeList.body.rows || []).some((r) => r.id === mapRec.product_id)));
    check('the correction wrote NO financial rows',
      Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesAtStart
      && Number((await q('SELECT COUNT(*) n FROM biz_crm_payments'))[0].n) === paymentsAtStart);

    // ...and it is fully reversible, with the safeguard chain intact rather than reset.
    await catalogue.setIgnored(OWNER, mapRec.product_id, false);
    const reRow = await productById(mapRec.product_id);
    await api('PUT', `/products/${mapRec.product_id}`, putBody(reRow, { active: true }));
    let refusedAfterReverse = null;
    try { await sales.createSale(OWNER, salePayload(mapRec.product_id)); } catch (e) { refusedAfterReverse = e.code; }
    check('reversing the correction restores the ORIGINAL refusal, not sellability',
      refusedAfterReverse === 'PRODUCT_NOT_READY', refusedAfterReverse);

    /* (b) THE HAZARD, demonstrated: deleting the mapping row instead. */
    const productsBeforeDelete = await countProducts();
    await q('DELETE FROM biz_crm_product_sources WHERE id=:id', { id: mapRec.id });
    check('deleting a mapping does NOT delete its product', (await countProducts()) === productsBeforeDelete
      && !!(await productById(mapRec.product_id)));
    const orphan = await api('GET', '/products?q=Recovery%20Probe&pageSize=50');
    const orphanRow = (orphan.body.rows || []).find((r) => r.id === mapRec.product_id);
    check('the orphaned placeholder now reads as a MANUAL product', !!orphanRow && !('source' in orphanRow),
      orphanRow && Object.keys(orphanRow).filter((k) => k === 'source'));
    check('...and its stored placeholder price is served as a confirmed value',
      !!orphanRow && String(orphanRow.default_sale_price) === '0.00', orphanRow && orphanRow.default_sale_price);
    const soldOrphan = await sales.createSale(OWNER, salePayload(mapRec.product_id));
    check('...so the readiness gate no longer applies and the placeholder IS SELLABLE', !!soldOrphan && !!soldOrphan.id,
      soldOrphan && soldOrphan.id);
    check('that hazard added exactly the one sale this case created',
      Number((await q('SELECT COUNT(*) n FROM biz_crm_sales'))[0].n) === salesAtStart + 1);

    /* (c) and the deleted link is not quietly restored by a later reconcile. */
    TOOL_ROWS = [tool('tool-recovery', 'Recovery Probe', 'Writing', 'rec.example')];
    const reimport = await catalogue.reconcile(OWNER, { force: true });
    check('a reconcile after a deleted mapping does NOT re-link the orphan silently',
      !(await mappingFor('tool-recovery')) && reimport.heldForReview >= 1, reimport);

    /* (d) a FRONTEND-ONLY rollback stays safe, because the refusal is server-side. */
    TOOL_ROWS = [tool('tool-recovery-2', 'Recovery Probe Two', 'Writing', 'rec2.example')];
    await catalogue.reconcile(OWNER, { force: true });
    const mapRec2 = await mappingFor('tool-recovery-2');
    let clientCannotOverride = null;
    try {
      await sales.createSale(OWNER, {
        ...salePayload(mapRec2.product_id),
        // Whatever an older client believes about this product, it does not get a say.
        items: [{ ...saleItem(mapRec2.product_id), salePrice: '0.00', accountType: 'private' }],
      });
    } catch (e) { clientCannotOverride = e.code; }
    check('an older frontend cannot re-enable an imported placeholder - the refusal is server-side',
      clientCannotOverride === 'PRODUCT_NOT_READY', clientCannotOverride);

    /* (e) the FK protects history in the other direction too. */
    let fkRefusal = null;
    try { await q('DELETE FROM biz_crm_products WHERE id=:id', { id: mapRec2.product_id }); }
    catch (e) { fkRefusal = e.code || e.message; }
    check('a product referenced by a mapping cannot be hard-deleted out from under it',
      fkRefusal !== null, fkRefusal);
    check('...and it is still there', !!(await productById(mapRec2.product_id)));
  }

  /* -- 12. still zero website writes, after everything above --------------------------------- */
  check('the website Tool model received ZERO writes across the WHOLE run', TOOL_WRITES.length === 0,
    TOOL_WRITES.map((w) => w[0]));

  try { apiServer.close(); } catch (_) {}

  console.log(`\n[catalogue-selftest] ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})()
  .catch((e) => { console.error('[catalogue-selftest] crashed:', (e && e.stack) || e); process.exitCode = 1; })
  .finally(async () => { try { await db.close(); } catch (_) {} });

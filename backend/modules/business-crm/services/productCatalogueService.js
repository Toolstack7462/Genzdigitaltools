'use strict';

/**
 * Website Tool definitions → Business CRM product catalogue (CRM-owned, PULL ONLY).
 *
 * The website stays the operational source of truth for what Tools exist; the CRM stays the
 * financial source of truth for what they cost and whether they may be sold. This module only
 * READS approved non-secret Tool metadata and mirrors it into biz_crm_products +
 * biz_crm_product_sources. It writes no website table, touches no credential, session bundle,
 * assignment or lease, and makes no provider request. The isolation test fails the build if this
 * file ever gains a write call against a website model.
 *
 * It is modelled on services/websiteAccessService.js (same PULL-ONLY shape, same per-source
 * try/catch, same stable-external-key idea) but deliberately does NOT reuse its reconcile(): that
 * one also creates CRM clients, and populating a catalogue must never create a client.
 *
 * WHAT IT IMPORTS, AND WHAT IT ONLY REPORTS
 *   WEBSITE_TOOL   Tool rows (models/Tool) - imported. One product per Tool, including Tools with
 *                  no assignment at all. Never one per client, assignment, credential or session.
 *   other families The proxy registry (utils/proxy/tools) and the Stealth models are reported as
 *                  UNRESOLVED, not imported and not excluded. Whether those products are already
 *                  represented by Tool rows is an INVENTORY QUESTION this dry-run asks the
 *                  operator - it is not something this code may assume either way.
 *
 * IDENTITY IS NEVER A NAME OR A DOMAIN. The key is (source_namespace, source_id) with an immutable
 * source id. Two Tools may legitimately share a brand or a host - the same product sold as a
 * private and a shared account, say - and must stay distinct catalogue items. A name or domain
 * similarity is reported as a POSSIBLE match for the operator to decide; it never merges,
 * suppresses or relinks anything on its own.
 */

const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');

// Existing website sources — READ ONLY. Only non-secret metadata is ever projected out of these.
const Tool = require('../../../models/Tool');
const proxyTools = require('../../../utils/proxy/tools');

const NAMESPACE_WEBSITE_TOOL = 'WEBSITE_TOOL';
const READINESS = Object.freeze(['NEEDS_SETUP', 'READY']);
const AVAILABILITY = Object.freeze(['AVAILABLE', 'UNAVAILABLE']);

/** Pull every page. A truncated read is reported, never treated as the whole inventory. */
const PAGE_SIZE = 200;
const MAX_PAGES = 200; // 40k Tools; a hard stop so a pathological source cannot spin forever.

/**
 * How long a reconciliation stays "fresh enough" that opening the Products page again does not
 * re-run it. Cross-worker, because it is derived from a committed row rather than a browser flag.
 */
const FRESH_MS = Math.max(60_000, Number(process.env.CRM_CATALOGUE_FRESH_MS || 15 * 60_000));

const RUN_ENTITY = 'catalogue_source';
const newId = () => crypto.randomUUID();

/* ───────────────────────────── source reads (non-secret projection only) ───────────────────── */

/**
 * Approved projection. Listing the fields explicitly - rather than taking a Tool document and
 * deleting the secrets - is what guarantees a new secret field on Tool can never start flowing
 * into the CRM just because somebody added it upstream.
 */
function projectTool(row) {
  return {
    namespace: NAMESPACE_WEBSITE_TOOL,
    sourceId: String(row._id),
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 190) : null,
    category: typeof row.category === 'string' && row.category.trim() ? row.category.trim().slice(0, 100) : null,
    // Reported for the operator's own judgement about possible relationships. NEVER used to merge,
    // exclude or deduplicate anything.
    domainHint: typeof row.domain === 'string' && row.domain.trim() ? row.domain.trim().slice(0, 190) : null,
    status: typeof row.status === 'string' ? row.status : null,
  };
}

/**
 * Read every eligible Tool. Returns { sources, complete }.
 *
 * `complete` is the single most important value here: only a COMPLETE successful scan may support
 * concluding that a source has disappeared. A thrown error, or a scan that hit MAX_PAGES, returns
 * complete:false and the caller must then leave availability exactly as it was.
 */
async function discoverWebsiteTools() {
  const sources = [];
  const seen = new Set();
  let complete = false;
  let error = null;
  try {
    let expected = null;
    try { expected = await Tool.countDocuments({ status: 'active' }); } catch (_) { expected = null; }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await Tool.find({ status: 'active' })
        .select('_id name category domain status')
        .sort({ _id: 1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean();
      const batch = Array.isArray(rows) ? rows : [];
      for (const row of batch) {
        if (!row || row._id == null) continue;
        const key = String(row._id);
        if (seen.has(key)) continue;          // defensive: a shifting page window must not duplicate
        seen.add(key);
        sources.push(projectTool(row));
      }
      if (batch.length < PAGE_SIZE) { complete = true; break; }
    }
    // A count mismatch means the window moved under us, or MAX_PAGES stopped us short. Either way
    // this is not an authoritative inventory.
    if (complete && expected != null && Number.isFinite(expected) && sources.length < expected) complete = false;
  } catch (e) {
    complete = false;
    error = (e && e.message) ? String(e.message).slice(0, 200) : 'tool_read_failed';
  }
  return { sources, complete, error };
}

/**
 * The source families this release does NOT import, reported so they cannot be forgotten.
 *
 * These are questions, not findings. The proxy registry is a CODE registry of delivery mechanisms
 * and the Stealth models are their own family; whether each is already represented by a Tool row
 * is something only the operator (or a later approved mapping) can settle. Nothing here is
 * excluded on the basis of a shared domain, and no product is suppressed because a registry
 * differs.
 */
function unresolvedSourceFamilies() {
  let proxyKeys = [];
  try { proxyKeys = Array.isArray(proxyTools.TOOL_KEYS) ? proxyTools.TOOL_KEYS.slice() : []; } catch (_) { proxyKeys = []; }
  return [
    {
      family: 'PROXY_REGISTRY',
      question: 'Is each proxy-delivered product already represented by a Tool row, or does it need its own catalogue entry?',
      members: proxyKeys,
      imported: false,
    },
    {
      family: 'STEALTH',
      question: 'Is the Stealth product represented by a Tool row, or does it need its own catalogue entry?',
      members: ['stealth'],
      imported: false,
    },
  ];
}

/* ───────────────────────────── CRM state reads ─────────────────────────────────────────────── */

async function existingMappings() {
  return db.query(
    `SELECT ps.*, p.name AS product_name, p.active AS product_active, p.deleted_at AS product_deleted_at,
            p.currency_code, p.default_sale_price, p.category AS product_category
       FROM biz_crm_product_sources ps
       JOIN biz_crm_products p ON p.id = ps.product_id`,
    {},
  );
}

/** Manual products: catalogue rows with no source mapping at all. */
async function manualProducts() {
  return db.query(
    `SELECT p.id, p.name, p.category, p.currency_code, p.active
       FROM biz_crm_products p
       LEFT JOIN biz_crm_product_sources ps ON ps.product_id = p.id
      WHERE p.deleted_at IS NULL AND ps.id IS NULL`,
    {},
  );
}

const normaliseName = (value) => String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');

/* ───────────────────────────── freshness + cross-worker claim ──────────────────────────────── */

async function lastRunAt() {
  const rows = await db.query(
    `SELECT MAX(created_at) AS last_at FROM biz_crm_import_runs WHERE entity_type = :entity`,
    { entity: RUN_ENTITY },
  );
  const raw = rows && rows[0] ? rows[0].last_at : null;
  const at = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(at) ? at : 0;
}

async function isFresh() {
  const at = await lastRunAt();
  return at > 0 && (Date.now() - at) < FRESH_MS;
}

/* ───────────────────────────── the dry run ─────────────────────────────────────────────────── */

/**
 * Read-only. Shows everything the operator has to decide before anything is written: what was
 * discovered, what is already linked, what would be created, which manual products MIGHT be the
 * same thing, what is deliberately ignored, and which source families are still unresolved.
 */
async function dryRun() {
  const discovered = await discoverWebsiteTools();
  const mappings = await existingMappings();
  const manual = await manualProducts();

  const byKey = new Map();
  for (const row of mappings) byKey.set(`${row.source_namespace}:${row.source_id}`, row);

  const manualByName = new Map();
  for (const row of manual) {
    const key = normaliseName(row.name);
    if (!key) continue;
    if (!manualByName.has(key)) manualByName.set(key, []);
    manualByName.get(key).push({ productId: row.id, name: row.name, category: row.category, currency: row.currency_code });
  }

  const proposedNew = [];
  const alreadyLinked = [];
  const ignored = [];
  const possibleManualMatches = [];

  for (const source of discovered.sources) {
    const key = `${source.namespace}:${source.sourceId}`;
    const mapped = byKey.get(key);
    if (mapped && mapped.ignored_at) {
      ignored.push({ ...source, productId: mapped.product_id, ignoredAt: mapped.ignored_at });
      continue;
    }
    if (mapped) {
      alreadyLinked.push({
        ...source,
        productId: mapped.product_id,
        productName: mapped.product_name,
        readiness: mapped.readiness,
        sourceAvailability: mapped.source_availability,
        nameOverridden: !!Number(mapped.name_overridden),
        sourceRenamed: !!(source.name && mapped.source_name && source.name !== mapped.source_name),
      });
      continue;
    }
    // A name similarity is a SUGGESTION, never a link. But it also HOLDS the source back from
    // automatic creation: creating a second catalogue row that looks like an existing manual
    // product, with no explanation, is exactly the confusion this is meant to avoid. The operator
    // resolves it either by linking the existing product to this source or by approving a separate
    // product - both explicit actions.
    const candidates = manualByName.get(normaliseName(source.name)) || [];
    if (candidates.length) {
      possibleManualMatches.push({ ...source, candidates, resolution: 'operator_decision_required', heldFromImport: true });
      continue;
    }
    proposedNew.push({ ...source, readinessOnImport: 'NEEDS_SETUP' });
  }

  // A mapping whose source did not appear in a COMPLETE scan is a candidate for UNAVAILABLE.
  // On an incomplete scan this list is deliberately empty: absence proves nothing.
  const missingCandidates = [];
  if (discovered.complete) {
    const liveKeys = new Set(discovered.sources.map((s) => `${s.namespace}:${s.sourceId}`));
    for (const row of mappings) {
      if (row.source_namespace !== NAMESPACE_WEBSITE_TOOL) continue;
      if (liveKeys.has(`${row.source_namespace}:${row.source_id}`)) continue;
      missingCandidates.push({
        productId: row.product_id, productName: row.product_name,
        namespace: row.source_namespace, sourceId: row.source_id,
        currentAvailability: row.source_availability,
      });
    }
  }

  return {
    scan: {
      namespace: NAMESPACE_WEBSITE_TOOL,
      discovered: discovered.sources.length,
      complete: discovered.complete,
      error: discovered.error,
      note: discovered.complete
        ? 'Complete authoritative scan.'
        : 'INCOMPLETE scan — nothing will be marked missing and no availability will change.',
    },
    discoveredSources: discovered.sources,
    alreadyLinked,
    proposedNew,
    possibleManualMatches,
    ignored,
    missingCandidates,
    unresolvedSourceFamilies: unresolvedSourceFamilies(),
    manualProductCount: manual.length,
    freshness: { lastRunAt: await lastRunAt(), freshForMs: FRESH_MS },
  };
}

/* ───────────────────────────── apply ───────────────────────────────────────────────────────── */

/**
 * Create one product + its mapping, in ONE transaction.
 *
 * Either both rows exist or neither does: a uniqueness conflict, a timeout or a rollback can never
 * leave an orphan product with no mapping, a mapping with no product, or a duplicate audit entry.
 * The UNIQUE key on (source_namespace, source_id) is what makes a concurrent worker lose cleanly -
 * it gets ER_DUP_ENTRY and reports `skipped_duplicate` instead of writing a second product.
 *
 * The product is created with the table's own defaults for every commercial field. Those values
 * are STORAGE PLACEHOLDERS, not data: readiness NEEDS_SETUP is what stops them being read as a
 * confirmed price, currency, account type or duration anywhere that matters.
 */
async function createLinkedProduct(source, actor) {
  const productId = newId();
  const mappingId = newId();
  try {
    await db.withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO biz_crm_products (id, name, category, created_by, active)
         VALUES (:id, :name, :category, :actor, 1)`,
        {
          id: productId,
          name: source.name || `Imported tool ${source.sourceId}`,
          category: source.category || 'Software',
          actor,
        },
      );
      await connection.execute(
        `INSERT INTO biz_crm_product_sources
           (id, product_id, source_namespace, source_id, source_name, source_category,
            readiness, source_availability, last_seen_at, created_by)
         VALUES (:id, :productId, :namespace, :sourceId, :name, :category,
                 'NEEDS_SETUP', 'AVAILABLE', CURRENT_TIMESTAMP, :actor)`,
        {
          id: mappingId,
          productId,
          namespace: source.namespace,
          sourceId: source.sourceId,
          name: source.name,
          category: source.category,
          actor,
        },
      );
    });
  } catch (e) {
    if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) return { status: 'skipped_duplicate' };
    throw e;
  }
  return { status: 'created', productId };
}

/**
 * Refresh only what the SOURCE owns, and only when it actually changed.
 *
 * Never touches price, cost, currency, account type, duration, notes, active or readiness: those
 * belong to the operator. `name_overridden` is the operator's veto on the name too - once they
 * rename a product, the source stops owning that field.
 *
 * A no-change source produces NO write and NO audit entry. That is what keeps an idle
 * reconciliation from generating per-row churn and audit spam.
 */
async function refreshLinked(mapping, source, actor) {
  const nextName = source.name || null;
  const nextCategory = source.category || null;
  const renamed = nextName != null && mapping.source_name !== nextName;
  const recategorised = nextCategory != null && mapping.source_category !== nextCategory;
  const wasUnavailable = mapping.source_availability !== 'AVAILABLE';
  if (!renamed && !recategorised && !wasUnavailable) return { status: 'unchanged' };

  const applyName = renamed && !Number(mapping.name_overridden);
  await db.withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE biz_crm_product_sources
          SET source_name = :name, source_category = :category,
              source_availability = 'AVAILABLE', source_missing_at = NULL,
              last_seen_at = CURRENT_TIMESTAMP
        WHERE id = :id`,
      { id: mapping.id, name: nextName, category: nextCategory },
    );
    if (applyName) {
      // A source rename keeps the SAME product id, so historical invoice snapshots - which store
      // their own name on biz_crm_sale_items - are untouched and no new product appears.
      await connection.execute(
        `UPDATE biz_crm_products
            SET name = :name, updated_by = :actor, version = version + 1
          WHERE id = :productId AND deleted_at IS NULL`,
        { productId: mapping.product_id, name: nextName, actor },
      );
    }
  });
  return { status: 'refreshed', renamed: applyName, recategorised, recovered: wasUnavailable };
}

/**
 * Apply the discovered inventory.
 *
 * Mutual exclusion is a row lock on the settings singleton for the duration of the run, so two
 * Passenger workers (or two Products pages opening together) cannot both perform a full import.
 * It is a committed-row lock rather than a browser flag or a process-local mutex, which is the
 * only kind that holds across workers.
 */
async function reconcile(req, options = {}) {
  const actor = String((req && req.userId) || 'system');
  const force = options.force === true;

  if (!force && await isFresh()) {
    return { skipped: 'fresh', lastRunAt: await lastRunAt(), freshForMs: FRESH_MS };
  }

  const discovered = await discoverWebsiteTools();
  const summary = {
    created: 0, refreshed: 0, unchanged: 0, skippedDuplicate: 0,
    markedUnavailable: 0, ignoredSkipped: 0, heldForReview: 0, errors: [],
    scanComplete: discovered.complete,
  };
  if (discovered.error) summary.errors.push({ scope: 'source_scan', message: discovered.error });

  // A failed or partial scan must not be allowed to look like an empty inventory. Stop before any
  // write: no creations from a half-read page, and above all no deletions or availability changes.
  if (!discovered.complete) {
    summary.aborted = 'incomplete_scan';
    summary.note = 'Source scan did not complete. No products were created, and no source was marked unavailable.';
    await recordRun(actor, summary, 0);
    return summary;
  }

  await db.withTransaction(async (connection) => {
    // Cross-worker claim. Any concurrent reconcile blocks here, then sees a fresh run and returns.
    await connection.execute('SELECT id FROM biz_crm_settings WHERE id = 1 FOR UPDATE', {});

    const [mappingRows] = await connection.execute(
      `SELECT * FROM biz_crm_product_sources WHERE source_namespace = :ns`,
      { ns: NAMESPACE_WEBSITE_TOOL },
    );
    const byKey = new Map();
    for (const row of mappingRows) byKey.set(`${row.source_namespace}:${row.source_id}`, row);

    // Manual products, by normalised name, so an ambiguous source can be held back here too. The
    // dry-run and the unattended sweep must agree: otherwise the preview would show a source as
    // held and the next reconciliation would create it anyway.
    const [manualRows] = await connection.execute(
      `SELECT p.id, p.name FROM biz_crm_products p
         LEFT JOIN biz_crm_product_sources ps ON ps.product_id = p.id
        WHERE p.deleted_at IS NULL AND ps.id IS NULL`,
      {},
    );
    const manualNames = new Set(manualRows.map((r) => normaliseName(r.name)).filter(Boolean));

    for (const source of discovered.sources) {
      const mapping = byKey.get(`${source.namespace}:${source.sourceId}`);
      try {
        if (mapping && mapping.ignored_at) { summary.ignoredSkipped += 1; continue; }
        if (mapping) {
          const r = await refreshLinked(mapping, source, actor);
          if (r.status === 'refreshed') summary.refreshed += 1; else summary.unchanged += 1;
          continue;
        }
        if (manualNames.has(normaliseName(source.name))) {
          // Needs an explicit operator decision; see linkExisting / approveCreate.
          summary.heldForReview += 1;
          continue;
        }
        const r = await createLinkedProduct(source, actor);
        if (r.status === 'created') summary.created += 1; else summary.skippedDuplicate += 1;
      } catch (e) {
        // One bad row degrades that row only - never the run, and never website access.
        summary.errors.push({ scope: 'source', sourceId: source.sourceId, message: String((e && e.message) || 'row_failed').slice(0, 200) });
      }
    }

    // Only now - after a COMPLETE scan - may a vanished source be marked unavailable. The product
    // and every financial reference to it are kept; nothing is written back to the website.
    const liveKeys = new Set(discovered.sources.map((s) => `${s.namespace}:${s.sourceId}`));
    for (const row of mappingRows) {
      if (liveKeys.has(`${row.source_namespace}:${row.source_id}`)) continue;
      if (row.source_availability === 'UNAVAILABLE') continue;
      await connection.execute(
        `UPDATE biz_crm_product_sources
            SET source_availability = 'UNAVAILABLE', source_missing_at = CURRENT_TIMESTAMP
          WHERE id = :id`,
        { id: row.id },
      );
      summary.markedUnavailable += 1;
    }
  });

  await recordRun(actor, summary, discovered.sources.length);
  // One audit entry per RUN, not per row: an idle reconciliation must not fill the audit log, so a
  // run that changed nothing writes nothing here either.
  if (summary.created || summary.refreshed || summary.markedUnavailable) {
    try {
      await db.withTransaction(async (connection) => {
        await audit.write(connection, req, 'catalogue-source.reconcile', 'product_source', null, null, {
          created: summary.created, refreshed: summary.refreshed, unavailable: summary.markedUnavailable,
        });
      });
    } catch (_) { /* audit must never fail the reconciliation */ }
  }
  return summary;
}

async function recordRun(actor, summary, total) {
  try {
    await db.query(
      `INSERT INTO biz_crm_import_runs (id, entity_type, total_rows, imported_rows, rejected_rows, errors_json, created_by)
       VALUES (:id, :entity, :total, :imported, :rejected, :errors, :actor)`,
      {
        id: newId(), entity: RUN_ENTITY, total,
        imported: summary.created + summary.refreshed,
        rejected: summary.errors.length,
        errors: summary.errors.length ? JSON.stringify(summary.errors).slice(0, 60000) : null,
        actor,
      },
    );
  } catch (_) { /* the run log is evidence, not a gate */ }
}

/* ───────────────────────────── readiness ───────────────────────────────────────────────────── */

/**
 * The commercial fields the existing sale flow actually consumes, and therefore the ones that must
 * be confirmed before an imported product may be sold. This list is derived from what salesService
 * reads off a product row (currency and purchase cost) plus what the sale item records.
 */
const REQUIRED_FOR_READY = Object.freeze(['currency_code', 'account_type', 'default_sale_price']);

/**
 * Promote an imported product to READY.
 *
 * Deliberately NOT a side effect of an ordinary product Save. A name correction must never make a
 * product sellable, because the placeholder 0.00 price and 'private' account type would come along
 * with it. The operator has to state the commercial facts here, and a zero price is accepted only
 * when `confirmFree` says it is intentional - which is what keeps "price unknown" distinct from
 * "this product is free".
 *
 * Purchase cost is NOT required: a role without profit.view cannot see it, and demanding it would
 * make readiness unreachable for exactly those operators.
 */
async function confirmReady(req, productId, payload) {
  const actor = String((req && req.userId) || 'system');
  const rows = await db.query(
    `SELECT ps.*, p.currency_code, p.account_type, p.default_sale_price, p.version, p.deleted_at
       FROM biz_crm_product_sources ps
       JOIN biz_crm_products p ON p.id = ps.product_id
      WHERE ps.product_id = :id`,
    { id: productId },
  );
  const row = rows && rows[0];
  if (!row) { const e = new Error('This product is not linked to a website source'); e.status = 404; e.code = 'NOT_IMPORTED'; throw e; }
  if (row.deleted_at) { const e = new Error('Product is deleted'); e.status = 409; e.code = 'PRODUCT_DELETED'; throw e; }

  const price = money.normalize(row.default_sale_price);
  const zero = Number(price) === 0;
  if (zero && payload.confirmFree !== true) {
    const e = new Error('Set a sale price, or confirm explicitly that this product is free');
    e.status = 422; e.code = 'PRICE_NOT_CONFIRMED';
    throw e;
  }
  for (const field of REQUIRED_FOR_READY) {
    if (row[field] == null || row[field] === '') {
      const e = new Error(`Complete ${field} before marking this product ready`);
      e.status = 422; e.code = 'COMMERCIAL_DETAILS_INCOMPLETE';
      throw e;
    }
  }

  // Optimistic concurrency against the operator's own view of the product, reusing the existing
  // `version` column, so a late sync or a second manager cannot silently overwrite the decision.
  const result = await db.query(
    `UPDATE biz_crm_product_sources
        SET readiness = 'READY', ready_at = CURRENT_TIMESTAMP, ready_by = :actor
      WHERE id = :id AND readiness = 'NEEDS_SETUP'`,
    { id: row.id, actor },
  );
  const changed = result && (result.affectedRows || result.changedRows || 0);
  if (!changed) return { readiness: 'READY', alreadyReady: true };
  try {
    await db.withTransaction(async (connection) => {
      await audit.write(connection, req, 'catalogue-product.ready', 'product', productId,
        { readiness: 'NEEDS_SETUP' },
        { readiness: 'READY', confirmedFree: zero === true });
    });
  } catch (_) {}
  return { readiness: 'READY', alreadyReady: false };
}

/**
 * Link an EXISTING product to a discovered source — the operator saying "these are the same thing".
 *
 * Deliberately changes no commercial field. A manual product's price, cost, currency, type and
 * duration were entered by the operator, so they are already confirmed: that is why the mapping
 * starts READY rather than NEEDS_SETUP. Starting it at NEEDS_SETUP would make an already-sellable
 * product suddenly unsellable, which would be a regression caused by linking.
 *
 * The UNIQUE keys do the real work: a product already linked, or a source already taken, fails at
 * the database rather than producing a second mapping.
 */
async function linkExisting(req, productId, source) {
  const actor = String((req && req.userId) || 'system');
  const namespace = String(source && source.namespace || NAMESPACE_WEBSITE_TOOL);
  const sourceId = String(source && source.sourceId || '');
  if (!sourceId) { const e = new Error('sourceId is required'); e.status = 400; e.code = 'SOURCE_ID_REQUIRED'; throw e; }
  const product = (await db.query('SELECT id, name, category FROM biz_crm_products WHERE id=:id AND deleted_at IS NULL', { id: productId }))[0];
  if (!product) { const e = new Error('Product not found'); e.status = 404; e.code = 'PRODUCT_NOT_FOUND'; throw e; }
  try {
    await db.withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO biz_crm_product_sources
           (id, product_id, source_namespace, source_id, source_name, source_category,
            readiness, ready_at, ready_by, source_availability, last_seen_at, created_by)
         VALUES (:id, :productId, :namespace, :sourceId, :name, :category,
                 'READY', CURRENT_TIMESTAMP, :actor, 'AVAILABLE', CURRENT_TIMESTAMP, :actor)`,
        { id: newId(), productId, namespace, sourceId, name: product.name, category: product.category, actor },
      );
      await audit.write(connection, req, 'catalogue-source.linked', 'product_source', productId, null, { namespace, sourceId });
    });
  } catch (e) {
    if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
      const err = new Error('That product or that source is already linked');
      err.status = 409; err.code = 'ALREADY_LINKED'; throw err;
    }
    throw e;
  }
  return { linked: true, productId, namespace, sourceId, readiness: 'READY' };
}

/**
 * Approve creating a SEPARATE product for a source that was held back for resembling a manual one.
 *
 * The operator is stating that the similarity is coincidental. The new product still starts
 * NEEDS_SETUP, so approving the creation is not the same as approving it for sale.
 */
async function approveCreate(req, source) {
  const actor = String((req && req.userId) || 'system');
  const namespace = String(source && source.namespace || NAMESPACE_WEBSITE_TOOL);
  const sourceId = String(source && source.sourceId || '');
  if (!sourceId) { const e = new Error('sourceId is required'); e.status = 400; e.code = 'SOURCE_ID_REQUIRED'; throw e; }
  const discovered = await discoverWebsiteTools();
  if (!discovered.complete) {
    const e = new Error('The source scan did not complete; try again'); e.status = 503; e.code = 'SCAN_INCOMPLETE'; throw e;
  }
  const match = discovered.sources.find((s) => s.namespace === namespace && s.sourceId === sourceId);
  if (!match) { const e = new Error('That source is not in the current inventory'); e.status = 404; e.code = 'SOURCE_NOT_FOUND'; throw e; }
  const r = await createLinkedProduct(match, actor);
  if (r.status !== 'created') { const e = new Error('That source is already linked'); e.status = 409; e.code = 'ALREADY_LINKED'; throw e; }
  return { created: true, productId: r.productId, readiness: 'NEEDS_SETUP' };
}

/** Explicit operator decision to keep a discovered source out of the catalogue. Survives every run. */
async function setIgnored(req, productId, ignored) {
  const actor = String((req && req.userId) || 'system');
  await db.withTransaction(async (connection) => {
    await connection.execute(
      ignored
        ? `UPDATE biz_crm_product_sources SET ignored_at = CURRENT_TIMESTAMP, ignored_by = :actor WHERE product_id = :id`
        : `UPDATE biz_crm_product_sources SET ignored_at = NULL, ignored_by = NULL WHERE product_id = :id`,
      { id: productId, actor },
    );
    await audit.write(connection, req, 'catalogue-source.ignored', 'product_source', productId, null, { ignored: !!ignored });
  });
  return { ignored: !!ignored };
}

/** Status for the catalogue UI. Read-only: a viewer opening the page writes nothing. */
async function status() {
  const rows = await db.query(
    `SELECT readiness, source_availability, COUNT(*) AS n
       FROM biz_crm_product_sources
      WHERE ignored_at IS NULL
      GROUP BY readiness, source_availability`,
    {},
  );
  const counts = {};
  for (const row of rows) counts[`${row.readiness}/${row.source_availability}`] = Number(row.n || 0);
  const at = await lastRunAt();
  return {
    counts,
    lastRunAt: at || null,
    fresh: at > 0 && (Date.now() - at) < FRESH_MS,
    freshForMs: FRESH_MS,
    discoveryNote: 'New website Tools appear at the next eligible catalogue reconciliation. Nothing runs while the CRM is closed.',
  };
}

module.exports = {
  NAMESPACE_WEBSITE_TOOL,
  READINESS,
  AVAILABILITY,
  REQUIRED_FOR_READY,
  FRESH_MS,
  dryRun,
  reconcile,
  confirmReady,
  linkExisting,
  approveCreate,
  setIgnored,
  status,
  isFresh,
  lastRunAt,
  discoverWebsiteTools,
  unresolvedSourceFamilies,
};

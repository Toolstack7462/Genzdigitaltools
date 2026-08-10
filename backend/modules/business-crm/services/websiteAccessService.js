'use strict';

/**
 * Website access → Business CRM reconciliation (CRM-owned, PULL ONLY).
 *
 * The existing website access system stays the operational source of truth; the Business CRM is
 * the financial source of truth. Nothing in the existing Give Access / Assign Tool / Bulk Assign /
 * Proxy / StealthWriter / renewal flows calls into the CRM, and nothing here writes a website
 * table. This module only READS the existing models and mirrors what it finds into
 * biz_crm_access_links, keyed by a stable external_key so it is safe to run repeatedly.
 *
 * Failure isolation: every source is fetched in its own try/catch and each row is upserted in its
 * own transaction. A broken source, or one bad row, degrades that part only — website access is
 * never affected, and existing CRM financial data is never removed.
 *
 * Reused (not reimplemented) so CRM dates can never diverge from what the client dashboard and the
 * extension actually enforce:
 *   - ToolAssignment.effectiveEndBoundary() / isAssignmentExpired()  (models/ToolAssignment.js)
 *   - buildProxyAssignmentDTOs() / statusFor() / EXPIRING_SOON_DAYS  (utils/proxyAssignments.js)
 * The derived-status shape mirrors backend/routes/admin/assignments.js (see deriveStatus there);
 * it is replicated rather than refactored so that stable file is left untouched.
 */

const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');

// Existing website models — READ ONLY. See the isolation test in tests/business-crm-isolation.test.js,
// which fails the build if this file ever gains a write call against one of them.
const ToolAssignment = require('../../../models/ToolAssignment');
const User = require('../../../models/User');
const { buildProxyAssignmentDTOs, EXPIRING_SOON_DAYS } = require('../../../utils/proxyAssignments');

const SOURCE_TYPES = Object.freeze(['CORE_ASSIGNMENT', 'PROXY', 'STEALTH', 'MANUAL']);
const ACCESS_STATUSES = Object.freeze(['ACTIVE', 'EXPIRING', 'EXPIRED', 'REVOKED', 'SOURCE_MISSING']);
const FINANCIAL_STATUSES = Object.freeze(['NEEDS_FINANCIAL_DETAILS', 'LINKED_TO_SALE', 'NON_BILLABLE', 'IGNORED']);
const CLIENT_LINK_STATES = Object.freeze(['UNLINKED', 'MATCHED', 'CREATED', 'AMBIGUOUS']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function uuid() { return crypto.randomUUID(); }
function actorId(req) { return String(req?.userId || req?.user?._id || 'system'); }

/** YYYY-MM-DD in UTC, or null. Accepts Date, ISO string, or MySQL date string. */
function toDateOnly(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = Math.round((end - start) / MS_PER_DAY);
  return days >= 0 ? days : null;
}

/**
 * Access status for a core ToolAssignment, using the model's own inclusive end-of-day rule.
 * Mirrors the admin assignments DTO: revoked > expired > expiring-soon > active.
 */
function coreAccessStatus(assignment, now = new Date()) {
  if (assignment.status === 'revoked') return 'REVOKED';
  if (assignment.status === 'expired' || ToolAssignment.isAssignmentExpired(assignment, now)) return 'EXPIRED';
  const boundary = ToolAssignment.effectiveEndBoundary(assignment.endDate);
  if (boundary) {
    const remaining = Math.ceil((boundary.getTime() - now.getTime()) / MS_PER_DAY);
    if (remaining <= EXPIRING_SOON_DAYS) return 'EXPIRING';
  }
  return 'ACTIVE';
}

/** Access mode for a core assignment — same rule the admin assignments DTO applies. */
function coreAccessMode(tool) {
  const settings = tool && tool.extensionSettings;
  if (settings && settings.directOpenEnabled === true && settings.requirePermission === false) return 'direct';
  return 'extension';
}

/** Map a proxy/stealth DTO's effectiveStatus onto the CRM vocabulary. */
function proxyAccessStatus(dto) {
  if (dto.status === 'revoked') return 'REVOKED';
  if (dto.effectiveStatus === 'expired') return 'EXPIRED';
  if (dto.effectiveStatus === 'expiring') return 'EXPIRING';
  return 'ACTIVE';
}

/**
 * A safe snapshot of the source row. Deliberately narrow: identity, tool label and dates only.
 * Never provider credentials, cookies, sessions, vault payloads, gateway internals or billing data.
 */
function snapshot(record) {
  return {
    sourceType: record.sourceType,
    externalKey: record.externalKey,
    toolName: record.toolName,
    toolCategory: record.toolCategory,
    accessMode: record.accessMode,
    startDate: record.startDate,
    expiryDate: record.expiryDate,
    accessStatus: record.accessStatus,
    websiteUserId: record.websiteUserId,
    websiteToolId: record.websiteToolId,
    websiteAssignmentId: record.websiteAssignmentId,
  };
}

// ── Source collectors ────────────────────────────────────────────────────────
// Each returns [] on failure so one broken source can never hide the others.

async function collectCoreAssignments() {
  const rows = await ToolAssignment.find({})
    .populate('toolId', 'name category status extensionSettings')
    .populate('clientId', 'fullName email status phone whatsapp');
  const now = new Date();
  const out = [];
  for (const row of rows || []) {
    if (!row || !row._id) continue;
    const tool = row.toolId && typeof row.toolId === 'object' ? row.toolId : null;
    const client = row.clientId && typeof row.clientId === 'object' ? row.clientId : null;
    const startDate = toDateOnly(row.startDate);
    const expiryDate = toDateOnly(row.endDate);
    out.push({
      externalKey: `core:${row._id}`,
      sourceType: 'CORE_ASSIGNMENT',
      websiteUserId: client ? String(client._id) : (row.clientId ? String(row.clientId) : null),
      websiteToolId: tool ? String(tool._id) : (row.toolId ? String(row.toolId) : null),
      websiteAssignmentId: String(row._id),
      clientName: client ? client.fullName || null : null,
      clientEmail: client ? normalizeEmail(client.email) : null,
      clientPhone: client ? (client.whatsapp || client.phone || null) : null,
      toolName: (tool && tool.name) || 'Unknown tool',
      toolCategory: (tool && tool.category) || null,
      accessMode: coreAccessMode(tool),
      startDate,
      expiryDate,
      durationDays: daysBetween(startDate, expiryDate),
      accessStatus: coreAccessStatus(row, now),
    });
  }
  return out;
}

async function collectProxyAndStealth() {
  // buildProxyAssignmentDTOs already fails safe (returns []) and exposes no credentials.
  // Its DTO _id is exactly `proxy:<tool>:<userId>` / `stealth:<userId>` — our external key verbatim.
  const dtos = await buildProxyAssignmentDTOs();
  return (dtos || []).map((dto) => {
    const expiryDate = toDateOnly(dto.endDate);
    const startDate = toDateOnly(dto.startDate);
    return {
      externalKey: String(dto._id),
      sourceType: String(dto._id).startsWith('stealth:') ? 'STEALTH' : 'PROXY',
      websiteUserId: dto.clientId ? String(dto.clientId) : null,
      websiteToolId: null,
      websiteAssignmentId: null,
      clientName: dto.client ? dto.client.fullName || null : null,
      clientEmail: dto.client ? normalizeEmail(dto.client.email) : null,
      clientPhone: null,
      toolName: (dto.tool && dto.tool.name) || 'Unknown tool',
      toolCategory: (dto.tool && dto.tool.category) || null,
      accessMode: dto.accessMode || 'proxy',
      startDate,
      expiryDate,
      durationDays: daysBetween(startDate, expiryDate),
      accessStatus: proxyAccessStatus(dto),
    };
  });
}

/**
 * Enrich proxy/stealth rows whose DTO carried no client identity (the DTO falls back to a bare
 * userId when the user lookup missed). Read-only, best effort.
 */
async function fillMissingClientIdentity(records) {
  const missing = [...new Set(records.filter((r) => r.websiteUserId && !r.clientEmail).map((r) => r.websiteUserId))];
  if (!missing.length) return;
  let users = [];
  try {
    users = await User.find({ _id: { $in: missing } }).select('fullName email phone whatsapp');
  } catch (_) { return; }
  const byId = new Map((users || []).map((u) => [String(u._id), u]));
  for (const record of records) {
    const user = byId.get(String(record.websiteUserId));
    if (!user) continue;
    record.clientName = record.clientName || user.fullName || null;
    record.clientEmail = record.clientEmail || normalizeEmail(user.email);
    record.clientPhone = record.clientPhone || user.whatsapp || user.phone || null;
  }
}

// ── Client auto-linking ──────────────────────────────────────────────────────

/**
 * Resolve a CRM client for a website record, in the documented order:
 *   1. existing CRM client already carrying this website_user_id
 *   2. exactly one non-deleted CRM client with the same normalized email
 *   3. otherwise create a CRM client from the website identity
 * More than one email match is AMBIGUOUS — flagged for review, never merged.
 *
 * Only biz_crm_clients is written. The website `users` row is never modified.
 */
async function resolveCrmClient(connection, req, record) {
  if (!record.websiteUserId) return { crmClientId: null, state: 'UNLINKED' };

  const [byWebsiteId] = await connection.execute(
    'SELECT id FROM biz_crm_clients WHERE website_user_id=:websiteUserId AND deleted_at IS NULL LIMIT 1',
    { websiteUserId: String(record.websiteUserId) },
  );
  if (byWebsiteId.length) return { crmClientId: byWebsiteId[0].id, state: 'MATCHED' };

  if (record.clientEmail) {
    const [byEmail] = await connection.execute(
      'SELECT id FROM biz_crm_clients WHERE LOWER(email)=:email AND deleted_at IS NULL LIMIT 3',
      { email: record.clientEmail },
    );
    if (byEmail.length > 1) return { crmClientId: null, state: 'AMBIGUOUS' };
    if (byEmail.length === 1) {
      // Adopt the website id on the single safe match so later runs take the fast path above.
      await connection.execute(
        'UPDATE biz_crm_clients SET website_user_id=:websiteUserId WHERE id=:id AND website_user_id IS NULL',
        { websiteUserId: String(record.websiteUserId), id: byEmail[0].id },
      );
      return { crmClientId: byEmail[0].id, state: 'MATCHED' };
    }
  }

  const id = uuid();
  await connection.execute(
    `INSERT INTO biz_crm_clients (id,name,whatsapp,email,status,website_user_id,created_by)
     VALUES (:id,:name,:whatsapp,:email,'active',:websiteUserId,:actor)`,
    {
      id,
      name: (record.clientName || record.clientEmail || 'Website client').slice(0, 190),
      whatsapp: record.clientPhone ? String(record.clientPhone).slice(0, 40) : null,
      email: record.clientEmail,
      websiteUserId: String(record.websiteUserId),
      actor: actorId(req),
    },
  );
  return { crmClientId: id, state: 'CREATED' };
}

// ── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Insert or refresh one access link. Operational fields are refreshed from the source on every
 * run; financial linkage (crm_sale_id / crm_sale_item_id / financial_status) and the NON_BILLABLE
 * or IGNORED decision are preserved. A row that has come back from SOURCE_MISSING is reopened.
 */
async function upsertRecord(req, record) {
  return db.withTransaction(async (connection) => {
    const [existingRows] = await connection.execute(
      'SELECT * FROM biz_crm_access_links WHERE external_key=:key LIMIT 1',
      { key: record.externalKey },
    );
    const existing = existingRows[0] || null;

    let crmClientId = existing ? existing.crm_client_id : null;
    let clientLinkState = existing ? existing.client_link_state : 'UNLINKED';
    if (!crmClientId) {
      const resolved = await resolveCrmClient(connection, req, record);
      crmClientId = resolved.crmClientId;
      clientLinkState = resolved.state;
    }

    const shared = {
      key: record.externalKey,
      sourceType: record.sourceType,
      websiteUserId: record.websiteUserId,
      websiteToolId: record.websiteToolId,
      websiteAssignmentId: record.websiteAssignmentId,
      crmClientId,
      clientLinkState,
      clientName: record.clientName,
      clientEmail: record.clientEmail,
      clientPhone: record.clientPhone,
      toolName: String(record.toolName || 'Unknown tool').slice(0, 190),
      toolCategory: record.toolCategory,
      accessMode: record.accessMode,
      startDate: record.startDate,
      expiryDate: record.expiryDate,
      durationDays: record.durationDays,
      accessStatus: record.accessStatus,
      snapshotJson: JSON.stringify(snapshot(record)),
    };

    if (!existing) {
      const id = uuid();
      await connection.execute(
        `INSERT INTO biz_crm_access_links
           (id,external_key,source_type,website_user_id,website_tool_id,website_assignment_id,
            crm_client_id,client_name,client_email,client_phone,client_link_state,
            tool_name,tool_category,access_mode,start_date,expiry_date,duration_days,
            access_status,financial_status,source_snapshot_json,last_seen_at)
         VALUES (:id,:key,:sourceType,:websiteUserId,:websiteToolId,:websiteAssignmentId,
            :crmClientId,:clientName,:clientEmail,:clientPhone,:clientLinkState,
            :toolName,:toolCategory,:accessMode,:startDate,:expiryDate,:durationDays,
            :accessStatus,'NEEDS_FINANCIAL_DETAILS',:snapshotJson,CURRENT_TIMESTAMP)`,
        { id, ...shared },
      );
      await audit.write(connection, req, 'access-link.discovered', 'access_link', id, null, snapshot(record));
      return { created: 1, updated: 0 };
    }

    await connection.execute(
      `UPDATE biz_crm_access_links SET
         source_type=:sourceType, website_user_id=:websiteUserId, website_tool_id=:websiteToolId,
         website_assignment_id=:websiteAssignmentId, crm_client_id=:crmClientId,
         client_name=:clientName, client_email=:clientEmail, client_phone=:clientPhone,
         client_link_state=:clientLinkState, tool_name=:toolName, tool_category=:toolCategory,
         access_mode=:accessMode, start_date=:startDate, expiry_date=:expiryDate,
         duration_days=:durationDays, access_status=:accessStatus,
         source_snapshot_json=:snapshotJson, source_missing_at=NULL, last_seen_at=CURRENT_TIMESTAMP
       WHERE external_key=:key`,
      shared,
    );
    return { created: 0, updated: 1 };
  });
}

/**
 * Rows we did not see this run. Marked SOURCE_MISSING and never deleted, so the invoice, payments
 * and profit history attached to a removed website assignment survive intact. IGNORED and
 * NON_BILLABLE rows keep their financial decision; only the access status moves.
 */
async function markMissing(req, seenKeys) {
  const [rows] = await db.getPool().execute(
    "SELECT id, external_key, access_status FROM biz_crm_access_links WHERE access_status <> 'SOURCE_MISSING'",
  );
  const missing = (rows || []).filter((row) => !seenKeys.has(row.external_key));
  let marked = 0;
  for (const row of missing) {
    try {
      await db.query(
        `UPDATE biz_crm_access_links
            SET access_status='SOURCE_MISSING', source_missing_at=CURRENT_TIMESTAMP
          WHERE id=:id`,
        { id: row.id },
      );
      marked += 1;
    } catch (_) { /* one stubborn row must not abort the sweep */ }
  }
  return marked;
}

/**
 * Full reconciliation. Idempotent: re-running with an unchanged website state produces no new rows
 * and no duplicates, because every row is keyed by its stable external_key.
 *
 * Returns a summary including per-source errors, so the UI can show a partial-failure warning
 * instead of pretending the sweep was complete.
 */
async function reconcile(req) {
  const errors = [];
  let records = [];

  try {
    records = records.concat(await collectCoreAssignments());
  } catch (error) {
    errors.push({ source: 'CORE_ASSIGNMENT', message: error.message });
  }

  let proxyOk = true;
  try {
    records = records.concat(await collectProxyAndStealth());
  } catch (error) {
    proxyOk = false;
    errors.push({ source: 'PROXY_STEALTH', message: error.message });
  }

  try { await fillMissingClientIdentity(records); } catch (_) { /* identity enrichment is optional */ }

  let created = 0;
  let updated = 0;
  const seenKeys = new Set();
  for (const record of records) {
    if (!record.externalKey || seenKeys.has(record.externalKey)) continue;
    seenKeys.add(record.externalKey);
    try {
      const result = await upsertRecord(req, record);
      created += result.created;
      updated += result.updated;
    } catch (error) {
      errors.push({ source: record.sourceType, externalKey: record.externalKey, message: error.message });
    }
  }

  // Only sweep for disappeared rows when EVERY source reported successfully. A transient proxy
  // outage must never flip healthy proxy links to SOURCE_MISSING.
  let markedMissing = 0;
  const sweepSafe = errors.length === 0 && proxyOk;
  if (sweepSafe) {
    try { markedMissing = await markMissing(req, seenKeys); } catch (error) { errors.push({ source: 'SWEEP', message: error.message }); }
  }

  return {
    scanned: seenKeys.size,
    created,
    updated,
    markedMissing,
    sweepSkipped: !sweepSafe,
    errors,
    partial: errors.length > 0,
    completedAt: new Date().toISOString(),
  };
}

// ── Read model ───────────────────────────────────────────────────────────────

function mapLink(row) {
  if (!row) return row;
  return {
    id: row.id,
    externalKey: row.external_key,
    sourceType: row.source_type,
    websiteUserId: row.website_user_id,
    websiteToolId: row.website_tool_id,
    websiteAssignmentId: row.website_assignment_id,
    crmClientId: row.crm_client_id,
    crmSaleId: row.crm_sale_id,
    crmSaleItemId: row.crm_sale_item_id,
    clientName: row.client_name,
    clientEmail: row.client_email,
    clientPhone: row.client_phone,
    clientLinkState: row.client_link_state,
    toolName: row.tool_name,
    toolCategory: row.tool_category,
    accessMode: row.access_mode,
    startDate: row.start_date,
    expiryDate: row.expiry_date,
    durationDays: row.duration_days,
    accessStatus: row.access_status,
    financialStatus: row.financial_status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sourceMissingAt: row.source_missing_at,
    ignoredAt: row.ignored_at,
    // Operational fields are owned by the website access system and are read-only in the CRM.
    operationalReadOnly: true,
  };
}

async function listLinks(filters = {}, paging = { limit: 25, offset: 0 }) {
  const where = ['1=1'];
  const params = { limit: Number(paging.limit), offset: Number(paging.offset) };
  if (filters.financialStatus && FINANCIAL_STATUSES.includes(filters.financialStatus)) {
    where.push('financial_status=:financialStatus');
    params.financialStatus = filters.financialStatus;
  }
  if (filters.accessStatus && ACCESS_STATUSES.includes(filters.accessStatus)) {
    where.push('access_status=:accessStatus');
    params.accessStatus = filters.accessStatus;
  }
  if (filters.sourceType && SOURCE_TYPES.includes(filters.sourceType)) {
    where.push('source_type=:sourceType');
    params.sourceType = filters.sourceType;
  }
  if (filters.search) {
    // client_phone and source_type complete the set of columns the operator can actually see in the
    // table, so every visible field is searchable. external_key is included because it is the only
    // handle on a SOURCE_MISSING row whose tool name has since changed upstream.
    where.push(`(client_name LIKE :search OR client_email LIKE :search OR client_phone LIKE :search
      OR tool_name LIKE :search OR source_type LIKE :search OR external_key LIKE :search)`);
    params.search = filters.search;
  }
  const clause = where.join(' AND ');
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM biz_crm_access_links WHERE ${clause}
        ORDER BY (financial_status='NEEDS_FINANCIAL_DETAILS') DESC, expiry_date IS NULL, expiry_date ASC, tool_name ASC
        LIMIT :limit OFFSET :offset`,
      params,
    ),
    db.query(`SELECT COUNT(*) total FROM biz_crm_access_links WHERE ${clause}`, params),
  ]);
  return { rows: (rows || []).map(mapLink), total: Number(count[0]?.total || 0) };
}

async function getLink(id) {
  const rows = await db.query('SELECT * FROM biz_crm_access_links WHERE id=:id LIMIT 1', { id });
  return rows[0] ? mapLink(rows[0]) : null;
}

async function summary() {
  const rows = await db.query(
    'SELECT financial_status, access_status, COUNT(*) total FROM biz_crm_access_links GROUP BY financial_status, access_status',
  );
  const byFinancial = {};
  const byAccess = {};
  for (const row of rows || []) {
    byFinancial[row.financial_status] = (byFinancial[row.financial_status] || 0) + Number(row.total);
    byAccess[row.access_status] = (byAccess[row.access_status] || 0) + Number(row.total);
  }
  return { byFinancial, byAccess };
}

/** Attach a created sale + item to an access link. Called after the normal CRM sale pipeline runs. */
async function attachSale(req, linkId, saleId, saleItemId, externalKey) {
  await db.withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE biz_crm_access_links
          SET crm_sale_id=:saleId, crm_sale_item_id=:saleItemId, financial_status='LINKED_TO_SALE'
        WHERE id=:id`,
      { saleId, saleItemId, id: linkId },
    );
    await connection.execute(
      `UPDATE biz_crm_sale_items SET access_source=:sourceType, access_external_key=:externalKey WHERE id=:saleItemId`,
      { sourceType: 'WEBSITE_LINKED', externalKey, saleItemId },
    );
    await audit.write(connection, req, 'access-link.financial-linked', 'access_link', linkId, null, { saleId, saleItemId });
  });
}

async function setFinancialStatus(req, linkId, financialStatus) {
  if (!FINANCIAL_STATUSES.includes(financialStatus)) throw new Error('Unknown financial status');
  await db.withTransaction(async (connection) => {
    const [before] = await connection.execute('SELECT financial_status FROM biz_crm_access_links WHERE id=:id LIMIT 1', { id: linkId });
    const ignoring = financialStatus === 'NON_BILLABLE' || financialStatus === 'IGNORED';
    await connection.execute(
      `UPDATE biz_crm_access_links
          SET financial_status=:financialStatus,
              ignored_at=${ignoring ? 'CURRENT_TIMESTAMP' : 'NULL'},
              ignored_by=${ignoring ? ':actor' : 'NULL'}
        WHERE id=:id`,
      ignoring ? { financialStatus, actor: actorId(req), id: linkId } : { financialStatus, id: linkId },
    );
    await audit.write(connection, req, 'access-link.financial-status', 'access_link', linkId, before[0] || null, { financialStatus });
  });
}

module.exports = {
  SOURCE_TYPES,
  ACCESS_STATUSES,
  FINANCIAL_STATUSES,
  CLIENT_LINK_STATES,
  reconcile,
  listLinks,
  getLink,
  summary,
  attachSale,
  setFinancialStatus,
  // exported for tests
  coreAccessStatus,
  coreAccessMode,
  proxyAccessStatus,
  daysBetween,
  snapshot,
};

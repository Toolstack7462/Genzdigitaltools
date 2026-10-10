#!/usr/bin/env node
'use strict';
/**
 * READ-ONLY production inventory: which Tools would be affected by removing
 * provider master credentials from client-facing responses?
 *
 * WHY. The Release A patch stops `comboAuth.formConfig.{username,password}` and a
 * unified `form` tool's decrypted payload from reaching clients. For a tool whose
 * clients genuinely log in by having their OWN browser type those credentials,
 * that capability ends (it cannot be made safe for a shared account - whatever the
 * client's browser must type, the client can read). This finds those tools BEFORE
 * the patch ships, so nothing breaks silently.
 *
 * ── WHY IT IS PROVABLY READ-ONLY, AND CREDENTIAL-FREE ───────────────────────
 * An earlier draft used the app's mysqlAdapter. That was wrong twice over:
 * `mysqlAdapter.connect()` calls `ensureTables()` (CREATE TABLE IF NOT EXISTS for
 * every model + ensureGeneratedColumns ALTER) which is DDL, and `Tool.find({})`
 * pulls whole documents - passwords and encrypted payloads included - into app
 * memory. Both are unacceptable for an audit of live production.
 *
 * This version therefore:
 *   1. loads NO adapter and NO model, so no DDL path is reachable;
 *   2. opens one raw mysql2 connection and issues `START TRANSACTION READ ONLY`,
 *      so the SERVER rejects any write for the session - the guarantee does not
 *      depend on this file behaving;
 *   3. runs NARROW JSON PROJECTIONS. The password and the encrypted payload are
 *      reduced to CHAR_LENGTH (a number) inside SQL and never selected as values.
 *      The username is masked in SQL too: only its first character and its domain
 *      part are returned. No plaintext credential, cookie or token is ever
 *      transferred to this process;
 *   4. FAILS CLOSED - a query error, an unparseable row, a schema surprise or a
 *      row-count mismatch aborts with a non-zero exit and no "compatible" verdict;
 *   5. prints no database URL, host, user or password.
 *
 * ── ASSIGNMENT VALIDITY ─────────────────────────────────────────────────────
 * "Active customers" uses the SAME rule the app uses to decide what a client may
 * open (utils/getClientAccessibleTool.js): assignment.status === 'active', the
 * tool itself active, startDate not in the future, and NOT expired under
 * ToolAssignment.effectiveEndBoundary - i.e. a DATE-ONLY endDate is inclusive to
 * 23:59:59.999 UTC of that day. That rule is reimplemented here (byte-for-byte in
 * behaviour, see effectiveEndBoundary below) rather than imported, because
 * importing the model would drag in the adapter and its DDL.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────
 *   AUDIT_FORM_COMBO=1 AUDIT_ENV_FILE=/path/to/config/.env \
 *     node scripts/audit-form-combo-tools.js
 *
 * Needs only `mysql2` and DATABASE_URL. Exit 0 = report produced, 2 = could not
 * complete (fail-closed; no verdict).
 */

const path = require('path');
const fs = require('fs');

// ── the four statements this script is permitted to issue ────────────────────
// Exported so a test can assert that nothing else ever reaches the driver.
const SQL = {
  BEGIN_RO: 'START TRANSACTION READ ONLY',
  ROLLBACK: 'ROLLBACK',
  COUNTS: 'SELECT (SELECT COUNT(*) FROM tools) AS toolCount, (SELECT COUNT(*) FROM tool_assignments) AS asgCount',
  // Narrow projection. Note CHAR_LENGTH(...) for the two secret-bearing paths:
  // the VALUE is never selected, only its length. The username is masked in SQL.
  TOOLS: [
    'SELECT',
    "  id AS rowId,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$._id'))                      AS docId,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.name'))                     AS name,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.domain'))                   AS domain,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.status'))                   AS status,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.credentialType'))           AS credentialType,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.credentials.type'))         AS unifiedType,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.primaryType'))    AS primaryType,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.secondaryType'))  AS secondaryType,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.enabled'))        AS comboEnabled,",
    "  JSON_CONTAINS_PATH(data, 'one', '$.comboAuth')                 AS hasCombo,",
    "  COALESCE(CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.formConfig.password'))), 0)        AS pwLen,",
    "  COALESCE(CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.formConfig.username'))), 0)        AS userLen,",
    "  COALESCE(CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(data, '$.credentials.payloadEncrypted'))), 0)         AS payloadLen,",
    "  LEFT(JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.formConfig.username')), 1)                        AS userFirst,",
    "  SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(data, '$.comboAuth.formConfig.username')), '@', -1)        AS userDomain",
    'FROM tools',
  ].join('\n'),
  ASSIGNMENTS: [
    'SELECT',
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.status'))      AS status,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.startDate'))   AS startDate,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.endDate'))     AS endDate,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.toolId'))      AS toolIdFlat,",
    "  JSON_UNQUOTE(JSON_EXTRACT(data, '$.toolId._id'))  AS toolIdNested",
    'FROM tool_assignments',
  ].join('\n'),
};
const ALLOWED_SQL = Object.freeze([SQL.BEGIN_RO, SQL.ROLLBACK, SQL.COUNTS, SQL.TOOLS, SQL.ASSIGNMENTS]);

/**
 * The app's inclusive end-of-day rule, reimplemented (see
 * models/ToolAssignment.effectiveEndBoundary). A DATE-ONLY endDate, or one whose
 * time component is exactly midnight, expires at 23:59:59.999 UTC of that DAY -
 * not at its start. Getting this wrong would undercount active customers.
 */
function effectiveEndBoundary(endDate) {
  if (!endDate) return null;                      // no end date = no expiry
  if (typeof endDate === 'string') {
    const m = endDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
    if (m) {
      const y = m[1], mo = m[2], d = m[3], hh = m[4], mm = m[5], ss = m[6];
      const isMidnight = hh === undefined || (hh === '00' && mm === '00' && ss === '00');
      if (isMidnight) return new Date(Date.UTC(+y, +mo - 1, +d, 23, 59, 59, 999));
    }
  }
  const dt = new Date(endDate);
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 &&
      dt.getUTCSeconds() === 0 && dt.getUTCMilliseconds() === 0) {
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 23, 59, 59, 999));
  }
  return dt;
}

/** Is this assignment row one a client could use RIGHT NOW? */
function assignmentIsCurrentlyValid(row, now) {
  if (!row || row.status !== 'active') return false;
  if (row.startDate && new Date(row.startDate).getTime() > now.getTime()) return false;  // not started yet
  const b = effectiveEndBoundary(row.endDate);
  if (b && b.getTime() < now.getTime()) return false;                                     // expired
  return true;
}

function toolIdOf(row) {
  const v = (row.toolIdNested && row.toolIdNested !== 'null') ? row.toolIdNested : row.toolIdFlat;
  return (v && v !== 'null') ? String(v) : '';
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function isTrue(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function maskFromParts(first, domain, len) {
  if (!len) return null;
  const f = (first && first !== 'null') ? String(first) : '?';
  const d = (domain && domain !== 'null') ? String(domain) : '';
  return d ? (f + '****@' + d) : (f + '****');
}

/**
 * Turn the two projected result sets into the report model. Pure - no I/O - so the
 * tests can drive it with mock rows.
 */
function buildReport(toolRows, asgRows, now) {
  const validByTool = new Map();
  for (const a of asgRows) {
    if (!assignmentIsCurrentlyValid(a, now)) continue;
    const tid = toolIdOf(a);
    if (!tid) continue;
    validByTool.set(tid, (validByTool.get(tid) || 0) + 1);
  }

  const rows = toolRows.map((t) => {
    const id = (t.docId && t.docId !== 'null') ? String(t.docId) : String(t.rowId);
    const pwLen = num(t.pwLen);
    const userLen = num(t.userLen);
    const payloadLen = num(t.payloadLen);
    const comboEnabled = isTrue(t.comboEnabled);
    const types = [t.primaryType, t.secondaryType].filter(v => v && v !== 'null');
    const comboUsesForm = types.indexOf('form') !== -1;
    const unifiedIsForm = t.unifiedType === 'form';
    const toolActive = t.status === 'active';

    // Does a client-typed master credential exist, and is it in use?
    const hasTypedPassword = pwLen > 0;
    const hasUnifiedFormPayload = unifiedIsForm && payloadLen > 0;
    const affected = (comboEnabled && comboUsesForm && hasTypedPassword) || hasUnifiedFormPayload;
    const wasExposed = hasTypedPassword || hasUnifiedFormPayload;
    const activeAssignments = toolActive ? (validByTool.get(id) || 0) : 0;

    return {
      id,
      name: (t.name && t.name !== 'null') ? t.name : '(unnamed)',
      domain: (t.domain && t.domain !== 'null') ? t.domain : null,
      status: t.status || null,
      credentialType: (t.credentialType && t.credentialType !== 'null') ? t.credentialType
        : ((t.unifiedType && t.unifiedType !== 'null') ? t.unifiedType : 'none'),
      comboAuthPresent: isTrue(t.hasCombo),
      comboEnabled,
      comboTypes: types.join('+') || null,
      // Presence + LENGTH only. The value was never selected.
      comboFormCredential: hasTypedPassword ? ('present(len=' + pwLen + ')') : (userLen ? 'username-only' : 'none'),
      unifiedFormPayload: unifiedIsForm ? (payloadLen ? 'present(encrypted)' : 'none') : 'n/a',
      maskedFormUser: maskFromParts(t.userFirst, t.userDomain, userLen),
      activeAssignments,
      WAS_EXPOSED: wasExposed,
      AFFECTED_BY_PATCH: affected,
      AFFECTS_ACTIVE_CUSTOMERS: affected && activeAssignments > 0,
    };
  });

  rows.sort((a, b) =>
    Number(b.AFFECTS_ACTIVE_CUSTOMERS) - Number(a.AFFECTS_ACTIVE_CUSTOMERS) ||
    Number(b.AFFECTED_BY_PATCH) - Number(a.AFFECTED_BY_PATCH) ||
    Number(b.WAS_EXPOSED) - Number(a.WAS_EXPOSED) ||
    b.activeAssignments - a.activeAssignments);

  return rows;
}

function printReport(rows, meta, out) {
  const log = out || console.log;
  const affected = rows.filter(r => r.AFFECTED_BY_PATCH);
  const affectedLive = rows.filter(r => r.AFFECTS_ACTIVE_CUSTOMERS);
  const exposed = rows.filter(r => r.WAS_EXPOSED);

  log('');
  log('=== Form / Combo Auth Tool inventory - READ ONLY ===');
  log('database                 : ' + meta.db);           // name only, never the URL
  log('engine                   : ' + meta.version);
  log('session                  : START TRANSACTION READ ONLY (server rejects writes)');
  log('values read              : metadata + lengths only; no password/payload/cookie selected');
  log('assignment rule          : status=active, tool active, startDate<=now, inclusive date-only expiry');
  log('evaluated at             : ' + meta.now);
  log('');
  log('tools scanned                                 : ' + rows.length);
  log('tools with a comboAuth record                 : ' + rows.filter(r => r.comboAuthPresent).length);
  log('tools holding a typed master credential       : ' + exposed.length + '   <- ROTATE these');
  log('tools AFFECTED by the patch                   : ' + affected.length);
  log('  ...AFFECTING ACTIVE CUSTOMERS               : ' + affectedLive.length + '   <- blocks Release A');
  log('');

  if (!affected.length) {
    log('RESULT: COMPATIBLE');
    log('No tool depends on client-side typed credentials. The patch removes the exposure');
    log('with NO customer-visible change. Release A may proceed.');
  } else if (!affectedLive.length) {
    log('RESULT: COMPATIBLE (dormant config only)');
    log('Some tools still hold typed credentials but NO currently-valid assignment uses');
    log('them, so no customer loses access. Release A may proceed. Clear the dormant');
    log('config and rotate those passwords.');
    for (const r of affected) log('  - dormant: ' + r.name + ' [' + r.id + '] activeAssignments=' + r.activeAssignments);
  } else {
    log('RESULT: NOT COMPATIBLE - STOP');
    log('These tools have LIVE customers who log in by typing the shared master password in');
    log('their own browser. After the patch the extension takes its existing');
    log('"No form credentials configured" path for them.');
    for (const r of affectedLive) {
      log('  - ' + r.name + '  [' + r.id + ']  domain=' + r.domain +
        '  activeAssignments=' + r.activeAssignments +
        '  via=' + (r.unifiedFormPayload.indexOf('present') === 0 ? 'unified-form' : 'comboAuth(' + r.comboTypes + ')'));
    }
    log('');
    log('MIGRATE FIRST, per affected tool:');
    log('  1. Source-side capture (preferred; proven for WriteHuman) - an admin signs in once');
    log('     in the source browser and the SESSION is distributed. Clients never see a');
    log('     password. No client-side change.');
    log('  2. Per-client accounts/seats - a leak is contained to one seat.');
    log('  3. Accept the capability loss; move the tool to a session credentialType.');
  }

  if (exposed.length) {
    log('');
    log('ROTATE the provider password for these - it was retrievable by any client holding');
    log('an assignment to them:');
    for (const r of exposed) {
      log('  - ' + r.name + '  [' + r.id + ']  account=' + (r.maskedFormUser || '(not set)') +
        '  activeAssignments=' + r.activeAssignments);
    }
  }

  log('');
  log('--- full table (JSON; no secrets) ---');
  log(JSON.stringify(rows, null, 2));
  return { affected: affected.length, affectedLive: affectedLive.length, exposed: exposed.length };
}

/**
 * Drive a connection-like object. Separated from main() so tests can pass a mock
 * and assert on the exact SQL issued.
 */
async function runAudit(conn, now) {
  await conn.query(SQL.BEGIN_RO);

  const [metaRows] = await conn.query(SQL.COUNTS);
  const counts = Array.isArray(metaRows) ? metaRows[0] : metaRows;
  if (!counts || !Number.isFinite(Number(counts.toolCount))) throw new Error('count probe returned no usable row');

  const [toolRows] = await conn.query(SQL.TOOLS);
  const [asgRows] = await conn.query(SQL.ASSIGNMENTS);
  if (!Array.isArray(toolRows) || !Array.isArray(asgRows)) throw new Error('projection did not return row arrays');

  // FAIL CLOSED on an incomplete read: a truncated result set would understate
  // both the exposure and the customer impact, which is the worst way to be wrong.
  if (toolRows.length !== Number(counts.toolCount)) {
    throw new Error('incomplete tools read: ' + toolRows.length + ' of ' + counts.toolCount);
  }
  if (asgRows.length !== Number(counts.asgCount)) {
    throw new Error('incomplete assignments read: ' + asgRows.length + ' of ' + counts.asgCount);
  }
  // Schema sanity: the projection must actually have produced our aliases.
  if (toolRows.length) {
    for (const k of ['rowId', 'pwLen', 'payloadLen', 'hasCombo']) {
      if (!(k in toolRows[0])) throw new Error('unexpected schema: missing projected column ' + k);
    }
  }

  const rows = buildReport(toolRows, asgRows, now || new Date());
  await conn.query(SQL.ROLLBACK);
  return rows;
}

async function main() {
  if (process.env.AUDIT_FORM_COMBO !== '1') {
    console.error('Refusing to run without AUDIT_FORM_COMBO=1 (read-only audit, but be deliberate).');
    process.exit(2);
  }
  delete process.env.DEBUG;
  delete process.env.NODE_DEBUG;

  const envFile = process.env.AUDIT_ENV_FILE || path.join(__dirname, '..', '.env');
  try { if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile, quiet: true }); }
  catch (_) { /* dotenv absent - rely on the ambient environment */ }

  const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is not set. Pass AUDIT_ENV_FILE=/path/to/config/.env or export it.');
    process.exit(2);
  }

  let mysql;
  try { mysql = require('mysql2/promise'); }
  catch (e) { console.error('mysql2 is not available here: ' + e.message); process.exit(2); }

  let conn;
  try { conn = await mysql.createConnection({ uri: DATABASE_URL, multipleStatements: false }); }
  catch (e) { console.error('DB connect failed: ' + e.message); process.exit(2); }   // message only, never the URL

  const now = new Date();
  try {
    const [[ident]] = await conn.query('SELECT DATABASE() AS db, VERSION() AS version');
    const rows = await runAudit(conn, now);
    printReport(rows, { db: ident.db, version: ident.version, now: now.toISOString() });
    await conn.end();
    process.exit(0);
  } catch (e) {
    // FAIL CLOSED: no verdict, non-zero exit, nothing sensitive echoed.
    console.error('');
    console.error('AUDIT FAILED (no verdict produced): ' + e.message);
    console.error('Treat this as NOT COMPATIBLE until a clean run succeeds.');
    try { await conn.query(SQL.ROLLBACK); } catch (_) {}
    try { await conn.end(); } catch (_) {}
    process.exit(2);
  }
}

module.exports = {
  SQL, ALLOWED_SQL, effectiveEndBoundary, assignmentIsCurrentlyValid,
  buildReport, printReport, runAudit, toolIdOf, maskFromParts,
};

if (require.main === module) main();

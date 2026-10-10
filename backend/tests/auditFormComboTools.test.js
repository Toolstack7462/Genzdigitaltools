/**
 * Guards for the READ-ONLY production audit (scripts/audit-form-combo-tools.js).
 *
 * The script runs against LIVE production, so two properties matter more than its
 * output: it must issue nothing but permitted read-only SQL, and no provider
 * credential may ever reach this process. Both are asserted here against a mock
 * connection, plus the assignment-validity rule it reimplements and its
 * fail-closed behaviour.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const A = require('../scripts/audit-form-combo-tools.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'audit-form-combo-tools.js'), 'utf8');

const PW = 'MASTER-PASSWORD-must-never-appear';
const USER = 'master-account@provider.com';

// A projected tools row, as the SQL would return it: lengths, not values.
function toolRow(o) {
  return Object.assign({
    rowId: 'ca529b36b1499f7adaf327b4', docId: 'ca529b36b1499f7adaf327b4',
    name: 'WriteHuman', domain: 'writehuman.ai', status: 'active',
    credentialType: 'cookies', unifiedType: 'cookies',
    primaryType: 'sso', secondaryType: 'form', comboEnabled: 'false', hasCombo: 1,
    pwLen: 0, userLen: 0, payloadLen: 0, userFirst: null, userDomain: null,
  }, o || {});
}
function asgRow(o) {
  return Object.assign({ status: 'active', startDate: null, endDate: null, toolIdFlat: 'ca529b36b1499f7adaf327b4', toolIdNested: null }, o || {});
}

// A mock connection that records every statement and can be told to misbehave.
function mockConn(opts) {
  const o = opts || {};
  const issued = [];
  return {
    issued,
    async query(sql) {
      issued.push(sql);
      if (sql === A.SQL.BEGIN_RO || sql === A.SQL.ROLLBACK) return [[], []];
      if (sql === A.SQL.COUNTS) {
        if (o.badCounts) return [[], []];
        return [[{ toolCount: (o.tools || []).length + (o.toolCountSkew || 0), asgCount: (o.asgs || []).length + (o.asgCountSkew || 0) }], []];
      }
      if (sql === A.SQL.TOOLS) {
        if (o.toolsThrow) throw new Error('projection exploded');
        if (o.toolsNotArray) return [{ nope: true }, []];
        return [o.tools || [], []];
      }
      if (sql === A.SQL.ASSIGNMENTS) return [o.asgs || [], []];
      if (sql === 'SELECT DATABASE() AS db, VERSION() AS version') return [[{ db: 'testdb', version: '11.8.9-MariaDB' }], []];
      throw new Error('UNEXPECTED SQL: ' + sql);
    },
    async end() { this.ended = true; },
  };
}

// ── read-only SQL contract ───────────────────────────────────────────────────
test('only permitted read-only SQL is ever issued', async () => {
  const conn = mockConn({ tools: [toolRow()], asgs: [asgRow()] });
  await A.runAudit(conn, new Date());
  assert.ok(conn.issued.length > 0);
  for (const sql of conn.issued) {
    assert.ok(A.ALLOWED_SQL.indexOf(sql) !== -1, 'non-allowlisted statement issued: ' + sql);
    const head = sql.trim().split(/\s+/)[0].toUpperCase();
    assert.ok(head === 'SELECT' || head === 'START' || head === 'ROLLBACK', 'non read-only verb: ' + head);
  }
});

test('the read-only transaction opens FIRST and is closed at the end', async () => {
  const conn = mockConn({ tools: [toolRow()], asgs: [asgRow()] });
  await A.runAudit(conn, new Date());
  assert.strictEqual(conn.issued[0], A.SQL.BEGIN_RO, 'the session must become read-only before any read');
  assert.strictEqual(conn.issued[conn.issued.length - 1], A.SQL.ROLLBACK, 'the transaction must be closed');
});

test('no statement contains a write or DDL verb', () => {
  for (const sql of A.ALLOWED_SQL) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|GRANT|SET)\b/i.test(sql),
      'write/DDL verb in permitted SQL: ' + sql);
  }
});

test('the projection never selects a credential VALUE, only its length', () => {
  // The two secret-bearing paths must appear exclusively inside CHAR_LENGTH(...).
  for (const secretPath of ['formConfig.password', 'credentials.payloadEncrypted']) {
    const re = new RegExp("[^\\n]*" + secretPath.replace('.', '\\.') + "[^\\n]*", 'g');
    const lines = A.SQL.TOOLS.match(re) || [];
    assert.ok(lines.length > 0, 'expected the projection to reference ' + secretPath);
    for (const line of lines) {
      assert.ok(/CHAR_LENGTH\(/.test(line), secretPath + ' must only be read via CHAR_LENGTH: ' + line.trim());
    }
  }
  // The username is masked in SQL: only first char + domain part leave the server.
  assert.ok(/LEFT\(JSON_UNQUOTE\(JSON_EXTRACT\(data, '\$\.comboAuth\.formConfig\.username'\)\), 1\)/.test(A.SQL.TOOLS));
  assert.ok(/SUBSTRING_INDEX\(/.test(A.SQL.TOOLS));
  // And the whole document is never selected.
  assert.ok(!/SELECT\s+[^]*?\bdata\b\s*(,|FROM)/i.test(A.SQL.TOOLS.replace(/JSON_\w+\(data/g, 'X(')),
    'the raw data column must never be selected wholesale');
});

test('no adapter, model or DDL path is reachable from the script', () => {
  assert.ok(!/require\(['"][^'"]*mysqlAdapter/.test(SRC), 'must not require the adapter');
  assert.ok(!/require\(['"][^'"]*models\//.test(SRC), 'must not require any model');
  assert.ok(!/ensureTables|ensureGeneratedColumns/.test(SRC.replace(/\*[^*]*\*/g, '')) || /ensureTables\(\)` \(CREATE/.test(SRC),
    'ensureTables may only be mentioned in the explanatory comment');
  const requires = (SRC.match(/require\((['"][^'"]+['"])\)/g) || []).map(s => s.replace(/require\(|\)|['"]/g, ''));
  for (const r of requires) {
    assert.ok(['path', 'fs', 'dotenv', 'mysql2/promise'].indexOf(r) !== -1, 'unexpected dependency: ' + r);
  }
});

// ── credential containment in the OUTPUT ─────────────────────────────────────
test('OUTPUT: no credential value can appear, because none is ever received', () => {
  // Even if a hostile/odd row carried values, the report model only reads lengths
  // and the masked parts, so the printed body cannot contain them.
  const rows = A.buildReport([toolRow({
    comboEnabled: 'true', primaryType: 'form', pwLen: PW.length, userLen: USER.length,
    userFirst: 'm', userDomain: 'provider.com',
    // deliberately present, and deliberately ignored by the model:
    password: PW, username: USER,
  })], [asgRow()], new Date());
  const lines = [];
  A.printReport(rows, { db: 'testdb', version: '11.8.9', now: new Date().toISOString() }, (s) => lines.push(String(s)));
  const blob = lines.join('\n');
  assert.ok(blob.indexOf(PW) === -1, 'PASSWORD LEAKED into the report');
  assert.ok(blob.indexOf(USER) === -1, 'full username leaked into the report');
  assert.ok(blob.indexOf('m****@provider.com') !== -1, 'the account should appear masked');
  assert.ok(/present\(len=\d+\)/.test(blob), 'credential presence should be reported as a length');
});

test('OUTPUT: the database URL, host and user are never printed', () => {
  const lines = [];
  A.printReport(A.buildReport([toolRow()], [], new Date()), { db: 'testdb', version: '11.8.9', now: 'x' }, (s) => lines.push(String(s)));
  const blob = lines.join('\n');
  assert.ok(!/mysql:\/\//.test(blob), 'no connection URL');
  assert.ok(!/sanitizeUrl|@127\.0\.0\.1|password=/.test(blob));
  assert.ok(!/\burl\b\s*:/i.test(blob), 'the report must not carry a url field');
  // The script must not even build a URL string for display.
  assert.ok(!/sanitizeUrl/.test(SRC), 'the URL-printing helper must be gone');
});

// ── assignment validity: the app's real rule ─────────────────────────────────
test('a DATE-ONLY endDate is inclusive to 23:59:59.999 UTC of that day', () => {
  const b = A.effectiveEndBoundary('2026-06-10');
  assert.strictEqual(b.toISOString(), '2026-06-10T23:59:59.999Z');
  // all three shapes the DB can return must agree
  assert.strictEqual(A.effectiveEndBoundary('2026-06-10 00:00:00').toISOString(), '2026-06-10T23:59:59.999Z');
  assert.strictEqual(A.effectiveEndBoundary('2026-06-10T00:00:00.000Z').toISOString(), '2026-06-10T23:59:59.999Z');
  // a real mid-day timestamp is left alone
  assert.strictEqual(A.effectiveEndBoundary('2026-06-10T14:30:00.000Z').toISOString(), '2026-06-10T14:30:00.000Z');
  assert.strictEqual(A.effectiveEndBoundary(null), null);
  assert.strictEqual(A.effectiveEndBoundary('nonsense'), null);
});

test('an assignment expiring TODAY still counts as active (the off-by-one that matters)', () => {
  const now = new Date('2026-06-10T09:00:00.000Z');
  assert.strictEqual(A.assignmentIsCurrentlyValid(asgRow({ endDate: '2026-06-10' }), now), true);
  assert.strictEqual(A.assignmentIsCurrentlyValid(asgRow({ endDate: '2026-06-09' }), now), false);
});

test('a future startDate does not count, and a non-active status never counts', () => {
  const now = new Date('2026-06-10T09:00:00.000Z');
  assert.strictEqual(A.assignmentIsCurrentlyValid(asgRow({ startDate: '2026-07-01' }), now), false);
  assert.strictEqual(A.assignmentIsCurrentlyValid(asgRow({ startDate: '2026-06-01' }), now), true);
  for (const status of ['expired', 'revoked', 'pending', null]) {
    assert.strictEqual(A.assignmentIsCurrentlyValid(asgRow({ status }), now), false, 'status ' + status);
  }
});

test('assignments are matched to tools by flat OR nested toolId', () => {
  assert.strictEqual(A.toolIdOf(asgRow({ toolIdFlat: 'abc', toolIdNested: null })), 'abc');
  assert.strictEqual(A.toolIdOf(asgRow({ toolIdFlat: 'null', toolIdNested: 'xyz' })), 'xyz');
  assert.strictEqual(A.toolIdOf(asgRow({ toolIdFlat: 'null', toolIdNested: 'null' })), '');
});

// ── the verdict logic ────────────────────────────────────────────────────────
test('VERDICT: a cookies tool with combo disabled is neither exposed nor affected', () => {
  const r = A.buildReport([toolRow()], [asgRow()], new Date())[0];
  assert.strictEqual(r.WAS_EXPOSED, false);
  assert.strictEqual(r.AFFECTED_BY_PATCH, false);
  assert.strictEqual(r.activeAssignments, 1, 'the live assignment should still be counted');
});

test('VERDICT: enabled form auth with a password AND live customers blocks Release A', () => {
  const rows = A.buildReport(
    [toolRow({ comboEnabled: 'true', primaryType: 'form', pwLen: 24, userLen: 20, userFirst: 'm', userDomain: 'p.com' })],
    [asgRow(), asgRow()], new Date());
  assert.strictEqual(rows[0].AFFECTED_BY_PATCH, true);
  assert.strictEqual(rows[0].AFFECTS_ACTIVE_CUSTOMERS, true);
  assert.strictEqual(rows[0].activeAssignments, 2);
});

test('VERDICT: the same tool with only EXPIRED assignments is dormant, not blocking', () => {
  const now = new Date('2026-06-10T09:00:00.000Z');
  const rows = A.buildReport(
    [toolRow({ comboEnabled: 'true', primaryType: 'form', pwLen: 24 })],
    [asgRow({ endDate: '2026-01-01' }), asgRow({ status: 'expired' })], now);
  assert.strictEqual(rows[0].AFFECTED_BY_PATCH, true, 'still a config exposure');
  assert.strictEqual(rows[0].AFFECTS_ACTIVE_CUSTOMERS, false, 'but no live customer');
  assert.strictEqual(rows[0].activeAssignments, 0);
});

test('VERDICT: a unified form tool with an encrypted payload is affected', () => {
  const r = A.buildReport([toolRow({ unifiedType: 'form', payloadLen: 120, comboEnabled: 'false' })], [asgRow()], new Date())[0];
  assert.strictEqual(r.AFFECTED_BY_PATCH, true);
  assert.strictEqual(r.unifiedFormPayload, 'present(encrypted)');
});

test('VERDICT: an inactive tool contributes no active customers', () => {
  const r = A.buildReport([toolRow({ status: 'disabled', comboEnabled: 'true', primaryType: 'form', pwLen: 24 })], [asgRow()], new Date())[0];
  assert.strictEqual(r.activeAssignments, 0);
  assert.strictEqual(r.AFFECTS_ACTIVE_CUSTOMERS, false);
});

test('VERDICT: comboEnabled only counts when genuinely true (fail closed)', () => {
  for (const v of ['false', '0', 0, null, 'yes', {}]) {
    const r = A.buildReport([toolRow({ comboEnabled: v, primaryType: 'form', pwLen: 24 })], [], new Date())[0];
    assert.strictEqual(r.comboEnabled, false, 'comboEnabled=' + String(v));
    assert.strictEqual(r.AFFECTED_BY_PATCH, false, 'a disabled combo config is not an active dependency');
    assert.strictEqual(r.WAS_EXPOSED, true, 'but the credential was still retrievable - rotate');
  }
});

// ── fail closed ──────────────────────────────────────────────────────────────
test('FAIL CLOSED: a truncated tools read aborts with no verdict', async () => {
  const conn = mockConn({ tools: [toolRow()], asgs: [], toolCountSkew: 5 });
  await assert.rejects(() => A.runAudit(conn, new Date()), /incomplete tools read: 1 of 6/);
});

test('FAIL CLOSED: a truncated assignments read aborts', async () => {
  const conn = mockConn({ tools: [toolRow()], asgs: [asgRow()], asgCountSkew: 3 });
  await assert.rejects(() => A.runAudit(conn, new Date()), /incomplete assignments read/);
});

test('FAIL CLOSED: a query error propagates rather than reporting success', async () => {
  const conn = mockConn({ tools: [], asgs: [], toolsThrow: true });
  await assert.rejects(() => A.runAudit(conn, new Date()), /projection exploded/);
});

test('FAIL CLOSED: a missing count probe aborts', async () => {
  const conn = mockConn({ tools: [], asgs: [], badCounts: true });
  await assert.rejects(() => A.runAudit(conn, new Date()), /count probe returned no usable row/);
});

test('FAIL CLOSED: a non-array result set aborts', async () => {
  const conn = mockConn({ tools: [], asgs: [], toolsNotArray: true });
  await assert.rejects(() => A.runAudit(conn, new Date()), /did not return row arrays/);
});

test('FAIL CLOSED: an unexpected schema (missing projected column) aborts', async () => {
  const conn = mockConn({ tools: [{ name: 'x' }], asgs: [] });
  await assert.rejects(() => A.runAudit(conn, new Date()), /unexpected schema: missing projected column/);
});

test('FAIL CLOSED: the main() error path says NOT COMPATIBLE and exits non-zero', () => {
  assert.ok(/AUDIT FAILED \(no verdict produced\)/.test(SRC));
  assert.ok(/Treat this as NOT COMPATIBLE until a clean run succeeds/.test(SRC));
  assert.ok(/process\.exit\(2\)/.test(SRC));
});

test('the script refuses to run without the explicit flag', () => {
  assert.ok(/AUDIT_FORM_COMBO !== '1'/.test(SRC), 'must require deliberate invocation');
  assert.ok(/if \(require\.main === module\) main\(\)/.test(SRC), 'must be importable without running');
});

test('no duplicate helper definitions or dead legacy code remains', () => {
  for (const fn of ['function effectiveEndBoundary', 'function buildReport', 'async function runAudit', 'function printReport']) {
    assert.strictEqual(SRC.split(fn).length - 1, 1, 'duplicate definition of ' + fn);
  }
  assert.ok(!/mask\(/.test(SRC.replace(/maskFromParts/g, '')), 'the superseded mask() helper must be gone');
});

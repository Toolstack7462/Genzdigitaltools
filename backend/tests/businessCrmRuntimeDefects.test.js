'use strict';

/**
 * Regression tests for two CRM runtime defects observed in production.
 *
 * DEFECT 1 — dashboard 500 (collation).
 *   Live log: "Illegal mix of collations (utf8mb4_unicode_ci,COERCIBLE) and
 *   (utf8mb4_general_ci,COERCIBLE) for operation '='" at routes/dashboard.js.
 *   `DATE_FORMAT(col,'%Y-%m') = :month` compares two COERCIBLE operands: the '%Y-%m' literal is
 *   tagged with the client character set's default collation (utf8mb4_general_ci) while the bound
 *   parameter is coerced to the session/database collation (utf8mb4_unicode_ci). Neither outranks
 *   the other, so MariaDB refuses. `currency_code=:currency` survives only because a COLUMN
 *   outranks a literal. Both forms were executed against the production database through the app's
 *   own driver: the DATE_FORMAT form failed with that error, the range form returned rows.
 *   Fix: half-open DATE range bounds, which involve no collation and stay sargable.
 *
 * DEFECT 2 — reports 400 (decimal precision).
 *   AVG() widens DECIMAL(18,2) to DECIMAL(22,6); with decimalNumbers:false the driver returns a
 *   six-decimal STRING, and money.toMinor accepts at most two decimals by design, so the route
 *   threw INVALID_MONEY. Verified against production data: AVG returned "0.000000".
 *   Fix: ROUND(...,2) at the SQL boundary; money.js stays strict.
 *
 * These are structural/pure tests: they need no database, matching how the rest of this suite runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'business-crm');
const money = require('../modules/business-crm/money');

/** Strip SQL and JS comments so the scanners never match their own explanatory prose. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function crmSourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.js')) out.push(absolute);
    }
  })(MODULE_DIR);
  return out;
}

// ── Defect 1: no collation-fragile comparison may return ─────────────────────

test('no CRM query compares a formatted date string to a bound parameter', () => {
  const offenders = [];
  for (const file of crmSourceFiles()) {
    const source = code(file);
    // The exact shape that broke production: a string-returning date function compared to a param.
    const re = /(DATE_FORMAT|DATE|CONCAT|LEFT|SUBSTRING)\s*\([^)]*\)\s*=\s*:/gi;
    let match;
    while ((match = re.exec(source)) !== null) {
      offenders.push(`${path.relative(MODULE_DIR, file).replace(/\\/g, '/')} :: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `collation-fragile comparison reintroduced: ${offenders.join(', ')}`);
});

test('the dashboard scopes its month with half-open DATE bounds', () => {
  const source = code(path.join(MODULE_DIR, 'routes', 'dashboard.js'));
  assert.equal(/DATE_FORMAT/i.test(source), false, 'dashboard must not use DATE_FORMAT for month scoping');
  // Every month-scoped table must use the bounds pair.
  for (const column of ['sale_date', 'payment_date', 'expense_date']) {
    assert.ok(
      new RegExp(`${column}\\s*>=\\s*:monthStart`).test(source),
      `${column} must be lower-bounded by :monthStart`,
    );
  }
  assert.equal((source.match(/:nextMonthStart/g) || []).length >= 4, true, 'all four month queries must be upper-bounded');
});

test('every named placeholder in the dashboard has a matching parameter', () => {
  // A renamed placeholder without its parameter is how this fix could silently break: mysql2 throws
  // at execute() time, which would be another 500.
  const source = code(path.join(MODULE_DIR, 'routes', 'dashboard.js'));
  const calls = [...source.matchAll(/db\.query\(\s*`([\s\S]*?)`\s*,\s*\{([^}]*)\}\s*\)/g)];
  assert.ok(calls.length >= 8, `expected the dashboard fan-out, found ${calls.length} parameterised queries`);
  const problems = [];
  for (const [, sql, paramText] of calls) {
    const placeholders = [...new Set([...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))];
    const supplied = paramText.split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
    for (const name of placeholders) {
      if (!supplied.includes(name)) problems.push(`:${name} missing from { ${paramText.trim()} }`);
    }
  }
  assert.deepEqual(problems, [], `unbound placeholders would throw at execute(): ${problems.join('; ')}`);
});

// ── Defect 2: monetary precision at the SQL boundary ─────────────────────────

test('money.toMinor still refuses more than two decimals', () => {
  // The fix must NOT have loosened validation — that is the whole point of rounding in SQL.
  assert.throws(() => money.normalize('1250.000000'), (error) => error.code === 'INVALID_MONEY' && error.status === 400);
  assert.throws(() => money.normalize('833.333333'), (error) => error.code === 'INVALID_MONEY');
  assert.throws(() => money.normalize('1.005'), (error) => error.code === 'INVALID_MONEY');
  assert.equal(money.normalize('1250.00'), '1250.00');
  assert.equal(money.normalize('0'), '0.00');
});

test('every AVG() in the CRM module is rounded to two decimals', () => {
  const offenders = [];
  for (const file of crmSourceFiles()) {
    const source = code(file);
    const avgUses = [...source.matchAll(/AVG\s*\(/gi)];
    if (!avgUses.length) continue;
    // Each AVG must sit inside a ROUND(..., 2).
    const rounded = [...source.matchAll(/ROUND\s*\(\s*AVG\s*\([^)]*\)\s*,\s*2\s*\)/gi)];
    if (rounded.length !== avgUses.length) {
      offenders.push(`${path.relative(MODULE_DIR, file).replace(/\\/g, '/')}: ${avgUses.length} AVG(), ${rounded.length} rounded`);
    }
  }
  assert.deepEqual(offenders, [], `unrounded AVG() would throw INVALID_MONEY on real data: ${offenders.join(', ')}`);
});

test('the reports average_invoice survives MySQL-style AVG output once rounded', () => {
  // Simulates the exact production values: raw AVG is rejected, the rounded column is accepted.
  const rawFromMysql = '1250.000000';
  assert.throws(() => money.normalize(rawFromMysql), (error) => error.code === 'INVALID_MONEY');
  // ROUND(AVG(x),2) yields DECIMAL(x,2) which the driver renders with exactly two decimals.
  for (const rounded of ['1250.00', '0.00', '833.33', '12345678.99']) {
    assert.equal(money.normalize(rounded), rounded);
  }
});

test('currency handling is unchanged for all three supported ledgers', () => {
  for (const currency of ['PKR', 'INR', 'NGN']) {
    assert.equal(money.assertCurrency(currency), currency);
    assert.equal(money.assertCurrency(currency.toLowerCase()), currency);
  }
  assert.throws(() => money.assertCurrency('USD'), (error) => error.code === 'UNSUPPORTED_CURRENCY');
  assert.throws(() => money.assertCurrency(''), (error) => error.code === 'UNSUPPORTED_CURRENCY');
});

// ── Month-bounds arithmetic ──────────────────────────────────────────────────

test('month bounds are correct, including the December rollover', () => {
  // Mirrors the computation in routes/dashboard.js.
  const bounds = (month) => {
    const [year, monthNumber] = month.split('-').map(Number);
    return {
      monthStart: `${month}-01`,
      nextMonthStart: new Date(Date.UTC(monthNumber === 12 ? year + 1 : year, monthNumber === 12 ? 0 : monthNumber, 1))
        .toISOString().slice(0, 10),
    };
  };
  assert.deepEqual(bounds('2026-08'), { monthStart: '2026-08-01', nextMonthStart: '2026-09-01' });
  assert.deepEqual(bounds('2026-12'), { monthStart: '2026-12-01', nextMonthStart: '2027-01-01' });
  assert.deepEqual(bounds('2026-01'), { monthStart: '2026-01-01', nextMonthStart: '2026-02-01' });
  // February in a leap year — the range is half-open so the month length never matters.
  assert.deepEqual(bounds('2028-02'), { monthStart: '2028-02-01', nextMonthStart: '2028-03-01' });
});

test('permission-gated fields remain gated in the dashboard response', () => {
  // Redaction must not have been disturbed by the query change.
  const source = code(path.join(MODULE_DIR, 'routes', 'dashboard.js'));
  assert.ok(/profitVisible/.test(source), 'profit gating must remain');
  assert.ok(/vendorVisible/.test(source), 'vendor gating must remain');
  assert.ok(/expenseVisible/.test(source), 'expense gating must remain');
  assert.ok(/auditVisible \? activities : \[\]/.test(source), 'audit activities must stay gated');
});

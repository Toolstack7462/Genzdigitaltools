'use strict';

/**
 * Guards for CRM search behaviour.
 *
 * These are structural/pure tests: they need no database, matching how the rest of this suite runs.
 * Each one encodes a defect that was actually present before this change, or an invariant whose
 * violation would be a silent security or correctness regression rather than a visible failure.
 *
 * 1. LIKE injection of wildcards. Four `q` filters interpolated the operator's text straight into a
 *    `%...%` pattern, so typing a single "%" matched every row in the module and "_" matched any
 *    character. `safeLike()` already existed in http.js and was used by exactly one route.
 *
 * 2. Permission-gated global search. Every source in routes/search.js must sit behind the same
 *    permission that guards the owning module's list endpoint, or global search becomes a way to
 *    read a module the operator cannot open.
 *
 * 3. STAFF task scope. routes/operations.js restricts a STAFF operator to their own tasks. Global
 *    search queries the same table and has to repeat that restriction.
 *
 * 4. Cashbook filter order. The vendors.view filter must be applied before the free-text search, and
 *    the running balance must be accumulated before either, so searching cannot both reveal a vendor
 *    payment and cannot silently change the balance column into a subtotal of the matched rows.
 *
 * 5. Phantom placeholders. mysql2's named-placeholder tokenizer does not skip SQL comments, so a
 *    colon inside a `--` comment in a query template becomes an undefined bind parameter. This has
 *    already caused one production 500.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'business-crm');
const ROUTES_DIR = path.join(MODULE_DIR, 'routes');
const SERVICES_DIR = path.join(MODULE_DIR, 'services');

/** Strip SQL and JS comments so the scanners never match their own explanatory prose. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function filesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.js')).map((name) => path.join(dir, name));
}

const SQL_FILES = [...filesIn(ROUTES_DIR), ...filesIn(SERVICES_DIR)];

test('no LIKE parameter interpolates operator text without escaping wildcards', () => {
  const offenders = [];
  for (const file of SQL_FILES) {
    const source = code(file);
    // Matches `params.q = `%${...}%`` and any other assignment building a LIKE pattern inline.
    const re = /(\w+(?:\.\w+)*)\s*=\s*`%\$\{([^}]*)\}%`/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      // An inline replace of backslash, percent and underscore is equivalent to safeLike().
      if (/replace\([^)]*\\\\%_/.test(match[2]) || /replace\(\/\[\\\\%_\]/.test(match[2])) continue;
      offenders.push(`${path.basename(file)} :: ${match[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], 'build LIKE patterns with safeLike() so "%" and "_" are literal');
});

test('safeLike escapes every LIKE metacharacter and the escape character itself', () => {
  const { safeLike } = require('../modules/business-crm/http');
  assert.equal(safeLike('100%'), '%100\\%%');
  assert.equal(safeLike('a_b'), '%a\\_b%');
  assert.equal(safeLike('back\\slash'), '%back\\\\slash%');
  // A bare wildcard must not become a match-everything pattern.
  assert.equal(safeLike('%'), '%\\%%');
  assert.equal(safeLike(''), '%%');
  // The input is length-capped, so a huge string cannot be used to build a pathological pattern.
  assert.ok(safeLike('x'.repeat(500)).length <= 182);
});

test('every global search source is gated on a permission', () => {
  const source = code(path.join(ROUTES_DIR, 'search.js'));
  // Each source is either an add('type', 'permission', ...) call or an explicit `has(req, ...)` block.
  const added = [...source.matchAll(/add\(\s*'([a-z-]+)'\s*,\s*'([a-z.-]+)'/g)].map((m) => [m[1], m[2]]);
  const types = added.map(([type]) => type);
  for (const expected of ['sale', 'client', 'vendor', 'product', 'task', 'access', 'expiry']) {
    assert.ok(types.includes(expected), `global search is missing the ${expected} source`);
  }
  const expectedPermission = {
    sale: 'sales.view', client: 'clients.view', vendor: 'vendors.view', product: 'products.view',
    task: 'tasks.view', access: 'website-access.view', expiry: 'expiries.view',
  };
  for (const [type, permission] of added) {
    assert.equal(permission, expectedPermission[type], `${type} results must require ${expectedPermission[type]}`);
  }
  // `add` must actually enforce the permission it is handed.
  assert.match(source, /const add = \([^)]*\) => \{\s*if \(!has\(req, permission\)\) return;/);
  // Payments are handled separately because the two party legs need different permissions.
  assert.match(source, /if \(has\(req, 'clients\.view'\)\) paymentParties\.push\("'client'"\)/);
  assert.match(source, /if \(has\(req, 'vendors\.view'\)\) paymentParties\.push\("'vendor'"\)/);
  assert.match(source, /if \(paymentParties\.length/, 'payment search must be skipped when neither party is visible');
});

test('global search repeats the STAFF task scope', () => {
  const source = code(path.join(ROUTES_DIR, 'search.js'));
  assert.match(source, /staffScoped\s*=\s*req\.businessAccess\?\.role === 'STAFF'/);
  assert.match(source, /assigned_user_id=:scopeActor OR created_by=:scopeActor/);
  // The scope parameter must only be bound when the clause is present, or mysql2 rejects the query.
  assert.match(source, /staffScoped \? \{ scopeActor: actor\(req\) \} : \{\}/);
});

test('global search requires two characters before it queries anything', () => {
  const source = code(path.join(ROUTES_DIR, 'search.js'));
  assert.match(source, /if \(text\.length < 2\) return res\.json/);
});

test('cashbook applies the vendor permission filter before any search filter', () => {
  const source = code(path.join(ROUTES_DIR, 'reports.js'));
  const permitted = source.indexOf("has(req, 'vendors.view') ? rows : rows.filter");
  const balance = source.indexOf('running_balance');
  const typed = source.indexOf('entryType ? chronological.filter');
  const searched = source.indexOf('cashSearch');
  assert.ok(permitted > -1 && balance > -1 && typed > -1 && searched > -1, 'cashbook pipeline stages not found');
  assert.ok(permitted < balance, 'vendor rows must be removed before the balance is accumulated');
  assert.ok(balance < typed, 'the running balance must cover the whole range, not just matched rows');
  // The vendor filter must never be reachable only through the search branch.
  assert.ok(source.indexOf('const visibleRows') < typed, 'permission filter must precede display filtering');
});

test('expiries and outstanding ledgers are bounded by a page size', () => {
  const expiries = code(path.join(ROUTES_DIR, 'reports.js'));
  assert.match(expiries, /LIMIT :limit OFFSET :offset/, 'expiries must be paginated');
  assert.match(expiries, /pageParams\(req\.query\)/);
  const payments = code(path.join(SERVICES_DIR, 'paymentService.js'));
  assert.match(payments, /LIMIT :limit OFFSET :offset/, 'outstanding ledger must be paginated');
  // The aggregate has to be a SQL SUM over the filtered set, not a sum of the returned page.
  assert.match(payments, /COALESCE\(SUM\(s\.\$\{totalColumn\}-s\.\$\{paidColumn\}\),0\) pending_total/);
});

test('tasks search hides the vendor field from operators without vendors.view', () => {
  const source = code(path.join(ROUTES_DIR, 'operations.js'));
  assert.match(source, /if \(has\(req, 'vendors\.view'\)\) fields\.push\('v\.name LIKE :search'\)/);
  // The redaction of the response itself must remain.
  assert.match(source, /delete output\.vendor_name/);
});

test('website access search covers every column the operator can see', () => {
  const source = code(path.join(SERVICES_DIR, 'websiteAccessService.js'));
  for (const column of ['client_name', 'client_email', 'client_phone', 'tool_name', 'source_type', 'external_key']) {
    assert.match(source, new RegExp(`${column} LIKE :search`), `website access search is missing ${column}`);
  }
});

test('no colon appears inside a SQL comment in any query template', () => {
  const offenders = [];
  for (const file of SQL_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    for (const literal of source.matchAll(/`[^`]*`/g)) {
      for (const line of literal[0].split('\n')) {
        const comment = line.indexOf('--');
        if (comment >= 0 && /:[A-Za-z_]/.test(line.slice(comment))) {
          offenders.push(`${path.basename(file)} :: ${line.trim().slice(0, 70)}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'mysql2 turns a colon in a SQL comment into an undefined bind parameter');
});

test('search parameters are always bound, never concatenated into SQL', () => {
  const offenders = [];
  for (const file of SQL_FILES) {
    const source = code(file);
    for (const literal of source.matchAll(/`[^`]*`/g)) {
      const sql = literal[0];
      if (!/\bLIKE\b/.test(sql)) continue;
      // A LIKE must compare against a placeholder, never against an interpolated expression.
      for (const like of sql.matchAll(/LIKE\s+(\S+)/g)) {
        if (!like[1].startsWith(':')) offenders.push(`${path.basename(file)} :: LIKE ${like[1].slice(0, 40)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'every LIKE must compare against a named placeholder');
});

'use strict';

/**
 * Business CRM isolation guarantees.
 *
 * These are structural tests, not behavioural ones. They exist so a future edit cannot quietly
 * turn the CRM from an additive financial module into something that writes the website access
 * system, or push financial controls onto the existing Give Access screens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');
const MODULE_DIR = path.join(BACKEND, 'modules', 'business-crm');
const BRIDGE = path.join(MODULE_DIR, 'services', 'websiteAccessService.js');

function walk(dir, filter = () => true) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute, filter));
    else if (entry.isFile() && filter(absolute)) out.push(absolute);
  }
  return out;
}

const WEBSITE_MODELS = ['ToolAssignment', 'ProxyClient', 'StealthClient', 'ProxyLease', 'StealthLease'];

/**
 * Tables a source file writes to. `ON DUPLICATE KEY UPDATE <column>` is stripped first — otherwise
 * the upsert column reads as a table name and the check reports false positives.
 */
function writtenTables(source) {
  const sql = source.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/gi, ' ');
  return [...sql.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((match) => match[1]);
}

test('only the bridge service may reach the website access models', () => {
  const offenders = [];
  for (const file of walk(MODULE_DIR, (f) => f.endsWith('.js'))) {
    if (path.resolve(file) === path.resolve(BRIDGE)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const model of WEBSITE_MODELS) {
      if (new RegExp(`require\\([^)]*models/${model}['"]`).test(source)) {
        offenders.push(`${path.relative(REPO, file)} → ${model}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Business CRM files must not import website access models directly: ${offenders.join(', ')}`);
});

test('the bridge service never writes a website record', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8');
  // Any mutation against the website models would have to go through one of these adapter calls.
  const writeCalls = [
    /ToolAssignment\s*\.\s*(create|insertMany|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findByIdAndUpdate)\s*\(/,
    /User\s*\.\s*(create|insertMany|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findByIdAndUpdate)\s*\(/,
    /\.save\s*\(\s*\)/,
  ];
  for (const pattern of writeCalls) {
    assert.equal(pattern.test(source), false, `websiteAccessService.js must stay read-only against website data (matched ${pattern})`);
  }
});

test('the bridge only ever writes namespaced biz_crm_ tables', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8');
  const targets = writtenTables(source);
  assert.ok(targets.length > 0, 'expected the bridge to contain SQL writes');
  const foreign = targets.filter((table) => !table.startsWith('biz_crm_'));
  assert.deepEqual(foreign, [], `Business CRM must only write biz_crm_* tables, found: ${foreign.join(', ')}`);
});

test('the CRM schema is additive and namespaced', () => {
  const sql = fs.readFileSync(path.join(MODULE_DIR, 'schema.sql'), 'utf8');
  assert.equal(/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(sql), false, 'schema.sql must never DROP');
  assert.equal(/\bTRUNCATE\b/i.test(sql), false, 'schema.sql must never TRUNCATE');
  assert.equal(/\bRENAME\s+TABLE\b/i.test(sql), false, 'schema.sql must never RENAME');

  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
  assert.ok(created.includes('biz_crm_access_links'), 'the access-link table must exist');
  const foreign = created.filter((table) => !table.startsWith('biz_crm_'));
  assert.deepEqual(foreign, [], `every CRM table must be biz_crm_* namespaced, found: ${foreign.join(', ')}`);

  // Every CREATE TABLE in this file must be guarded, so the migration is safe to run repeatedly.
  const allCreates = [...sql.matchAll(/CREATE TABLE\s+(IF NOT EXISTS\s+)?/gi)];
  assert.equal(allCreates.every((match) => Boolean(match[1])), true, 'every CREATE TABLE must use IF NOT EXISTS');

  // Any ALTER must target a CRM table — never an existing application table.
  const altered = [...sql.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
  assert.deepEqual(altered.filter((t) => !t.startsWith('biz_crm_')), [], 'ALTER may only target biz_crm_* tables');
});

test('db.js compatibility ALTERs only touch biz_crm_ tables', () => {
  const source = fs.readFileSync(path.join(MODULE_DIR, 'db.js'), 'utf8');
  const altered = [...source.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
  assert.ok(altered.length > 0, 'expected compatibility ALTERs to exist');
  assert.deepEqual(altered.filter((t) => !t.startsWith('biz_crm_')), [], 'compatibility ALTERs may only target biz_crm_* tables');
});

test('the existing access workflow carries no CRM financial controls', () => {
  // The product decision: financial fields live ONLY inside /admin/business. If any of these
  // strings ever appear on an access screen, the separation has been broken.
  const guarded = [
    'frontend/src/pages/admin/AdminAssignments.js',
    'frontend/src/pages/admin/AdminBulkAssign.js',
    'frontend/src/pages/admin/AdminProxyTools.js',
    'frontend/src/pages/admin/AdminStealthWriter.js',
    'frontend/src/pages/admin/AdminRenewals.js',
    'backend/routes/admin/assignments.js',
  ];
  const banned = [/Add to Business CRM/i, /\bSale Price\b/, /\bPurchase Cost\b/, /\bAmount Received\b/, /businessCrm/i, /biz_crm_/];
  for (const relative of guarded) {
    const file = path.join(REPO, relative);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.equal(pattern.test(source), false, `${relative} must not carry CRM financial controls (matched ${pattern})`);
    }
  }
});

test('the CRM never exposes provider credentials from proxy or stealth sources', () => {
  const service = require(BRIDGE);
  const snapshot = service.snapshot({
    sourceType: 'PROXY',
    externalKey: 'proxy:hix:u1',
    toolName: 'HIX AI',
    accessStatus: 'ACTIVE',
    // Anything sensitive that might ride along on a source row must be dropped by the snapshot.
    credentialEmail: 'leak@example.com',
    password: 'hunter2',
    cookies: 'session=abc',
    vaultKey: 'deadbeef',
  });
  for (const key of ['credentialEmail', 'password', 'cookies', 'vaultKey']) {
    assert.equal(key in snapshot, false, `snapshot must not carry ${key}`);
  }
});

test('access status derivation matches the website expiry rule', () => {
  const service = require(BRIDGE);
  assert.equal(service.coreAccessStatus({ status: 'revoked' }), 'REVOKED');
  assert.equal(service.coreAccessStatus({ status: 'expired' }), 'EXPIRED');
  assert.equal(service.coreAccessStatus({ status: 'active', endDate: null }), 'ACTIVE');
  // A date-only endDate is inclusive to end-of-day, so "today" is still active, not expired.
  const todayOnly = new Date().toISOString().slice(0, 10);
  assert.notEqual(service.coreAccessStatus({ status: 'active', endDate: todayOnly }), 'EXPIRED');
  // Far past is expired regardless of the stored status.
  assert.equal(service.coreAccessStatus({ status: 'active', endDate: '2001-01-01' }), 'EXPIRED');
  assert.equal(service.daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(service.daysBetween(null, '2026-01-31'), null);
  assert.equal(service.coreAccessMode({ extensionSettings: { directOpenEnabled: true, requirePermission: false } }), 'direct');
  assert.equal(service.coreAccessMode({ extensionSettings: { directOpenEnabled: true, requirePermission: true } }), 'extension');
  assert.equal(service.coreAccessMode(null), 'extension');
});

test('manual sales cannot create website access entitlements', () => {
  const salesService = fs.readFileSync(path.join(MODULE_DIR, 'services', 'salesService.js'), 'utf8');
  for (const model of WEBSITE_MODELS) {
    assert.equal(salesService.includes(`models/${model}`), false, `salesService must not touch ${model}`);
  }
  const writes = writtenTables(salesService);
  assert.deepEqual(writes.filter((t) => !t.startsWith('biz_crm_')), [], 'salesService may only write biz_crm_* tables');
});

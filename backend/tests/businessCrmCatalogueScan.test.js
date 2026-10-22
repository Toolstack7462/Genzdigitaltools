'use strict';
/**
 * The catalogue source SCAN, in isolation.
 *
 * This is the half of the feature that needs no database: how Tool definitions are read, paginated
 * and projected, and - the part that actually matters - when a scan may call itself COMPLETE.
 * Everything downstream hangs off that flag: only a complete scan is allowed to conclude that a
 * source has disappeared, so a bug here would let a timeout look like a deletion.
 *
 * The database half (transactions, uniqueness under concurrency, readiness enforcement in the real
 * sale path) is scripts/crm-catalogue-db-selftest.js against a restricted scratch schema - those
 * are engine guarantees and a mock cannot stand in for them.
 *
 * Only the Tool model is stubbed, injected before the service loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');

let ROWS = [];
let FAIL_READ = false;
let COUNT_OVERRIDE = null;
const WRITES = [];

function query(rows) {
  const state = { skip: 0, limit: 0 };
  const q = {
    select() { return q; }, sort() { return q; },
    skip(n) { state.skip = Number(n || 0); return q; },
    limit(n) { state.limit = Number(n || 0); return q; },
    lean: async () => {
      if (FAIL_READ) throw new Error('tool_source_unreachable');
      const sorted = rows.slice().sort((a, b) => String(a._id).localeCompare(String(b._id)));
      return sorted.slice(state.skip, state.limit ? state.skip + state.limit : undefined);
    },
  };
  return q;
}

const toolPath = require.resolve(path.join(BACKEND, 'models', 'Tool'));
require.cache[toolPath] = {
  id: toolPath, filename: toolPath, loaded: true,
  exports: {
    find: () => query(ROWS.filter((r) => r.status === 'active')),
    countDocuments: async () => {
      if (FAIL_READ) throw new Error('tool_source_unreachable');
      return COUNT_OVERRIDE != null ? COUNT_OVERRIDE : ROWS.filter((r) => r.status === 'active').length;
    },
    create: async (...a) => { WRITES.push(['create', a]); },
    updateOne: async (...a) => { WRITES.push(['updateOne', a]); },
    deleteOne: async (...a) => { WRITES.push(['deleteOne', a]); },
  },
};

const catalogue = require(path.join(BACKEND, 'modules', 'business-crm', 'services', 'productCatalogueService'));

const tool = (id, over = {}) => Object.assign({
  _id: id, name: `Tool ${id}`, category: 'Writing', domain: `${id}.example`, status: 'active',
}, over);

test('a small inventory is read completely', async () => {
  ROWS = [tool('a'), tool('b'), tool('c')];
  FAIL_READ = false; COUNT_OVERRIDE = null;
  const r = await catalogue.discoverWebsiteTools();
  assert.equal(r.complete, true);
  assert.equal(r.sources.length, 3);
  assert.equal(r.sources[0].namespace, catalogue.NAMESPACE_WEBSITE_TOOL);
});

test('every page is fetched — the scan does not stop at the first page', async () => {
  // 450 crosses the internal page size several times. A reader that stopped at one page would
  // silently under-report the inventory, and under-reporting is what makes a source look deleted.
  ROWS = []; for (let i = 0; i < 450; i += 1) ROWS.push(tool(`p${String(i).padStart(4, '0')}`));
  const r = await catalogue.discoverWebsiteTools();
  assert.equal(r.complete, true);
  assert.equal(r.sources.length, 450);
  assert.equal(new Set(r.sources.map((s) => s.sourceId)).size, 450, 'no duplicates across pages');
});

test('inactive Tools are not imported', async () => {
  ROWS = [tool('live'), tool('gone', { status: 'disabled' })];
  const r = await catalogue.discoverWebsiteTools();
  assert.deepEqual(r.sources.map((s) => s.sourceId), ['live']);
});

test('a FAILED read is never a complete scan', async () => {
  ROWS = [tool('a'), tool('b')];
  FAIL_READ = true;
  const r = await catalogue.discoverWebsiteTools();
  FAIL_READ = false;
  assert.equal(r.complete, false, 'a thrown read must never report a complete inventory');
  assert.ok(r.error, 'and the error is reported rather than swallowed');
});

test('a short read against a larger count is not a complete scan', async () => {
  // The window moved under us: fewer rows came back than the source says exist. Treating that as
  // authoritative would mark the missing ones unavailable.
  ROWS = [tool('a'), tool('b')];
  COUNT_OVERRIDE = 5;
  const r = await catalogue.discoverWebsiteTools();
  COUNT_OVERRIDE = null;
  assert.equal(r.complete, false);
  assert.equal(r.sources.length, 2, 'what was read is still returned');
});

test('the projection carries only approved non-secret metadata', async () => {
  ROWS = [tool('x', {
    // Everything below is what a real Tool row also holds. None of it may come through.
    cookiesEncrypted: 'CIPHER', tokenEncrypted: 'CIPHER', localStorageEncrypted: 'CIPHER',
    sessionBundle: { cookiesEncrypted: 'CIPHER', version: 9 },
    credentials: { type: 'password', payloadEncrypted: 'CIPHER' },
    credentialVersion: 7, loginUrl: 'https://x.example/login',
  })];
  const r = await catalogue.discoverWebsiteTools();
  const projected = r.sources[0];
  assert.deepEqual(Object.keys(projected).sort(), ['category', 'domainHint', 'name', 'namespace', 'sourceId', 'status']);
  const serialized = JSON.stringify(projected);
  for (const secret of ['CIPHER', 'payloadEncrypted', 'sessionBundle', 'credentialVersion']) {
    assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
  }
});

test('identity is the immutable source id — never the name or the domain', async () => {
  // Two Tools sharing a brand AND a host still produce two distinct sources. Collapsing them would
  // silently merge two separately sellable products.
  ROWS = [tool('id-1', { name: 'Same Brand', domain: 'same.example' }), tool('id-2', { name: 'Same Brand', domain: 'same.example' })];
  const r = await catalogue.discoverWebsiteTools();
  assert.equal(r.sources.length, 2);
  assert.deepEqual(r.sources.map((s) => s.sourceId).sort(), ['id-1', 'id-2']);
});

test('a source rename does not change the identity', async () => {
  ROWS = [tool('stable', { name: 'Before' })];
  const a = await catalogue.discoverWebsiteTools();
  ROWS = [tool('stable', { name: 'After' })];
  const b = await catalogue.discoverWebsiteTools();
  assert.equal(a.sources[0].sourceId, b.sources[0].sourceId);
  assert.notEqual(a.sources[0].name, b.sources[0].name);
});

test('the other source families are reported as questions, not imported or excluded', async () => {
  const families = catalogue.unresolvedSourceFamilies();
  const names = families.map((f) => f.family).sort();
  assert.deepEqual(names, ['PROXY_REGISTRY', 'STEALTH']);
  for (const family of families) {
    assert.equal(family.imported, false, `${family.family} must not be imported by this release`);
    assert.ok(family.question && /\?$/.test(family.question), `${family.family} must be stated as an open question`);
  }
  // The proxy members come from the live registry rather than a hardcoded list, so a new proxy tool
  // cannot be silently forgotten.
  const proxy = families.find((f) => f.family === 'PROXY_REGISTRY');
  assert.ok(Array.isArray(proxy.members) && proxy.members.length > 0, 'proxy members should come from the registry');
});

test('readiness requires the fields the sale flow consumes, and not purchase cost', async () => {
  assert.ok(catalogue.REQUIRED_FOR_READY.includes('currency_code'));
  assert.ok(catalogue.REQUIRED_FOR_READY.includes('account_type'));
  assert.ok(catalogue.REQUIRED_FOR_READY.includes('default_sale_price'));
  // A role without profit.view cannot see cost; requiring it would make readiness unreachable.
  assert.equal(catalogue.REQUIRED_FOR_READY.includes('default_purchase_cost'), false);
});

test('reading the source never writes to it', async () => {
  ROWS = [tool('a'), tool('b')];
  await catalogue.discoverWebsiteTools();
  assert.deepEqual(WRITES, [], 'the Tool model must receive zero writes');
});

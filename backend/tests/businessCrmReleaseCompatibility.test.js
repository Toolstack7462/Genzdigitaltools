'use strict';

/**
 * RELEASE COMPATIBILITY MATRIX for the CRM contact-create contract.
 *
 * The reviewed frontend sends `idempotencyKey` on contact create so that a retry after a lost
 * response reconciles instead of creating a second contact. That protection depends on the
 * BACKEND schema accepting the field: validate() runs with stripUnknown:true, so an older schema
 * silently discards the key and the frontend's retry becomes a duplicate contact - with no error
 * anywhere to show for it.
 *
 * These tests pin the combinations that matter for release and rollback. They exercise the REAL
 * validation middleware; the database half (one row, one audit event, UNIQUE column, cross-actor
 * conflict) runs on a real engine in scripts/crm-db-selftest.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'business-crm');
const { validate } = require(path.join(MODULE_DIR, 'validation'));

/** Run a body through the real validation middleware exactly as the route does. */
function runValidation(schema, body) {
  return new Promise((resolve, reject) => {
    const req = { body };
    const res = { status: () => ({ json: (payload) => reject(Object.assign(new Error('refused'), { payload })) }) };
    validate(schema)(req, res, () => resolve(req.validated));
  });
}

// ── 1. OLD frontend (no key) + REVIEWED backend ───────────────────────────────────────────────
test('old frontend + new backend: a create WITHOUT a key still works', async () => {
  for (const schema of ['clientCreate', 'vendorCreate']) {
    const validated = await runValidation(schema, { name: 'Legacy Contact', whatsapp: '03001234567' });
    assert.equal(validated.name, 'Legacy Contact');
    assert.equal(validated.idempotencyKey, undefined, 'no key is invented for a caller that sent none');
    assert.equal(validated.status, 'active', 'existing defaults are unchanged');
  }
});

// ── 2. REVIEWED frontend (key) + REVIEWED backend ─────────────────────────────────────────────
test('new frontend + new backend: the key survives stripUnknown and reaches the service', async () => {
  for (const schema of ['clientCreate', 'vendorCreate']) {
    const key = 'contact-key-0123456789';
    const validated = await runValidation(schema, { name: 'Keyed Contact', idempotencyKey: key });
    assert.equal(validated.idempotencyKey, key);
  }
});

test('an over-long or wrongly typed key is refused rather than silently dropped', async () => {
  await assert.rejects(() => runValidation('clientCreate', { name: 'X', idempotencyKey: 'k'.repeat(129) }));
  await assert.rejects(() => runValidation('clientCreate', { name: 'X', idempotencyKey: 12345 }));
  // an explicitly empty/absent key is allowed: that is the old-frontend shape
  assert.equal((await runValidation('clientCreate', { name: 'X', idempotencyKey: '' })).idempotencyKey, '');
  assert.equal((await runValidation('clientCreate', { name: 'X', idempotencyKey: null })).idempotencyKey, null);
});

// ── 3. ROLLBACK SAFETY ────────────────────────────────────────────────────────────────────────
// A whole-backend rollback is NOT safe: it removes the schema declaration, so the new frontend's
// key is stripped again and its retry protection disappears without any visible failure. This
// test is the executable statement of that dependency.
test('the contact CREATE schemas declare the key - a rollback that removes it breaks retry safety', () => {
  const source = require('node:fs').readFileSync(path.join(MODULE_DIR, 'validation.js'), 'utf8');
  const createBlock = source.slice(source.indexOf('clientCreate:'), source.indexOf('productCreate:'));
  assert.match(createBlock, /clientCreate:[\s\S]*?idempotencyKey/, 'clientCreate must accept the key');
  assert.match(createBlock, /vendorCreate:[\s\S]*?idempotencyKey/, 'vendorCreate must accept the key');
});

test('contact UPDATE semantics are untouched: version-checked, never key-replayed', async () => {
  const validated = await runValidation('clientUpdate', { name: 'X', version: 3 });
  assert.equal(validated.version, 3);
  // a key sent to update is stripped - update is not an idempotency-keyed operation
  const withKey = await runValidation('clientUpdate', { name: 'X', version: 3, idempotencyKey: 'k-1' });
  assert.equal(withKey.idempotencyKey, undefined);
  await assert.rejects(() => runValidation('clientUpdate', { name: 'X' }), 'version stays required');
});

test('the audit allow-list and the contact key are independent commits, so neither forces the other out', () => {
  const admin = require('node:fs').readFileSync(path.join(MODULE_DIR, 'routes', 'admin.js'), 'utf8');
  // the security fix must survive any rollback that only reverts ordering or the key
  assert.ok(!/SELECT \* FROM biz_crm_audit_logs/.test(admin), 'the audit list must never return to SELECT *');
  assert.match(admin, /AUDIT_COLUMNS/, 'the explicit column contract must remain');
});

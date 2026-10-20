'use strict';
/**
 * THE EXTENSION RE-PAIR LOOP — a device-bound token nothing can validate.
 *
 * MEASURED IN PRODUCTION, 2026-10-20. One client's dashboard showed the extension as detected and
 * connected, and every Access click ended in "Could not open tool / Extension error". The server's
 * own sanitized diagnostic said what the UI could not:
 *
 *     [access:extension_token] {"stage":"extension_token","clientId":null,
 *                              "code":"extension_token_invalid",
 *                              "reason":"invalid_or_expired_token"}
 *
 * 175 of those in 10.7 minutes, and `extension_tokens` rows minted at ~1 every 1.5 s, each with
 * `lastUsedAt = null` and `isRevoked = true`. That combination is the signature: `verifyToken`
 * sets `lastUsedAt` only AFTER the device checks, so these tokens were revoked AT the device gate
 * without ever being used once.
 *
 * THE CAUSE. `POST /extension/auth/activate` attaches the extension's device hash to the client's
 * DeviceBinding only INSIDE `if (user.devicePolicy?.enabled)`, but it mints the token with
 * `deviceIdHash: extensionDeviceIdHash || dashboardDeviceIdHash || null` UNCONDITIONALLY. So for a
 * client whose device policy is OFF, the token is device-bound while no binding exists to validate
 * it against — `verifyToken` finds no DeviceBinding, revokes the brand-new token and returns null.
 * The extension re-activates, gets another doomed token, and loops. The affected client had NEVER
 * had a single successful `CREDENTIALS_FETCHED` or `TOOL_OPENED`, on any tool — so this is not a
 * WriteHuman fault at all, it only showed up on the card the operator happened to click.
 * 8 clients were in that state; the 446 with device policy ON were unaffected.
 *
 * Harness: the REAL models against the fake pool, same approach as retention.test.js, extended to
 * route by table because verifyToken reads users and device_bindings as well as extension_tokens.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const adapter = require('../db/mysqlAdapter');

const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString();

// Multi-table in-memory pool. Routes on the table name in the SQL; SELECT returns every row of
// that table (the model's own JS filtering does the rest), writes are recorded per table.
function fakeTables(tables) {
  const data = {};
  const writes = [];
  for (const [t, rows] of Object.entries(tables)) {
    data[t] = new Map(rows.map(r => [String(r._id), r]));
  }
  const tableOf = (sql) => Object.keys(data).find(t => sql.includes(`\`${t}\``) || sql.includes(` ${t} `)) || null;
  const pool = {
    query: async (sql, params = []) => {
      const t = tableOf(sql);
      const map = (t && data[t]) || new Map();
      if (/^\s*DELETE/i.test(sql)) {
        let n = 0; for (const id of params) if (map.delete(String(id))) n++;
        writes.push({ table: t, kind: 'delete', n });
        return [{ affectedRows: n }];
      }
      if (/^\s*(INSERT|UPDATE|REPLACE)/i.test(sql)) {
        // The adapter upserts the whole JSON document; capture it so a revoke is observable.
        const jsonParam = params.find(p => typeof p === 'string' && p.trim().startsWith('{'));
        let doc = null;
        try { doc = jsonParam ? JSON.parse(jsonParam) : null; } catch (_) { doc = null; }
        if (doc && doc._id) map.set(String(doc._id), doc);
        writes.push({ table: t, kind: 'write', doc });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('WHERE id IN')) return [params.filter(id => map.has(String(id))).map(id => ({ data: JSON.stringify(map.get(String(id))) }))];
      if (sql.includes('WHERE id = ?')) return [map.has(String(params[0])) ? [{ data: JSON.stringify(map.get(String(params[0]))) }] : []];
      return [[...map.values()].map(r => ({ data: JSON.stringify(r) }))];
    },
  };
  adapter.__test.setPool(pool);
  return { data, writes, revokesOf: (t) => writes.filter(w => w.table === t && w.kind === 'write' && w.doc && w.doc.isRevoked === true) };
}
const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };

const RAW = 'raw-extension-token-value-synthetic';
const CLIENT = 'client-syn-1';
const EXT_HASH = 'a'.repeat(64);     // the extension's own chrome.storage device id hash
const DASH_HASH = 'b'.repeat(64);    // the website device hash

function tokenRow(over) {
  const ExtensionToken = require('../models/ExtensionToken');
  return Object.assign({
    _id: 'tok-syn-1',
    clientId: CLIENT,
    tokenHash: ExtensionToken.hashToken(RAW),
    isRevoked: false,
    expiresAt: ahead(30),
    lastUsedAt: null,
  }, over);
}
const clientRow = () => ({ _id: CLIENT, email: 'syn@example.test', fullName: 'Syn', status: 'active', devicePolicy: { enabled: false } });

// =============================================================================================

test('a token with NO device hash verifies normally (device policy off, nothing to bind)', async () => {
  const t = fakeTables({ extension_tokens: [tokenRow({ deviceIdHash: null })], users: [clientRow()], device_bindings: [] });
  const ExtensionToken = fresh('../models/ExtensionToken');
  const res = await ExtensionToken.verifyToken(RAW, EXT_HASH);
  assert.ok(res, 'an unbound token must verify');
  assert.strictEqual(String(res.clientId), CLIENT);
  assert.strictEqual(t.revokesOf('extension_tokens').length, 0, 'nothing may be revoked');
});

test('REGRESSION: a device-bound token with no matching binding must NOT be revoked on first use', async () => {
  // This is the production loop. Access is still denied (fail closed) — but destroying the token
  // is what made the extension re-activate every 1.5s and mint thousands of doomed rows.
  const t = fakeTables({
    extension_tokens: [tokenRow({ deviceIdHash: EXT_HASH })],
    users: [clientRow()],
    device_bindings: [{ _id: 'bind-syn-1', clientId: CLIENT, deviceIdHash: 'c'.repeat(64), extensionDeviceIdHash: null }],
  });
  const ExtensionToken = fresh('../models/ExtensionToken');
  const res = await ExtensionToken.verifyToken(RAW, EXT_HASH);
  assert.strictEqual(res, null, 'access must still be denied — fail closed');
  assert.strictEqual(t.revokesOf('extension_tokens').length, 0,
    'a missing binding row is a server bookkeeping gap, not token theft: it must not revoke');
});

test('a genuine device-hash MISMATCH still revokes (theft response preserved)', async () => {
  const t = fakeTables({
    extension_tokens: [tokenRow({ deviceIdHash: EXT_HASH })],
    users: [clientRow()],
    device_bindings: [{ _id: 'bind-syn-1', clientId: CLIENT, deviceIdHash: EXT_HASH }],
  });
  const ExtensionToken = fresh('../models/ExtensionToken');
  const res = await ExtensionToken.verifyToken(RAW, 'd'.repeat(64));   // different device presenting it
  assert.strictEqual(res, null);
  assert.strictEqual(t.revokesOf('extension_tokens').length, 1,
    'a token presented from another device must still be revoked');
});

test('a missing device-hash header on a bound token still revokes', async () => {
  const t = fakeTables({
    extension_tokens: [tokenRow({ deviceIdHash: EXT_HASH })],
    users: [clientRow()],
    device_bindings: [{ _id: 'bind-syn-1', clientId: CLIENT, deviceIdHash: EXT_HASH }],
  });
  const ExtensionToken = fresh('../models/ExtensionToken');
  assert.strictEqual(await ExtensionToken.verifyToken(RAW, null), null);
  assert.strictEqual(t.revokesOf('extension_tokens').length, 1);
});

test('a bound token WITH its binding verifies and is not revoked', async () => {
  const t = fakeTables({
    extension_tokens: [tokenRow({ deviceIdHash: EXT_HASH })],
    users: [clientRow()],
    device_bindings: [{ _id: 'bind-syn-1', clientId: CLIENT, deviceIdHash: DASH_HASH, extensionDeviceIdHash: EXT_HASH }],
  });
  const ExtensionToken = fresh('../models/ExtensionToken');
  const res = await ExtensionToken.verifyToken(RAW, EXT_HASH);
  assert.ok(res, 'the extensionDeviceIdHash column must satisfy the binding lookup');
  assert.strictEqual(t.revokesOf('extension_tokens').length, 0);
});

test('an expired or already-revoked token verifies as null without further writes', async () => {
  let t = fakeTables({ extension_tokens: [tokenRow({ expiresAt: new Date(Date.now() - 1000).toISOString() })], users: [clientRow()], device_bindings: [] });
  let ExtensionToken = fresh('../models/ExtensionToken');
  assert.strictEqual(await ExtensionToken.verifyToken(RAW, EXT_HASH), null);
  assert.strictEqual(t.revokesOf('extension_tokens').length, 0);

  t = fakeTables({ extension_tokens: [tokenRow({ isRevoked: true })], users: [clientRow()], device_bindings: [] });
  ExtensionToken = fresh('../models/ExtensionToken');
  assert.strictEqual(await ExtensionToken.verifyToken(RAW, EXT_HASH), null);
});

// ---- the producer side: what activate() is allowed to bind ----------------------------------
// Source-level, because the route pulls in the whole admin surface; the behavioural half above
// covers the verifier. The pairing of the two is the contract that broke.
test('activate() must not device-bind a token when no binding backs it', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'extension', 'index.js'), 'utf8');
  const m = src.match(/const tokenDeviceIdHash = ([\s\S]{0,260}?);/);
  assert.ok(m, 'the activate handler must still compute tokenDeviceIdHash');
  assert.match(m[1], /bindableDeviceHash/,
    'a token may only be bound to a hash a DeviceBinding can validate; binding it unconditionally '
    + 'is what revoked every freshly minted token for a device-policy-off client');
  assert.match(src, /async function bindableDeviceHash/,
    'that invariant must live in ONE helper, not be re-derived per call site');
});

test('the password-login path must apply the same rule', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'extension', 'index.js'), 'utf8');
  // The /auth/login handler also mints a token from the raw header, and registers no binding at
  // all, so an unverified header hash there produced the same self-revoking token.
  const loginSlice = src.slice(0, src.indexOf("router.post('/auth/activate'"));
  assert.match(loginSlice, /const deviceIdHash = await bindableDeviceHash\(/,
    'the login path must resolve its token device hash through the same invariant');
  assert.ok(!/const deviceIdHash = req\.headers\['x-device-id-hash'\] \|\| null;/.test(loginSlice),
    'it must no longer bind an unverified header hash directly');
});

test('hashToken is stable, so a stored hash keeps matching its raw token', () => {
  const ExtensionToken = require('../models/ExtensionToken');
  assert.strictEqual(ExtensionToken.hashToken(RAW), ExtensionToken.hashToken(RAW));
  assert.strictEqual(ExtensionToken.hashToken(RAW), crypto.createHash('sha256').update(RAW).digest('hex'));
});

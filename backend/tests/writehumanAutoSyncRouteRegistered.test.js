'use strict';
/**
 * Guards route registration for the (now Tool-independent) extension auto-sync POLICY endpoint.
 * The policy endpoint must live on the MOUNTED proxy-tools admin router, and the deprecated
 * Tool-bound `/:id/auto-sync` must NOT exist on toolsEnhanced (it was removed when the binding
 * became a persistent, domain-resolved policy). Source-based to avoid importing the heavy router
 * (which schedules crons at import).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('policy endpoint is registered on the mounted proxy-tools router', () => {
  const src = read('routes/admin/proxyTools.js');
  assert.match(src, /router\.put\(\s*['"]\/:tool\/extension-autosync['"]/, 'PUT /:tool/extension-autosync must exist');
  assert.match(src, /router\.get\(\s*['"]\/:tool\/extension-autosync['"]/, 'GET /:tool/extension-autosync must exist');
  assert.match(src, /requireCsrf/, 'the PUT must be CSRF-guarded');
});

test('server-crm.js mounts proxyTools at /api/crm/admin/proxy-tools', () => {
  const src = read('server-crm.js');
  assert.match(src, /adminProxyToolsRoutes\s*=\s*require\(['"]\.\/routes\/admin\/proxyTools['"]\)/);
  assert.match(src, /app\.use\(\s*['"]\/api\/crm\/admin\/proxy-tools['"]/);
});

test('deprecated Tool-bound /:id/auto-sync route no longer exists on toolsEnhanced', () => {
  const src = read('routes/admin/toolsEnhanced.js');
  assert.ok(!/router\.(put|post|get)\([^)]*\/:id\/auto-sync/.test(src), 'toolsEnhanced must not register a Tool-bound auto-sync route');
});

test('Tool CRUD reconciles the domain policy (dynamic rebinding without polling)', () => {
  const src = read('routes/admin/toolsEnhanced.js');
  assert.match(src, /reconcilePolicyForDomain/, 'Tool create/update/delete must trigger a domain policy reconcile');
});

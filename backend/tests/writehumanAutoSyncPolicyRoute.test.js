'use strict';
/**
 * THE POLICY PUT REQUEST CONTRACT — exercised against the REAL handler.
 *
 * WHY THIS FILE EXISTS. `writehumanAutoSyncRouteRegistered.test.js` proves the route is mounted
 * and CSRF-guarded by reading the source; the engine suites prove what the engine does once a
 * policy exists. Neither covers what the endpoint does with a PARTIAL body, and that gap hid a
 * real defect: the handler computed
 *
 *     const enable = req.body.enabled === true;
 *     const mode   = req.body.mode === 'enforce' ? 'enforce' : 'observe';
 *
 * so ANY request that omitted those fields read as "disabled, observe". The panel needs to save a
 * Tool binding on its own, and doing that would silently have disabled the policy, dropped Enforce
 * back to Observe and reset `boundAt` — undoing an operator's approval as a side effect of picking
 * a Tool. Omitted fields are now preserved from the stored policy.
 *
 * WHAT IS REAL: `routes/admin/proxyTools.js` itself — the handler is pulled off the mounted router
 * and invoked. WHAT IS STUBBED: only the four models it persists through (injected into
 * require.cache before the router loads) plus the Express req/res pair. `requireAuth`/`requireCsrf`
 * are middleware layers on the same route and are asserted by the registration suite; this file is
 * about the body contract, the persisted result and the response.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

// Throwaway, in-process only. The router refuses to load without these and they are not secrets.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-not-a-secret-' + '0'.repeat(16);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-not-a-secret-' + '1'.repeat(16);
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || 'ab'.repeat(32);
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const BE = path.join(__dirname, '..');
const P = (rel) => require.resolve(path.join(BE, rel));

// ---- mutable fixture state the stubs read/write ---------------------------------------------
const state = {
  policy: null,
  tools: [],
  accounts: [{ _id: 'acct-syn-1', tool: 'writehuman', isPrimary: true, status: 'active' }],
  activity: [],
  reconciles: 0,
};

function setByPath(o, p, v) {
  const ks = String(p).split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; }
  x[ks[ks.length - 1]] = v;
}

function inject(rel, mod) { require.cache[P(rel)] = { id: P(rel), filename: P(rel), loaded: true, exports: mod }; }

inject('models/Tool', {
  find: async (q) => state.tools.filter(t => !q || !q.status || t.status === q.status),
  findById: async (id) => state.tools.find(t => String(t._id) === String(id)) || null,
  patchGuarded: async () => 1,
});
inject('models/proxy/ProxyAccount', { find: async () => state.accounts.slice() });
inject('models/proxy/ExtAutoSyncPolicy', {
  findOne: async (q) => (state.policy && state.policy.tool === q.tool
    && String(state.policy.accountId) === String(q.accountId)) ? state.policy : null,
  findById: async (id) => (state.policy && String(state.policy._id) === String(id)) ? state.policy : null,
  create: async (d) => { state.policy = Object.assign({ _id: 'pol-syn-1' }, d); return state.policy; },
  patchGuarded: async (id, setMap) => {
    if (!state.policy || String(state.policy._id) !== String(id)) return 0;
    for (const [k, v] of Object.entries(setMap || {})) setByPath(state.policy, k, v);
    return 1;
  },
  updateJsonPath: async (id, p, v) => { if (state.policy) setByPath(state.policy, p, v); return 1; },
});
inject('models/ActivityLog', { log: async (...a) => { state.activity.push(a); } });

// The engine is REAL, but a reconcile here would need a full verifier/provider path; this file is
// about the endpoint, so only the reconcile entry point is counted.
const engine = require(path.join(BE, 'utils', 'proxy', 'extensionCredentialSync.js'));
const realReconcile = engine.reconcileExtensionTool;
engine.reconcileExtensionTool = async () => { state.reconciles += 1; return { result: 'unchanged', code: 'stubbed' }; };

const router = require(path.join(BE, 'routes', 'admin', 'proxyTools.js'));

function handlerFor(method, routePath) {
  const layer = (router.stack || []).find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${routePath} must be registered`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;         // the final handler, after requireCsrf
}

const PUT = handlerFor('put', '/:tool/extension-autosync');

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// `getClientIp` reads the socket, so a bare object is not a usable Express request here.
const reqBase = (extra) => Object.assign({
  params: { tool: 'writehuman' }, proxyTool: 'writehuman', userId: 'admin-syn-1',
  headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, connection: { remoteAddress: '127.0.0.1' },
}, extra);

async function put(body) {
  const req = reqBase({ body });
  const res = fakeRes();
  await PUT(req, res, (e) => { throw e || new Error('next() called'); });
  return res;
}

const TOOL_A = 'tool-syn-selected';
const TOOL_B = 'tool-syn-independent';

function seed(policyOver) {
  state.tools = [
    { _id: TOOL_A, name: 'Selected Target', status: 'active', domain: 'writehuman.ai', targetUrl: 'https://writehuman.ai/', credentialVersion: 5 },
    { _id: TOOL_B, name: 'Independently Managed', status: 'active', domain: 'writehuman.ai', targetUrl: 'https://writehuman.ai/', credentialVersion: 9 },
  ];
  state.activity = [];
  state.reconciles = 0;
  state.policy = Object.assign({
    _id: 'pol-syn-1', tool: 'writehuman', accountId: 'acct-syn-1',
    enabled: true, mode: 'enforce', disabledExplicitly: false,
    officialDomain: 'writehuman.ai', approvedAccountKey: 'uid-syn-approved',
    approvedToolId: null, boundAt: new Date('2026-10-09T07:46:30.075Z'), policyEpoch: 1000,
    sync: { stage: 'synced', lastSyncAt: '2026-10-18T13:58:50.214Z', syncedToolId: TOOL_A },
  }, policyOver);
}

// =============================================================================================

test('a binding-only save preserves enabled, mode, account approval, boundAt and source history', async () => {
  seed();
  const before = state.policy.boundAt;
  const res = await put({ approvedToolId: TOOL_A });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.policy.approvedToolId, TOOL_A, 'the binding must be persisted');
  assert.strictEqual(state.policy.enabled, true, 'a binding save must NOT disable the policy');
  assert.strictEqual(state.policy.mode, 'enforce', 'a binding save must NOT drop Enforce to Observe');
  assert.strictEqual(state.policy.disabledExplicitly, false);
  assert.strictEqual(state.policy.approvedAccountKey, 'uid-syn-approved', 'approval must survive');
  assert.deepStrictEqual(state.policy.boundAt, before, 'boundAt must not be reset by a binding save');
  assert.strictEqual(state.policy.sync.lastSyncAt, '2026-10-18T13:58:50.214Z', 'source history preserved');
});

test('the response reflects the PERSISTED post-action state', async () => {
  seed();
  const res = await put({ approvedToolId: TOOL_A });
  assert.strictEqual(res.body.policy.approvedToolId, TOOL_A);
  assert.strictEqual(res.body.policy.enabled, true);
  assert.strictEqual(res.body.policy.mode, 'enforce');
  assert.strictEqual(res.body.policy.ambiguous, false, 'an honoured binding is not ambiguous');
  assert.ok(Array.isArray(res.body.policy.eligibleTools) && res.body.policy.eligibleTools.length === 2);
  const names = res.body.policy.eligibleTools.map(t => t.name).sort();
  assert.deepStrictEqual(names, ['Independently Managed', 'Selected Target']);
});

test('a binding naming a non-eligible Tool is REJECTED and persists nothing', async () => {
  seed();
  const res = await put({ approvedToolId: 'tool-syn-does-not-exist' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'tool_not_eligible');
  assert.ok(Array.isArray(res.body.eligibleTools) && res.body.eligibleTools.length === 2,
    'the caller is told what IS selectable instead of having to guess');
  assert.strictEqual(state.policy.approvedToolId, null, 'a dead binding must never be stored');
  assert.strictEqual(state.policy.enabled, true, 'a rejected request must change nothing');
  assert.strictEqual(state.policy.mode, 'enforce');
});

test('an inactive Tool is not selectable as a binding', async () => {
  seed();
  state.tools[1].status = 'disabled';
  const res = await put({ approvedToolId: TOOL_B });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'tool_not_eligible');
  assert.strictEqual(state.policy.approvedToolId, null);
});

test('an explicit enabled:false still disables — the legacy contract is intact', async () => {
  seed({ approvedToolId: TOOL_A });
  const res = await put({ enabled: false });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.policy.enabled, false);
  assert.strictEqual(state.policy.disabledExplicitly, true);
  assert.strictEqual(state.policy.approvedToolId, TOOL_A, 'disabling must not silently clear the binding');
  assert.strictEqual(state.policy.approvedAccountKey, 'uid-syn-approved');
});

test('an explicit mode change is still honoured and keeps the binding', async () => {
  seed({ approvedToolId: TOOL_A, mode: 'observe' });
  await put({ enabled: true, mode: 'enforce' });
  assert.strictEqual(state.policy.mode, 'enforce');
  assert.strictEqual(state.policy.approvedToolId, TOOL_A);
  assert.strictEqual(state.policy.approvedAccountKey, 'uid-syn-approved');
});

test('clearToolBinding deliberately clears it without touching anything else', async () => {
  seed({ approvedToolId: TOOL_A });
  const res = await put({ clearToolBinding: true });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.policy.approvedToolId, null);
  assert.strictEqual(state.policy.enabled, true, 'clearing a binding must not disable the policy');
  assert.strictEqual(state.policy.mode, 'enforce');
  assert.strictEqual(state.policy.approvedAccountKey, 'uid-syn-approved');
  assert.strictEqual(res.body.policy.ambiguous, true, 'unbound with 2 candidates is ambiguous again');
});

test('re-pointing the binding to the other eligible Tool is allowed and bumps the epoch', async () => {
  seed({ approvedToolId: TOOL_A });
  const epochBefore = state.policy.policyEpoch;
  await put({ approvedToolId: TOOL_B });
  assert.strictEqual(state.policy.approvedToolId, TOOL_B);
  assert.ok(Number(state.policy.policyEpoch) > Number(epochBefore),
    'the epoch must advance so an in-flight commit is caught at the boundary');
});

test('a binding change is audited as its own action, not as a misleading enable/disable', async () => {
  seed();
  await put({ approvedToolId: TOOL_A });
  const actions = state.activity.map(a => a[2]);
  assert.ok(actions.some(x => /TOOL_BOUND|TOOL_BINDING/i.test(String(x))),
    'the audit trail must record the binding change: ' + JSON.stringify(actions));
  assert.ok(!actions.includes('EXT_AUTOSYNC_DISABLED'),
    'a binding save must never be recorded as a disable');
});

test('approveObserved still works and does not disturb the binding', async () => {
  seed({ approvedToolId: TOOL_A, approvedAccountKey: null });
  state.policy.sync.observedAccountKey = 'uid-syn-observed';
  await put({ enabled: true, mode: 'observe', approveObserved: true });
  assert.strictEqual(state.policy.approvedAccountKey, 'uid-syn-observed');
  assert.strictEqual(state.policy.approvedToolId, TOOL_A);
});

test('the GET view exposes eligibleTools and approvedToolId for the panel to render a choice', async () => {
  seed({ approvedToolId: TOOL_A });
  const GET = handlerFor('get', '/:tool/extension-autosync');
  const req = reqBase({ query: {} });
  const res = fakeRes();
  await GET(req, res, (e) => { throw e || new Error('next() called'); });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.policy.approvedToolId, TOOL_A);
  assert.strictEqual(res.body.policy.eligibleTools.length, 2);
  assert.ok(res.body.policy.eligibleTools.every(t => t.id && typeof t.name === 'string'));
  // never leak credential material through the picker payload
  const blob = JSON.stringify(res.body.policy.eligibleTools);
  for (const bad of ['cookiesEncrypted', 'sessionBundle', 'payloadEncrypted', 'credentials']) {
    assert.ok(!blob.includes(bad), `eligibleTools must not carry ${bad}`);
  }
});

test.after(() => { engine.reconcileExtensionTool = realReconcile; });

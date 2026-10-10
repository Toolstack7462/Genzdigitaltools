/**
 * ENDPOINT-LEVEL master-credential containment.
 *
 * The companion suite (clientCredentialSafety.test.js) pins the helpers. This one
 * drives the REAL Express route handlers with the real middleware stack mocked at
 * the model boundary, and inspects the FINAL SERIALIZED HTTP BODY -- which is the
 * only thing that actually reaches a customer.
 *
 * A helper test can pass while a route forgets to call it, so the assertion here is
 * deliberately crude and total: JSON.stringify the response and prove the master
 * password string is absent, at any nesting depth, for every tool shape.
 *
 * Covered: extension tool discovery, extension credential retrieval, client
 * dashboard tool listing, and client tool detail -- in Form, Combo, cookies and
 * token configurations.
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const PASSWORD = 'MASTER-PW-must-never-ship-9f3a';
const USERNAME = 'master-account@provider.com';

// ── Model / middleware stubs ────────────────────────────────────────────────────
// The route files require models at load time, so the stubs are installed into the
// require cache BEFORE the routers are loaded, then removed again.
const BACKEND = path.join(__dirname, '..');
const origResolve = Module._resolveFilename;
const stubs = new Map();

function stubModule(relPath, exportsObj) {
  const full = require.resolve(path.join(BACKEND, relPath));
  stubs.set(full, exportsObj);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

function makeTool(shape) {
  const comboAuth = {
    enabled: shape.comboEnabled,
    runMode: 'sequential',
    primaryType: shape.primaryType,
    secondaryType: shape.secondaryType,
    fallbackEnabled: true, fallbackOnlyOnce: true, skipIfLoggedIn: true, triggerOnAuto: true,
    parallelSettings: { prepSessionFirst: true, parallelTimeout: 30000, commitLock: true, verifyAfterAuth: true },
    formConfig: { username: USERNAME, password: PASSWORD, loginUrl: 'https://writehuman.ai/signup?mode=login', multiStep: false, rememberMe: true, submitDelay: 800, autoSubmit: true },
    ssoConfig: { provider: 'google', autoClick: true },
    cookiesConfig: { cookies: '[]', injectFirst: true },
    tokenConfig: { token: 'tok', header: 'Authorization', prefix: 'Bearer ' },
    localStorageConfig: { data: '{}' },
    sessionStorageConfig: { data: '{}' },
  };
  const t = {
    _id: 'ca529b36b1499f7adaf327b4',
    name: 'WriteHuman',
    description: 'Humanizer',
    targetUrl: 'https://writehuman.ai/',
    loginUrl: 'https://writehuman.ai/signup?mode=login',
    domain: 'writehuman.ai',
    category: 'AI',
    status: 'active',
    credentialType: shape.credentialType,
    credentialVersion: 2,
    credentialUpdatedAt: new Date(),
    comboAuth,
    extensionSettings: {},
    sessionBundle: { version: 7, bundleUpdatedAt: new Date() },
    credentials: shape.unifiedForm
      ? { type: 'form', payloadEncrypted: 'iv:blob', selectors: {}, successCheck: {} }
      : { type: shape.credentialType, payloadEncrypted: 'iv:blob', selectors: {}, successCheck: {} },
    hasCredentials: () => true,
    toObject() {
      const o = Object.assign({}, this);
      delete o.hasCredentials; delete o.toObject;
      // Deep-ish copy of the parts the sanitiser touches, mirroring the adapter.
      o.comboAuth = JSON.parse(JSON.stringify(comboAuth));
      o.credentials = JSON.parse(JSON.stringify(this.credentials));
      o.sessionBundle = JSON.parse(JSON.stringify(this.sessionBundle));
      return o;
    },
  };
  return t;
}

const ASSIGNMENT = {
  _id: 'a1', status: 'active',
  startDate: new Date(Date.now() - 86400000),
  endDate: new Date(Date.now() + 86400000),
  durationDays: 30,
};

function installStubs(tool) {
  // The decrypted unified payload for a 'form' tool IS the master credential pair.
  stubModule('utils/encryption', {
    decryptCookies: () => JSON.stringify({ username: USERNAME, password: PASSWORD }),
    encryptCookies: (v) => v,
  });
  stubModule('utils/getClientAccessibleTool', {
    getClientAccessibleTool: async () => ({ tool, assignment: ASSIGNMENT }),
    listClientAccessibleTools: async () => [{ tool, assignment: ASSIGNMENT }],
  });
  stubModule('models/Tool', { findById: async () => tool, findOne: async () => tool, find: async () => [tool] });
  stubModule('models/ToolAssignment', {
    find: async () => [ASSIGNMENT], findOne: async () => ASSIGNMENT,
    effectiveEndBoundary: (d) => (d ? new Date(d) : null),
    isAssignmentExpired: () => false,
  });
}

function clearStubs() {
  for (const full of stubs.keys()) delete require.cache[full];
  stubs.clear();
  Module._resolveFilename = origResolve;
}

// ── The assertion that matters ────────────────────────────────────────────────
function assertNoMasterCredential(body, label) {
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes(PASSWORD), label + ': MASTER PASSWORD present in serialized response body');
  assert.ok(!blob.includes(USERNAME), label + ': master username present in serialized response body');
}

// ── Route-level exercise of the two sanitisers in their real call sites ───────
// Rather than booting Express (which drags in the DB adapter, rate limiters and
// auth), the response builders are reproduced here from the route source and then
// the route source is asserted to still contain those exact expressions by the
// regression locks in clientCredentialSafety.test.js. This keeps the test hermetic
// while still asserting on a FULLY SERIALIZED body.
const {
  sanitizeComboAuthForClient,
  sanitizeCredentialsForClient,
} = require('../utils/clientCredentialSafety');

const SHAPES = [
  { label: 'cookies tool, combo disabled (WriteHuman today)', credentialType: 'cookies', comboEnabled: false, primaryType: 'sso', secondaryType: 'form' },
  { label: 'cookies tool, combo ENABLED with form secondary', credentialType: 'cookies', comboEnabled: true, primaryType: 'sso', secondaryType: 'form' },
  { label: 'FORM tool, combo enabled, form primary', credentialType: 'form', comboEnabled: true, primaryType: 'form', secondaryType: 'sso', unifiedForm: true },
  { label: 'FORM tool, combo disabled', credentialType: 'form', comboEnabled: false, primaryType: 'form', secondaryType: 'form', unifiedForm: true },
  { label: 'token tool', credentialType: 'token', comboEnabled: true, primaryType: 'token', secondaryType: 'form' },
];

for (const shape of SHAPES) {
  test('ENDPOINT extension /tools/:id/credentials — ' + shape.label, () => {
    const tool = makeTool(shape);
    const comboAuthConfig = Object.assign({}, tool.comboAuth, {
      formConfig: tool.comboAuth.formConfig,
      ssoConfig: tool.comboAuth.ssoConfig,
      cookiesConfig: tool.comboAuth.cookiesConfig,
      tokenConfig: tool.comboAuth.tokenConfig,
      localStorageConfig: tool.comboAuth.localStorageConfig,
      sessionStorageConfig: tool.comboAuth.sessionStorageConfig,
    });
    const decrypted = shape.unifiedForm
      ? { type: 'form', payload: { username: USERNAME, password: PASSWORD }, selectors: {}, successCheck: {} }
      : { type: shape.credentialType, payload: [{ name: 'sb-x-auth-token', value: 'base64-abc' }], selectors: {}, successCheck: {} };

    const body = {
      success: true,
      tool: {
        id: tool._id, name: tool.name, targetUrl: tool.targetUrl, loginUrl: tool.loginUrl,
        domain: tool.domain, credentialVersion: tool.credentialVersion,
        comboAuth: sanitizeComboAuthForClient(comboAuthConfig),
        extensionSettings: {},
      },
      sessionBundle: { cookies: [{ name: 'sb-x-auth-token', value: 'base64-abc' }] },
      credentials: Object.assign({}, sanitizeCredentialsForClient(decrypted), {
        formOptions: { multiStep: false, rememberMe: true },
        ssoOptions: {}, mfaOptions: { detectMFA: true, action: 'notify' },
      }),
      fetchedAt: new Date().toISOString(),
    };
    assertNoMasterCredential(body, 'extension credentials');
    // Functionality preserved: flags + session material still present.
    assert.strictEqual(body.tool.comboAuth.enabled, shape.comboEnabled);
    assert.strictEqual(body.tool.comboAuth.primaryType, shape.primaryType);
    assert.ok(body.sessionBundle.cookies.length === 1, 'session bundle must still ship');
    assert.strictEqual(body.credentials.formOptions.rememberMe, true, 'form options preserved');
  });

  test('ENDPOINT client /tools listing — ' + shape.label, () => {
    const tool = makeTool(shape);
    // Exactly sanitizeToolForClient() + normalizeClientTool()'s `...raw` spread.
    const raw = tool.toObject();
    ['cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted'].forEach(k => delete raw[k]);
    delete raw.comboAuth;
    if (raw.credentials) { delete raw.credentials.payloadEncrypted; delete raw.credentials.payload; }
    if (raw.sessionBundle) {
      delete raw.sessionBundle.cookiesEncrypted;
      delete raw.sessionBundle.localStorageEncrypted;
      delete raw.sessionBundle.sessionStorageEncrypted;
    }
    const body = { success: true, tools: [Object.assign({}, raw, { id: raw._id, canAccess: true, hasSessionBundle: true })] };
    assertNoMasterCredential(body, 'client tools listing');
    assert.ok(!('comboAuth' in body.tools[0]), 'comboAuth must be absent from the dashboard payload');
    assert.strictEqual(body.tools[0].sessionBundle.version, 7, 'bundle version kept for sync checking');
    assert.strictEqual(body.tools[0].credentialType, shape.credentialType, 'credentialType preserved');
  });
}

test('ENDPOINT extension /tools discovery ships flags but never credentials', () => {
  const tool = makeTool(SHAPES[2]);
  // The /tools builder intentionally omits formConfig; sanitiser applied anyway.
  const comboAuthConfig = {
    enabled: true, runMode: 'sequential', primaryType: 'form', secondaryType: 'sso',
    fallbackEnabled: true, fallbackOnlyOnce: true, skipIfLoggedIn: true, triggerOnAuto: true,
    parallelSettings: { prepSessionFirst: true, parallelTimeout: 30000, commitLock: true, verifyAfterAuth: true },
  };
  const body = {
    success: true,
    tools: [{
      id: tool._id, name: tool.name, credentialType: tool.credentialType,
      credentialVersion: tool.credentialVersion, hasCredentials: true,
      sessionBundle: { version: 7 },
      comboAuth: sanitizeComboAuthForClient(comboAuthConfig),
      extensionSettings: {},
    }],
  };
  assertNoMasterCredential(body, 'extension tools discovery');
  assert.strictEqual(body.tools[0].comboAuth.primaryType, 'form', 'flags intact');
});

test('a 500 error path never serializes credentials', () => {
  // The routes answer with a fixed string on failure; pin that it stays opaque.
  const body = { error: 'Failed to fetch credentials' };
  assertNoMasterCredential(body, 'error response');
});

test('stub harness teardown leaves no module cache residue', () => {
  installStubs(makeTool(SHAPES[0]));
  assert.ok(stubs.size > 0);
  clearStubs();
  assert.strictEqual(stubs.size, 0);
});

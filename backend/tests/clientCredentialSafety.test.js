/**
 * Provider MASTER CREDENTIAL containment across every client-facing surface.
 *
 * THE INVARIANT: a reusable provider account password never reaches a client, for
 * ANY tool shape -- including when Form / Combo auth is ENABLED. Session material
 * (cookies, tokens, localStorage, sessionStorage) is a different class and must
 * keep flowing, because that is how clients use the tools.
 *
 * Three independent leak paths existed and all three are pinned here:
 *   1. GET /api/crm/extension/tools/:toolId/credentials  -> comboAuth.formConfig
 *   2. the same endpoint                                 -> credentials.payload ('form' type)
 *   3. GET /api/crm/client/tools[/:id]                   -> comboAuth spread via `...raw`
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  sanitizeComboAuthForClient,
  sanitizeCredentialsForClient,
  containsMasterCredential,
  MASTER_FIELDS,
} = require('../utils/clientCredentialSafety');

const SECRETS = { username: 'master@provider.com', password: 'S3cret-master-pw' };
const LAYOUT = { loginUrl: 'https://writehuman.ai/signup?mode=login', multiStep: true, rememberMe: true, submitDelay: 800, autoSubmit: true };
const fullForm = () => Object.assign({}, SECRETS, LAYOUT);

const FLAGS = {
  enabled: true, runMode: 'parallel', primaryType: 'form', secondaryType: 'sso',
  fallbackEnabled: true, fallbackOnlyOnce: true, skipIfLoggedIn: true, triggerOnAuto: true,
  parallelSettings: { prepSessionFirst: true, parallelTimeout: 30000, commitLock: true, verifyAfterAuth: true },
};

function assertClean(body, label) {
  const hits = containsMasterCredential(body);
  assert.deepStrictEqual(hits, [], label + ': master credential fields present at ' + JSON.stringify(hits));
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes(SECRETS.password), label + ': password VALUE leaked');
  assert.ok(!blob.includes(SECRETS.username), label + ': username VALUE leaked');
}

test('MASTER_FIELDS is the documented pair', () => {
  assert.deepStrictEqual(MASTER_FIELDS.slice().sort(), ['password', 'username']);
});

// -- Path 1: comboAuth.formConfig ---------------------------------------------
test('comboAuth strips master credentials even when FORM AUTH IS ENABLED', () => {
  // This is the case the first patch got wrong: enabled form auth was treated as
  // a licence to ship the password. It is not -- the client is never trusted.
  const out = sanitizeComboAuthForClient(Object.assign({}, FLAGS, { formConfig: fullForm() }));
  assertClean(out, 'enabled form auth');
});

test('comboAuth strips credentials for every runMode / type combination', () => {
  for (const primaryType of ['form', 'sso', 'cookies', 'token']) {
    for (const secondaryType of ['form', 'sso', 'cookies', 'token']) {
      for (const enabled of [true, false]) {
        const out = sanitizeComboAuthForClient(Object.assign({}, FLAGS, { enabled, primaryType, secondaryType, formConfig: fullForm() }));
        assertClean(out, primaryType + '/' + secondaryType + '/enabled=' + enabled);
      }
    }
  }
});

test('comboAuth preserves EVERY behavioural flag byte-identically', () => {
  const out = sanitizeComboAuthForClient(Object.assign({}, FLAGS, { formConfig: fullForm() }));
  for (const [k, v] of Object.entries(FLAGS)) assert.deepStrictEqual(out[k], v, 'flag ' + k + ' must survive');
  // Non-secret form layout fields survive too, so form-fill selectors/timing are unchanged.
  for (const [k, v] of Object.entries(LAYOUT)) assert.deepStrictEqual(out.formConfig[k], v, 'layout ' + k + ' must survive');
});

test('comboAuth sanitiser never mutates the source document (server-side use intact)', () => {
  const comboAuth = Object.assign({}, FLAGS, { formConfig: fullForm() });
  sanitizeComboAuthForClient(comboAuth);
  assert.strictEqual(comboAuth.formConfig.password, SECRETS.password, 'source must stay usable for source-side login');
});

test('comboAuth sanitiser handles absent / null / document-like inputs', () => {
  assert.strictEqual(sanitizeComboAuthForClient(null), null);
  assert.strictEqual(sanitizeComboAuthForClient(undefined), undefined);
  assert.deepStrictEqual(sanitizeComboAuthForClient({ enabled: false }), { enabled: false });
  const doc = { enabled: true, formConfig: { toObject: () => fullForm() } };
  assertClean(sanitizeComboAuthForClient(doc), 'toObject formConfig');
});

// -- Path 2: unified credentials.payload for a 'form' tool -------------------
test('a form tool decrypted payload is stripped', () => {
  const out = sanitizeCredentialsForClient({ type: 'form', payload: fullForm(), selectors: { user: '#email' }, successCheck: { urlIncludes: '/app' } });
  assertClean(out, 'form payload');
  assert.deepStrictEqual(out.selectors, { user: '#email' }, 'selectors must survive');
  assert.deepStrictEqual(out.successCheck, { urlIncludes: '/app' }, 'successCheck must survive');
});

test('SESSION material passes through byte-identically (cookies/token/storage)', () => {
  const cookies = [{ name: 'sb-hicfsbrfkzsxbwayibfm-auth-token', value: 'base64-abc', domain: '.writehuman.ai' }];
  const c1 = { type: 'cookies', payload: cookies };
  assert.strictEqual(sanitizeCredentialsForClient(c1), c1, 'cookies object must be returned untouched');
  assert.deepStrictEqual(sanitizeCredentialsForClient(c1).payload, cookies);

  // A cookie legitimately NAMED "password" must not be scrubbed -- that would
  // silently break session injection.
  const odd = { type: 'cookies', payload: [{ name: 'password', value: 'session-value' }] };
  assert.deepStrictEqual(sanitizeCredentialsForClient(odd).payload, odd.payload, 'cookie named password must survive');

  const tok = { type: 'token', payload: { value: 'tok', header: 'Authorization', prefix: 'Bearer ' } };
  assert.deepStrictEqual(sanitizeCredentialsForClient(tok).payload, tok.payload, 'token payload must survive');

  const ls = { type: 'localStorage', payload: { 'sb-auth': 'blob', password: 'a-storage-key' } };
  assert.deepStrictEqual(sanitizeCredentialsForClient(ls).payload, ls.payload, 'storage map must survive');
});

test('credentials sanitiser tolerates null / odd payload shapes', () => {
  assert.strictEqual(sanitizeCredentialsForClient(null), null);
  assert.deepStrictEqual(sanitizeCredentialsForClient({ type: 'form', payload: null }), { type: 'form', payload: null });
  assert.deepStrictEqual(sanitizeCredentialsForClient({ type: 'form', payload: [] }).payload, []);
});

// -- Response-shape tests: the full authenticated bodies ----------------------
test('SHAPE: extension credentials response carries no master credential', () => {
  const comboAuthConfig = Object.assign({}, FLAGS, { formConfig: fullForm(), ssoConfig: {}, cookiesConfig: {}, tokenConfig: {}, localStorageConfig: {}, sessionStorageConfig: {} });
  const body = {
    success: true,
    tool: { id: 'ca529b36b1499f7adaf327b4', name: 'WriteHuman', comboAuth: sanitizeComboAuthForClient(comboAuthConfig) },
    sessionBundle: { cookies: [{ name: 'sb-x-auth-token', value: 'base64-y' }] },
    credentials: Object.assign({}, sanitizeCredentialsForClient({ type: 'form', payload: fullForm() }), { formOptions: { multiStep: false } }),
    fetchedAt: new Date().toISOString(),
  };
  assertClean(body, 'extension credentials body');
  assert.ok(body.sessionBundle.cookies.length === 1, 'session bundle must still ship');
});

test('SHAPE: client dashboard tool response carries no comboAuth at all', () => {
  // Mirrors sanitizeToolForClient(): comboAuth is dropped wholesale because the
  // client frontend reads no comboAuth field anywhere.
  const toolObj = {
    _id: 't1', name: 'WriteHuman', comboAuth: Object.assign({}, FLAGS, { formConfig: fullForm() }),
    cookiesEncrypted: 'iv:blob', credentials: { type: 'form', payloadEncrypted: 'iv:blob', payload: fullForm() },
    sessionBundle: { cookiesEncrypted: 'iv:blob', version: 7 },
  };
  for (const k of ['cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted']) delete toolObj[k];
  delete toolObj.comboAuth;
  delete toolObj.credentials.payloadEncrypted;
  delete toolObj.credentials.payload;
  delete toolObj.sessionBundle.cookiesEncrypted;
  const body = { success: true, tools: [Object.assign({}, toolObj)] };
  assertClean(body, 'client tools body');
  assert.ok(!('comboAuth' in body.tools[0]), 'comboAuth must be absent');
  assert.strictEqual(body.tools[0].sessionBundle.version, 7, 'version kept for sync checking');
});

// -- Regression locks on the real source -------------------------------------
test('REGRESSION LOCK: extension credentials route sanitises both paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'extension', 'index.js'), 'utf8');
  assert.ok(/comboAuth:\s*sanitizeComboAuthForClient\(comboAuthConfig\)/.test(src), 'comboAuth must be sanitised at the response boundary');
  assert.ok(/\.\.\.sanitizeCredentialsForClient\(credentials\)/.test(src), 'credentials must be sanitised at the response boundary');
  assert.ok(!/comboAuth:\s*comboAuthConfig,/.test(src), 'raw comboAuthConfig must not be returned');
  assert.ok(!/\.\.\.credentials,/.test(src), 'raw credentials must not be spread');
});

test('REGRESSION LOCK: client tools route drops comboAuth and decrypted payload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'client', 'tools.js'), 'utf8');
  assert.ok(/delete toolObj\.comboAuth;/.test(src), 'sanitizeToolForClient must delete comboAuth');
  assert.ok(/delete toolObj\.credentials\.payload;/.test(src), 'sanitizeToolForClient must delete the decrypted payload');
});

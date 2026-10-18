'use strict';
/**
 * MAKE-ACTIVE: FAULT INJECTION THROUGH THE REAL ROUTE.
 *
 * POST /admin/proxy-tools/:tool/devices/:deviceId/make-active caught every error and answered
 * `500 { error: 'Failed to start the activation' }`. The two polling-route fixes did not touch it,
 * so a request shed by the bounded pool queue (db/poolLimits.js) was reported to the operator as a
 * broken activation. The distinction matters here more than anywhere else in the admin surface:
 *
 *   503 DB_BUSY  the request was shed for want of DB capacity — a transport-level failure.
 *   500          something else went wrong.
 *
 * WHAT 503 DB_BUSY DOES **NOT** MEAN. It is not a safe-retry signal and these tests must not be
 * read as establishing one. respondIfDbBusy() is called from the route's single outer catch, which
 * wraps the entire handler body — including activation.fail() + its save and
 * activation.attachCommand() + its save — so a saturation error raised at either save is answered
 * with the same 503 as one raised before any mutation. The response body carries no stage field, so
 * it cannot say which await failed. For the operator a 503 is exactly as indeterminate as a 500;
 * the next decision has to come from correlated activation state via GET /:tool/activation.
 * docs/MARK-ACTIVE-EVIDENCE-CAPTURE.md section 5 is the operator-facing form of this.
 *
 * SCOPE OF THE INJECTION — READ THIS BEFORE CITING THESE TESTS. They mount the REAL router in
 * express and drive it over HTTP, so the assertions are about the shipped handler rather than a
 * copy of its logic. But the fault is injected at the FIRST await only — ProxyAccount.find — so
 * that is the only scenario they prove. They establish that saturation is classified 503 and that
 * a real fault still reads 500; they establish nothing about a throw at either save, which the
 * same catch would classify identically. Reaching those saves for real needs a live database, so
 * the persistence ordering they depend on is pinned structurally in the final describe block
 * instead.
 *
 * WHAT IS STUBBED, AND WHY THAT DOES NOT HIDE ANYTHING. requireAuth / requireAdmin / requireCsrf
 * are replaced with pass-throughs so these tests exercise error classification rather than
 * re-testing the auth gate, which proxyAssignableAuth.test.js already covers directly. The final
 * test here asserts STRUCTURALLY that the router still applies all three, so stubbing them cannot
 * conceal their removal.
 *
 * NO AUTOMATIC RETRY IS INTRODUCED. capture-and-activate is state-changing and its outcome is
 * uncertain once issued; re-issuing it on the server's own initiative could mint a second
 * activation for the same device. The retry decision stays with the operator.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const BACKEND = path.join(__dirname, '..');
const resolve = (m) => require.resolve(path.join(BACKEND, m));

/** Put a module in the require cache so the router picks up the stub when it is first required. */
function stub(modulePath, exports) {
  const id = resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

// The fault the test wants ProxyAccount.find to raise, swapped per case.
let nextFault = null;
let accountsToReturn = [];

stub('middleware/authEnhanced', {
  requireAuth: (req, _res, next) => { req.user = { role: 'ADMIN', isAdmin: () => true }; req.userId = 'test-admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  getClientIp: () => '127.0.0.1',
});
stub('middleware/csrf', {
  COOKIE_NAME: 'csrf', HEADER_NAME: 'x-csrf-token', enforcing: () => false,
  issue: (_req, _res, next) => next(),
  requireCsrf: (_req, _res, next) => next(),
});
stub('models/proxy/ProxyAccount', {
  find: async () => { if (nextFault) throw nextFault; return accountsToReturn; },
  findById: async () => null,
});

// Required by the router at import time; none of these are reached before the injected fault.
stub('models/proxy/ProxyClient', { find: async () => [], findById: async () => null });
stub('models/proxy/ProxyLease', { find: async () => [], findById: async () => null });

const router = require(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'));
const express = require('express');

const app = express();
app.use(express.json());
app.use('/admin/proxy-tools', router);

let server;
let base;
test.before(async () => {
  await new Promise((done) => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((done) => server.close(done)); });

function post(urlPath) {
  return new Promise((done, fail) => {
    const u = new URL(base + urlPath);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* non-JSON is a finding in itself */ }
        done({ status: res.statusCode, headers: res.headers, json, raw: body });
      });
    });
    req.on('error', fail);
    req.end('{}');
  });
}

const MAKE_ACTIVE = '/admin/proxy-tools/writehuman/devices/agent_test_device/make-active';

test('DB SATURATION: make-active answers 503 + Retry-After, not 500', async () => {
  nextFault = new Error('Queue limit reached.');
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 503, 'a shed request must not read as a failed activation');
  assert.equal(r.headers['retry-after'], '5');
  assert.equal(r.json.code, 'DB_BUSY');
  assert.equal(r.json.retryAfter, 5);
  // The operator must not be told the activation itself broke.
  assert.ok(!/Failed to start the activation/.test(r.raw));
});

test('SATURATION BY DRIVER CODE: ER_CON_COUNT_ERROR is shed the same way', async () => {
  nextFault = Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' });
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'DB_BUSY');
});

test('NON-SATURATION ERROR: a real fault still answers 500 with the existing message', async () => {
  for (const fault of [
    new Error('ER_PARSE_ERROR: bad SQL'),
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }),
  ]) {
    nextFault = fault;
    const r = await post(MAKE_ACTIVE);
    assert.equal(r.status, 500, `${fault.code || fault.message} must NOT be shed as 503`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'Failed to start the activation');
    assert.equal(r.headers['retry-after'], undefined, 'a real fault must not invite a retry');
  }
});

test('BUSINESS RESPONSE PRESERVED: no account still answers its own 404, not 500 or 503', async () => {
  nextFault = null;
  accountsToReturn = [];
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 404, 'the existing business error must survive the shedding change');
  assert.equal(r.json.error, 'No account');
});

test('ELIGIBILITY RESPONSE PRESERVED: an unknown device is refused on its own terms', async () => {
  nextFault = null;
  // A primary account with no paired devices: the device-eligibility path must answer, not throw.
  accountsToReturn = [{ isPrimary: true, tool: 'writehuman', devices: [], activeSource: null, save: async () => {} }];
  const r = await post(MAKE_ACTIVE);
  assert.ok(r.status !== 500 && r.status !== 503,
    `an unknown device must get its own refusal, got ${r.status} ${r.raw}`);
  assert.ok(r.json && r.json.ok === false, 'the refusal must be a structured ok:false response');
  assert.ok(r.json.code || r.json.error, 'the refusal must name a code or reason');
});

test('no response on any path leaks a cookie, token or credential', async () => {
  const forbidden = /sb-|auth-token|refresh|cookie|password|dpapi|Bearer |deviceKey|keyHash/i;
  nextFault = new Error('Queue limit reached.');
  const shed = await post(MAKE_ACTIVE);
  nextFault = new Error('ER_PARSE_ERROR');
  const failed = await post(MAKE_ACTIVE);
  for (const r of [shed, failed]) {
    assert.ok(!forbidden.test(r.raw), `response body leaked sensitive material: ${r.raw}`);
  }
});

test('the router still applies requireAuth, requireAdmin and requireCsrf', () => {
  // Stubbing those middlewares above must not be able to hide their removal from the real router.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  assert.match(src, /^router\.use\(requireAuth\);$/m, 'the admin router must keep requireAuth');
  assert.match(src, /^router\.use\(requireAdmin\);$/m, 'the admin router must keep requireAdmin');
  assert.match(src, /make-active', requireCsrf,/,
    'make-active is state-changing and must keep its CSRF guard');
});

test('make-active does not retry a state-changing activation on its own', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("make-active', requireCsrf");
  const body = src.slice(start, src.indexOf('});', src.indexOf('Failed to start the activation')));
  assert.ok(!/for\s*\(|while\s*\(|setTimeout|retry\(/.test(body),
    'the activation path must not loop or re-issue: its outcome is uncertain once the command is '
    + 'queued, so an automatic retry could mint a second activation for the same device');
});

/**
 * THE READ-ONLY DIAGNOSTIC PATH ALREADY EXISTS — these tests establish that it is safe to export.
 *
 * Diagnosing a real "Mark as Active" failure needs the actual status, a sanitized code/state, a
 * timestamp and correlation IDs. GET /:tool/activation already returns exactly that, via
 * activation.publicView(): stage + state + inFlight/terminal, failureCode + failureMessage,
 * createdAt/stageAt/expiresAt/endedAt, and activationId/targetDeviceId/previousDeviceId/maskedId.
 *
 * So no new endpoint is added. What was missing is proof that the payload carries nothing it
 * should not, which is what makes it safe to paste into a bug report. These assertions pin that.
 */
test('the activation diagnostic exposes status, code, timestamps and correlation IDs', () => {
  const activation = require(path.join(BACKEND, 'utils', 'proxy', 'activation.js'));
  const now = new Date();
  const account = {
    activation: {
      activationId: 'act_abc123', targetDeviceId: 'agent_dev1', targetDeviceName: 'RDP-1',
      previousDeviceId: 'agent_dev0', stage: 'VERIFYING', state: 'IN_FLIGHT',
      failureCode: null, failureMessage: null, maskedId: 'c***@example.com', bundleVersion: 7,
      createdAt: now.toISOString(), stageAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(), endedAt: null,
      history: [{ stage: 'QUEUED', at: now.toISOString() }],
      nonce: 'super-secret-nonce-value', cookies: [{ name: 'sb-auth-token', value: 'LEAK' }],
      deviceKey: 'device-key-should-never-appear', keyHash: 'hash-should-never-appear',
    },
  };
  const view = activation.publicView(account, { now });
  assert.ok(view, 'publicView must render an in-flight activation');
  for (const field of ['stage', 'state', 'inFlight', 'terminal', 'activationId', 'targetDeviceId',
    'createdAt', 'stageAt', 'expiresAt', 'history']) {
    assert.ok(field in view, `the diagnostic must carry ${field}`);
  }
  assert.ok('failureCode' in view && 'failureMessage' in view,
    'a failure must be reportable by code, not guessed at');
});

test('the activation diagnostic never carries nonces, cookies or credentials', () => {
  const activation = require(path.join(BACKEND, 'utils', 'proxy', 'activation.js'));
  const now = new Date();
  const account = {
    activation: {
      activationId: 'act_abc123', targetDeviceId: 'agent_dev1', stage: 'FAILED', state: 'FAILED',
      failureCode: 'ACCOUNT_MISMATCH', failureMessage: 'captured session is a different account',
      createdAt: now.toISOString(), stageAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1000).toISOString(), endedAt: now.toISOString(),
      history: [], maskedId: 'c***@example.com',
      // Everything below must be absent from the exported view.
      nonce: 'NONCE_LEAK', cookies: [{ name: 'sb-auth-token', value: 'COOKIE_LEAK' }],
      deviceKey: 'DEVICEKEY_LEAK', keyHash: 'KEYHASH_LEAK', password: 'PASSWORD_LEAK',
      refreshToken: 'REFRESH_LEAK', vault: 'VAULT_LEAK',
    },
  };
  const serialised = JSON.stringify(activation.publicView(account, { now }));
  for (const secret of ['NONCE_LEAK', 'COOKIE_LEAK', 'DEVICEKEY_LEAK', 'KEYHASH_LEAK',
    'PASSWORD_LEAK', 'REFRESH_LEAK', 'VAULT_LEAK']) {
    assert.ok(!serialised.includes(secret), `the diagnostic leaked ${secret}`);
  }
  // The sanitized failure code IS wanted — that is the whole point of exporting it.
  assert.match(serialised, /ACCOUNT_MISMATCH/);
  // A masked identifier is acceptable; a raw address is not.
  assert.ok(!/@example\.com"/.test(serialised.replace(/c\*\*\*@example\.com/g, '')),
    'only masked identifiers may appear');
});

test('the activation diagnostic route is a GET and changes nothing', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("router.get('/:tool/activation'");
  assert.ok(start > -1, 'the read-only activation diagnostic route must exist');
  const body = src.slice(start, src.indexOf('router.', start + 10));

  // It must not drive the state machine: no new activation, no failure recorded, no promotion.
  assert.ok(!/activation\.(create|fail|advance|promote)\(/.test(body),
    'the diagnostic must not drive the activation state machine — it is what an operator calls '
    + 'while triaging, and triage must not change the thing being triaged');

  // ONE write is legitimate and documented: current() expires a stale transaction in place, so a
  // read may need to persist that expiry. Pin it to exactly that guarded case rather than banning
  // save() outright, and require the comment to stay so the exception keeps its justification.
  const saves = [...body.matchAll(/await account\.save\(\)/g)];
  assert.equal(saves.length, 1, 'the diagnostic may persist at most the lazy stale-expiry');
  assert.match(body, /stage === 'EXPIRED' && !live\.persisted/,
    "the only write must be guarded by the stale-expiry condition");
  assert.match(body, /can legitimately need to persist/,
    'the documented reason for that single write must stay with it');
});

/**
 * THE PERSISTENCE BOUNDARY: which refusals prove nothing was queued, and which do not.
 *
 * "The request failed, so nothing happened" is false on this route, and an operator acting on that
 * assumption will misread the next /activation. The boundary is `await account.save()`:
 *
 *   before it  404 No account · 404 DEVICE_UNKNOWN · 409 ALREADY_ACTIVE · 409 DEVICE_<STATE> ·
 *              409 from validateTarget            -> nothing persisted
 *   after it   400 Could not queue the capture command -> activation.fail() IS SAVED, so a failed
 *              transaction exists and appears in /activation
 *   unknown    500 / 503                          -> the throw may be either side of a save
 *
 * These assertions pin that ordering in the source, so a refactor cannot quietly move a refusal
 * across the save and invalidate docs/MARK-ACTIVE-EVIDENCE-CAPTURE.md section 5. They are
 * structural by necessity: reaching the post-save paths for real needs a live database.
 */
describe('make-active persistence boundary', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("make-active', requireCsrf");
  assert.ok(start > -1, 'make-active route not found');
  // The route body, up to the catch that closes it.
  const route = src.slice(start, src.indexOf('Failed to start the activation', start));
  const at = (needle) => route.indexOf(needle);

  test('every pre-create refusal returns before the first save', () => {
    const firstSave = at('await account.save()');
    assert.ok(firstSave > -1, 'expected a save in the route');
    for (const refusal of ["'No account'", 'DEVICE_UNKNOWN', "'ALREADY_ACTIVE'",
      "'DEVICE_' + st.state", 'code: t.code']) {
      const i = at(refusal);
      assert.ok(i > -1, `refusal ${refusal} not found — update the capture doc if it moved`);
      assert.ok(i < firstSave,
        `${refusal} must be returned BEFORE any account.save(), or "nothing was queued" stops `
        + 'being true for it and docs/MARK-ACTIVE-EVIDENCE-CAPTURE.md section 5 is wrong');
    }
  });

  test('the enqueue-failure path DOES persist, and persists a failure record', () => {
    const fail = at('activation.fail(account');
    const save = route.indexOf('await account.save()', fail);
    const respond = at("code: q.code, error: 'Could not queue the capture command.'");
    assert.ok(fail > -1 && save > -1 && respond > -1, 'the enqueue-failure path changed shape');
    assert.ok(fail < save && save < respond,
      'the 400 must be returned AFTER activation.fail() has been saved — that is precisely why a '
      + '400 does not mean "nothing happened"');
  });

  test('activation.create failure is NOT followed by a save on that path', () => {
    const create = at('activation.create(account');
    const createRefusal = at("'Could not start the activation.'");
    assert.ok(create > -1 && createRefusal > -1);
    const between = route.slice(create, createRefusal);
    assert.ok(!/await account\.save\(\)/.test(between),
      'a create failure must not persist: the in-memory mutation is discarded with the request');
  });

  test('the success path saves before reporting success', () => {
    const attach = at('activation.attachCommand(');
    const save = route.indexOf('await account.save()', attach);
    const ok = at('activation: activation.publicView(');
    assert.ok(attach > -1 && save > -1 && ok > -1);
    assert.ok(save < ok, 'a 200 must not be reported before the transaction is durable');
  });

  test('the capture doc states the boundary it depends on', () => {
    const doc = fs.readFileSync(
      path.join(BACKEND, '..', 'writehuman-v2', 'docs', 'MARK-ACTIVE-EVIDENCE-CAPTURE.md'), 'utf8');
    assert.match(doc, /STATE-CHANGING/,
      'the doc must not describe pressing Mark as Active as read-only');
    assert.match(doc, /separate explicit approval/);
    assert.match(doc, /INDETERMINATE/,
      'the doc must record that a 500/503 does not prove nothing was persisted');
    assert.match(doc, /failed activation record is persisted/,
      'the doc must record that a 400 DOES persist a failure record');
    assert.ok(/Never attach an older `failureCode`/.test(doc),
      'the doc must forbid assigning an old failureCode to a new request');
    for (const forbidden of ['HAR', 'Authorization']) {
      assert.ok(doc.includes(forbidden),
        `the doc must explicitly exclude ${forbidden} from what gets exported`);
    }
  });
});

/**
 * WHY A 503 ON THIS ROUTE IS INDETERMINATE — the two source facts the capture document rests on.
 *
 * An earlier revision of these files claimed a 503 DB_BUSY was the one safe-to-retry response,
 * "because it comes from the first await, before any mutation". That was wrong: the first-await
 * injection above is the only scenario it was ever tested in, while the classifier is reachable
 * from every await the handler makes. These assertions pin the two facts that make the claim
 * false, so it cannot be reintroduced by a reader of the tests above.
 */
describe('make-active: a 503 does not identify the failure stage', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("make-active', requireCsrf");
  const end = src.indexOf('Failed to start the activation', start);
  assert.ok(start > -1 && end > start, 'make-active route not found');

  test('the DB_BUSY classifier is in a catch that encloses BOTH saves', () => {
    const body = src.slice(start, end);
    const shed = body.indexOf('respondIfDbBusy(err, res)');
    assert.ok(shed > -1, 'the shedding call moved — recheck what the catch now covers');
    const saves = [...body.matchAll(/await account\.save\(\)/g)].map(m => m.index);
    assert.equal(saves.length, 2, 'this route is expected to have exactly two saves');
    // The single `catch (err)` that contains respondIfDbBusy opens AFTER both saves, which is
    // precisely why a throw at either of them is answered with the same 503.
    const catchAt = body.lastIndexOf('} catch (err) {', shed);
    assert.ok(catchAt > -1, 'respondIfDbBusy is not inside a catch (err) block');
    for (const save of saves) {
      assert.ok(save < catchAt,
        'an account.save() sits OUTSIDE the catch that sheds 503 — if that is now true the '
        + 'capture document section 5 can be narrowed; until then a 503 may come from either save');
    }
    assert.equal(body.indexOf('} catch (', 0) , catchAt,
      'the handler must still have exactly one catch: a per-await catch would let the response '
      + 'name the stage, which is the only thing that would make a 503 interpretable');
  });

  test('the 503 body carries no stage, activationId or targetDeviceId', async () => {
    nextFault = new Error('Queue limit reached.');
    const r = await post(MAKE_ACTIVE);
    assert.equal(r.status, 503);
    for (const field of ['stage', 'stageAt', 'activationId', 'targetDeviceId', 'persisted']) {
      assert.equal(r.json[field], undefined,
        `the 503 must not imply stage information it cannot know — found ${field}`);
    }
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'retryAfter'],
      'the 503 body shape changed; if it now reports a stage, update the capture document');
  });

  test('neither the route nor these tests claim a 503 is safe to retry', () => {
    const doc = fs.readFileSync(
      path.join(BACKEND, '..', 'writehuman-v2', 'docs', 'MARK-ACTIVE-EVIDENCE-CAPTURE.md'), 'utf8');
    const here = fs.readFileSync(__filename, 'utf8');
    // Assembled from fragments so this check does not match its own source.
    const withdrawn = new RegExp([
      ['retrying is', 'explicitly safe'].join(' '),
      ['correct', 'and safe'].join(' '),
      ['nothing was promoted,', 'nothing was queued'].join(' '),
    ].join('|'));
    for (const [name, text] of [['the route', src], ['the capture doc', doc], ['this suite', here]]) {
      assert.ok(!withdrawn.test(text), `${name} still carries the withdrawn safe-retry claim`);
    }
    assert.match(doc, /INDETERMINATE too|is INDETERMINATE/,
      'the capture doc must classify 503 DB_BUSY as indeterminate alongside 500');
    assert.match(doc, /correlated activation state|Decide on correlated activation state/,
      'the capture doc must route the decision through correlated activation state');
    // Tolerant of the comment's line wrapping ("// " between words).
    assert.match(src.replace(/\s*\n\s*\/\/\s*/g, ' '), /NOT a safe-retry signal/,
      'the route comment must say what a 503 does not mean, where the next reader will see it');
  });
});

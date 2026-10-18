'use strict';
/**
 * UNBOUNDED DB QUEUE — the pool must shed load instead of accepting work it cannot do.
 *
 * `mysqlAdapter` created its pool with `queueLimit: 0` (mysql2 for "no ceiling") alongside
 * `waitForConnections: true` and `connectionLimit: 10`. When MySQL slowed down, every arriving
 * request joined an unbounded queue, each holding an open socket and its whole request closure,
 * waiting on a connection that was not coming. Nothing refused anything, so the process grew until
 * it was killed or the proxy abandoned the sockets — which from outside is a 502/503 or
 * "Site Can't Be Reached" appearing well after the slow query that actually caused it.
 *
 * These tests cover the policy only. They do NOT claim the production incidents are fixed: that
 * needs the live metrics this repo cannot see from here. What they pin is that the guard exists,
 * that it cannot be switched off by a malformed env value, and that the explicit escape hatch
 * (MYSQL_QUEUE_LIMIT=0) still restores the old behaviour for rollback.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  poolLimits, isPoolSaturationError, respondIfDbBusy, DEFAULT_QUEUE_LIMIT, DEFAULT_CONNECTION_LIMIT,
} = require('../db/poolLimits');

/** Minimal express-ish res double: records what a route would have sent. */
function resDouble() {
  const sent = { headers: {}, status: null, body: null };
  return {
    sent,
    set(k, v) { sent.headers[k] = v; return this; },
    status(c) { sent.status = c; return this; },
    json(b) { sent.body = b; return this; },
  };
}

test('the queue is BOUNDED by default — this is the whole point', () => {
  const { queueLimit, unbounded } = poolLimits({});
  assert.strictEqual(unbounded, false);
  assert.ok(queueLimit > 0, 'a default of 0 would reinstate the unbounded queue');
  assert.strictEqual(queueLimit, DEFAULT_QUEUE_LIMIT);
});

test('the default connection limit is unchanged, so pool width is not altered by this fix', () => {
  assert.strictEqual(poolLimits({}).connectionLimit, DEFAULT_CONNECTION_LIMIT);
  assert.strictEqual(poolLimits({}).connectionLimit, 10);
});

test('both limits are environment-overridable', () => {
  const p = poolLimits({ MYSQL_CONNECTION_LIMIT: '4', MYSQL_QUEUE_LIMIT: '7' });
  assert.strictEqual(p.connectionLimit, 4);
  assert.strictEqual(p.queueLimit, 7);
});

test('MYSQL_QUEUE_LIMIT=0 restores the previous unbounded behaviour (the rollback switch)', () => {
  const p = poolLimits({ MYSQL_QUEUE_LIMIT: '0' });
  assert.strictEqual(p.queueLimit, 0);
  assert.strictEqual(p.unbounded, true);
});

test('a malformed or hostile env value falls back to the bound instead of disabling it', () => {
  for (const bad of ['', '   ', 'abc', '-5', '1.5', 'NaN', 'Infinity', '0x10']) {
    const p = poolLimits({ MYSQL_QUEUE_LIMIT: bad });
    assert.strictEqual(p.queueLimit, DEFAULT_QUEUE_LIMIT, `"${bad}" must not change the limit`);
    assert.strictEqual(p.unbounded, false, `"${bad}" must not make the queue unbounded`);
  }
});

test('connectionLimit can never resolve below 1', () => {
  assert.strictEqual(poolLimits({ MYSQL_CONNECTION_LIMIT: '0' }).connectionLimit, 1);
});

test('saturation is told apart from ordinary failure', () => {
  assert.strictEqual(isPoolSaturationError(new Error('Queue limit reached.')), true);
  assert.strictEqual(isPoolSaturationError(Object.assign(new Error('x'), { code: 'ER_CON_COUNT_ERROR' })), true);
  assert.strictEqual(isPoolSaturationError(Object.assign(new Error('x'), { code: 'ER_TOO_MANY_USER_CONNECTIONS' })), true);

  // Must NOT be mistaken for saturation — these are real errors and deserve a real 500.
  assert.strictEqual(isPoolSaturationError(new Error('ER_PARSE_ERROR')), false);
  assert.strictEqual(isPoolSaturationError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
  assert.strictEqual(isPoolSaturationError(Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' })), false);
  assert.strictEqual(isPoolSaturationError(null), false);
  assert.strictEqual(isPoolSaturationError(undefined), false);
});

test('the adapter actually uses the policy rather than a hardcoded queueLimit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'mysqlAdapter.js'), 'utf8');
  assert.ok(/require\(['"]\.\/poolLimits['"]\)/.test(src),
    'mysqlAdapter must source its limits from db/poolLimits.js');
  // Comments are stripped first: the file explains the old `queueLimit: 0` in prose, and this
  // guard is about what the pool is actually CONFIGURED with.
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/queueLimit:\s*0\b/.test(code),
    'queueLimit: 0 is the unbounded queue this fix removes — it must not be hardcoded back.');
  assert.ok(/queueLimit:\s*limits\.queueLimit/.test(code),
    'the pool must take its queueLimit from the policy module');
});

test('saturation is answered with 503 + Retry-After, not a generic 500', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server-crm.js'), 'utf8');
  assert.ok(/isPoolSaturationError/.test(src),
    'the central error handler must recognise saturation so shedding is honest and retryable');
  assert.ok(/Retry-After/.test(src),
    'a shed request must tell the caller it is temporary');
});


/**
 * ROUTE-LEVEL SHEDDING. The central handler in server-crm.js only sees errors that REACH it, and
 * most routes catch their own: routes/admin/proxyTools.js alone has 41 catches that return a
 * hardcoded `500 { error: 'Failed to …' }`. A shed request inside one of those reads as a server
 * fault, so the caller cannot tell "retry in 5s" from "this is broken" — and a 500 invites an
 * immediate retry straight back into the saturation.
 */
test('respondIfDbBusy answers saturation with 503 + Retry-After and reports that it did', () => {
  const res = resDouble();
  const handled = respondIfDbBusy(new Error('Queue limit reached.'), res);
  assert.strictEqual(handled, true, 'the caller must know the response was already sent');
  assert.strictEqual(res.sent.status, 503);
  assert.strictEqual(res.sent.headers['Retry-After'], '5');
  assert.strictEqual(res.sent.body.code, 'DB_BUSY');
  assert.strictEqual(res.sent.body.retryAfter, 5);
});

test('respondIfDbBusy leaves a REAL error to the route, untouched', () => {
  for (const err of [new Error('ER_PARSE_ERROR'),
                     Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
                     Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' }),
                     null, undefined]) {
    const res = resDouble();
    assert.strictEqual(respondIfDbBusy(err, res), false);
    assert.strictEqual(res.sent.status, null, 'a genuine failure must keep its own 500');
    assert.strictEqual(res.sent.body, null);
  }
});

test('respondIfDbBusy never throws out of a catch block', () => {
  // Headers already sent: it must report false, not blow up the route's own error handling.
  const hostile = { set() { throw new Error('headers already sent'); }, status() { return this; }, json() { return this; } };
  assert.doesNotThrow(() => respondIfDbBusy(new Error('Queue limit reached.'), hostile));
  assert.strictEqual(respondIfDbBusy(new Error('Queue limit reached.'), hostile), false);
});

test('the polled routes shed honestly; the deliberate fail-safes are left alone', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  // These two answered 500 on any failure. They are polled constantly (every open client dashboard
  // hits /extension/version-info every 45s; the admin page hits agent-state every 30s).
  //
  // The call is checked against the ENCLOSING CATCH PARAMETER, not as a bare string. The first
  // version of this test matched /respondIfDbBusy\(e, res\)/ literally and happily passed while
  // the code said `respondIfDbBusy(e, res)` inside `} catch (err) {` — an unbound identifier that
  // would have thrown ReferenceError on the first real error, turning every failure on a polled
  // admin route into a crash. `node --check` cannot see that either: it is valid syntax.
  for (const file of ['routes/extension/index.js', 'routes/admin/proxyTools.js']) {
    const src = read(file);

    // EVERY call site must be checked, not merely the ones a lookbehind window happens to reach.
    // Two earlier versions of this guard were blind in different ways. A 400-character window
    // between `catch (X) {` and the call skipped the make-active site, which carries a longer
    // explanatory comment. A single lazy regex found both sites but paired each with the FIRST
    // catch in the file rather than the nearest one, reporting a false mismatch. So: find every
    // call site, then walk back to the catch that actually encloses it.
    const callSites = [...src.matchAll(/respondIfDbBusy\(\s*(\w+)\s*,\s*res\s*\)/g)];
    assert.ok(callSites.length > 0, `${file} must shed with 503 rather than report a 500`);

    const catches = [...src.matchAll(/catch\s*\(\s*(\w+)\s*\)\s*\{/g)]
      .map((m) => ({ at: m.index, name: m[1] }));

    for (const site of callSites) {
      const enclosing = catches.filter((c) => c.at < site.index).pop();
      assert.ok(enclosing,
        `${file}: respondIfDbBusy(${site[1]}, res) is not inside any catch block`);
      assert.strictEqual(site[1], enclosing.name,
        `${file}: respondIfDbBusy(${site[1]}, res) sits inside \`catch (${enclosing.name})\` — `
        + `${site[1]} is not bound there, so the first real error would throw ReferenceError `
        + 'instead of being handled');
    }
  }

  // NOT changed on purpose: /client/announcements and /client/extension-notice deliberately answer
  // a fail-safe 200 ("never break the dashboard"). Turning those into 503 would alter documented
  // behaviour rather than merely correcting a status code, so it is left for a separate decision.
  const profile = read('routes/client/profile.js');
  assert.match(profile, /fail-safe: never break the dashboard/,
    'the announcements fail-safe is intentional and must not be silently converted to 503');
});

/**
 * WHERE SATURATION ACTUALLY SURFACES — read out of db/mysqlAdapter.js, not assumed.
 *
 * The claim these tests pin is narrow and it matters for the operator-facing documentation: a
 * saturation error is NOT confined to the first query a route runs. It can be raised by ANY
 * `pool.query()`, which includes the one behind `document.save()`. That is what makes a 503 on a
 * state-changing route indeterminate rather than safe to retry.
 *
 * No failure path is invented here. The faults injected are exactly the errors mysql2 raises when
 * `connectionLimit`/`queueLimit` are reached or the server refuses the connection, delivered
 * through the adapter's own documented `__test.setPool` seam.
 */
const adapter = require('../db/mysqlAdapter');

function saturatedPool(err, { failAfter = 0 } = {}) {
  let seen = 0;
  return {
    calls: [],
    pool: {
      query: async function (sql, params = []) {
        this.calls = (this.calls || []).concat([{ sql, params }]);
        seen += 1;
        if (seen > failAfter) throw err;
        return [[]];
      },
    },
    get count() { return seen; },
  };
}

const SATURATION_FAULTS = [
  Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' }),
  Object.assign(new Error('User already has more than max_user_connections'), { code: 'ER_TOO_MANY_USER_CONNECTIONS' }),
  Object.assign(new Error('User has exceeded the max_connections resource'), { code: 'ER_USER_LIMIT_REACHED' }),
  new Error('Queue limit reached.'),
];

test('ADAPTER: a saturation error propagates from any query, unretried', async () => {
  const Model = adapter.createModel('PoolSatProbe', {});
  try {
    for (const fault of SATURATION_FAULTS) {
      const fake = saturatedPool(fault);
      adapter.__test.setPool(fake.pool);
      await assert.rejects(() => Model.findOne({ _id: 'x' }).exec(), (e) => e === fault,
        `${fault.code || fault.message} must reach the caller unchanged`);
      // One attempt only: saturation is not a dead socket, so the adapter's single
      // dead-connection retry must not apply to it or the pool is hit twice per request.
      assert.strictEqual(fake.count, 1,
        `${fault.code || fault.message} must NOT be retried — retrying a shed request doubles the `
        + 'load that caused the shedding');
      assert.ok(isPoolSaturationError(fault),
        'this fault must also be the one the route classifier recognises, or the two disagree');
    }
  } finally { adapter.__test.setPool(null); }
});

test('ADAPTER: document.save() runs through the same query layer, so it can be shed too', async () => {
  // This is the fact the capture document depends on: `await account.save()` is not immune to
  // saturation, so a 503 from a route whose catch wraps its saves cannot mean "nothing was tried".
  const Model = adapter.createModel('PoolSatSaveProbe', {});
  const fault = Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' });
  try {
    const fake = saturatedPool(fault);
    adapter.__test.setPool(fake.pool);
    const doc = new Model.Document(Model, { _id: 'probe1', state: 'before' });
    doc.state = 'after';
    await assert.rejects(() => doc.save(), (e) => e === fault,
      'save() must surface the saturation error rather than swallowing it');
    assert.strictEqual(fake.count, 1, 'the write must not be retried into a saturated pool');
  } finally { adapter.__test.setPool(null); }
});

test('ADAPTER: a dropped idle connection IS still retried once (unchanged behaviour)', async () => {
  // The existing one-shot retry must survive the above: it is what fixed the intermittent
  // "Login failed" 500s. Only saturation is excluded from it.
  const Model = adapter.createModel('PoolDeadConnProbe', {});
  try {
    const dead = Object.assign(new Error('Connection lost: The server closed the connection.'),
      { code: 'PROTOCOL_CONNECTION_LOST' });
    const fake = saturatedPool(dead, { failAfter: 0 });
    let seen = 0;
    adapter.__test.setPool({
      query: async () => { seen += 1; if (seen === 1) throw dead; return [[]]; },
    });
    await Model.findOne({ _id: 'x' }).exec();
    assert.strictEqual(seen, 2, 'a dead pooled socket must still get its single retry');
    assert.ok(!isPoolSaturationError(dead),
      'a dead connection must not be classified as saturation, or it would be shed as 503');
    void fake;
  } finally { adapter.__test.setPool(null); }
});

test('ADAPTER: the pushdown fallback must not escalate a shed query into a full scan', async () => {
  // Found by the test above. _candidateRows and countDocuments swallow a failed fast-path query
  // and fall back to reading the whole table. That fallback is for servers that cannot RUN the
  // optimised SQL (no generated column, no JSON functions) — never for a pool that had no
  // connection to give. Absorbing saturation there turns one shed PK lookup into a second,
  // far more expensive query against the database that was already the bottleneck.
  const Model = adapter.createModel('PoolSatFallbackProbe', {});
  try {
    for (const fault of SATURATION_FAULTS) {
      for (const criteria of [{ _id: 'x' }, { _id: { $in: ['x', 'y'] } }, { tool: 'writehuman' }]) {
        const fake = saturatedPool(fault);
        adapter.__test.setPool(fake.pool);
        await assert.rejects(() => Model.findOne(criteria).exec(), (e) => e === fault);
        assert.strictEqual(fake.count, 1,
          `${JSON.stringify(criteria)} / ${fault.code || fault.message}: the shed query must `
          + 'surface, not trigger a full-table-scan fallback onto the same saturated pool');
      }
      const fake = saturatedPool(fault);
      adapter.__test.setPool(fake.pool);
      await assert.rejects(() => Model.countDocuments({}), (e) => e === fault);
      assert.strictEqual(fake.count, 1,
        'countDocuments must not answer a shed COUNT(*) by loading every row to count in JS');
    }
  } finally { adapter.__test.setPool(null); }
});

test('ADAPTER: the unsupported-SQL fallback still works (the guard is saturation-only)', async () => {
  // The guard must not break the compatibility path it sits in: an old MariaDB without JSON
  // functions, or a missing generated column, must STILL fall back to the full scan.
  const Model = adapter.createModel('PoolSatCompatProbe', {});
  try {
    let calls = 0;
    adapter.__test.setPool({
      query: async (sql) => {
        calls += 1;
        if (/JSON_EXTRACT|WHERE `?tool/.test(sql)) throw new Error('FUNCTION JSON_EXTRACT does not exist');
        return [[{ data: JSON.stringify({ _id: 'r1', tool: 'writehuman' }) }]];
      },
    });
    const found = await Model.findOne({ tool: 'writehuman' }).exec();
    assert.ok(found && found._id === 'r1', 'the full-scan fallback must still answer the query');
    assert.ok(calls >= 2, 'the fallback must have been taken, not short-circuited by the guard');
  } finally { adapter.__test.setPool(null); }
});

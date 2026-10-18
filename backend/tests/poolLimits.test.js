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
  poolLimits, isPoolSaturationError, DEFAULT_QUEUE_LIMIT, DEFAULT_CONNECTION_LIMIT,
} = require('../db/poolLimits');

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

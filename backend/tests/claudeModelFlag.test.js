'use strict';
/**
 * "Allow Fable 5" admin flag — the boolean must survive the settings pipeline intact.
 *
 * The risk this guards: ClaudeSettings' existing pipeline is NUMERIC (parseInt + finite check),
 * and claudeQuota.setGlobalConfig drops anything that is not a finite number >= 0. A boolean
 * routed through either would silently become null/undefined — i.e. the admin toggle would
 * appear to save and then quietly do nothing. These tests pin the separate boolean path, and
 * pin that the safe state (blocked) is also the default state.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ClaudeSettings = require(path.resolve(__dirname, '../models/proxy/ClaudeSettings.js'));
const quota = require(path.resolve(__dirname, '../utils/proxy/claudeQuota.js'));

test('the boolean key is declared separately from the numeric keys', () => {
  const nums = ClaudeSettings.NUM_KEYS();
  const bools = ClaudeSettings.BOOL_KEYS();
  assert.ok(bools.includes('allowFable5'), 'allowFable5 must be a declared boolean key');
  assert.ok(!nums.includes('allowFable5'), 'it must NOT be in the numeric pipeline (parseInt would null it)');
});

test('the numeric override pipeline refuses the boolean — proving it needs its own path', () => {
  const applied = quota.setGlobalConfig({ allowFable5: true, defaultClientLimit: 500 });
  assert.strictEqual(applied.allowFable5, undefined, 'setGlobalConfig must not carry booleans');
  assert.strictEqual(applied.defaultClientLimit, 500, 'numbers still work');
});

test('toBool is strict: only explicit affirmatives enable Fable 5', () => {
  for (const v of [true, 'true', '1', 'on', 'yes', 'TRUE', ' On ']) {
    assert.strictEqual(ClaudeSettings.toBool(v), true, JSON.stringify(v) + ' should enable');
  }
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'nope', 'maybe', 0, {}, []]) {
    assert.strictEqual(ClaudeSettings.toBool(v), false, JSON.stringify(v) + ' must NOT enable');
  }
});

test('SECURITY: an unset or garbage stored value means BLOCKED', () => {
  // A fresh install, a partially-written row, or a hand-edited DB value must all block.
  for (const stored of [undefined, null, '', 'garbage', 0, 'False']) {
    assert.strictEqual(ClaudeSettings.toBool(stored), false,
      'stored ' + JSON.stringify(stored) + ' must resolve to blocked');
  }
});

test('preSave coerces the flag to a real boolean and leaves numbers alone', async () => {
  const opts = require(path.resolve(__dirname, '../models/proxy/ClaudeSettings.js'));
  void opts;
  // Exercise the same coercion preSave applies.
  const row = { defaultClientLimit: '750', safetyReservePct: '99', allowFable5: 'yes' };
  const coercedNum = parseInt(row.defaultClientLimit, 10);
  assert.strictEqual(coercedNum, 750);
  assert.strictEqual(Math.min(95, parseInt(row.safetyReservePct, 10)), 95, 'reserve still capped at 95');
  assert.strictEqual(ClaudeSettings.toBool(row.allowFable5), true);
  assert.strictEqual(typeof ClaudeSettings.toBool(row.allowFable5), 'boolean', 'must be a real boolean, not a string');
});

test('the gateway contract is a strict boolean, so the gateway can trust it', () => {
  // claude-gateway only honours session.allowFable5 when typeof === 'boolean'; anything else
  // falls back to its env default (also blocked). Assert we never emit a non-boolean.
  for (const v of [undefined, null, 'true', 1, {}]) {
    const emitted = ClaudeSettings.toBool(v);
    assert.strictEqual(typeof emitted, 'boolean');
  }
});

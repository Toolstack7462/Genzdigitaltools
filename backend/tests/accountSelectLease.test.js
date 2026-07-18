'use strict';
/**
 * Tests for accountSelect.activeLeaseAccount — the DISPLAY-only picker that makes the admin table
 * and client card show the same account the client is actively leased/metered against (matching the
 * live overlay widget), rather than a fresh re-selection. Pure, no DB.
 * Run: node --test tests/accountSelectLease.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeLeaseAccount } = require('../utils/proxy/accountSelect');

const accounts = [{ _id: 'A1' }, { _id: 'A2' }, { _id: 'A3' }];
const NOW = new Date('2026-07-18T12:00:00.000Z').getTime();
const future = '2026-07-18T12:30:00.000Z';
const past = '2026-07-18T11:30:00.000Z';

test('returns the account of the current active lease', () => {
  const leases = [{ accountId: 'A2', revoked: false, expiresAt: future, createdAt: '2026-07-18T11:59:00.000Z' }];
  assert.equal(activeLeaseAccount(leases, accounts, NOW)._id, 'A2');
});

test('ignores revoked and expired leases', () => {
  const leases = [
    { accountId: 'A1', revoked: true, expiresAt: future, createdAt: past },   // revoked
    { accountId: 'A3', revoked: false, expiresAt: past, createdAt: past },     // expired
  ];
  assert.equal(activeLeaseAccount(leases, accounts, NOW), null);
});

test('picks the MOST RECENT active lease when there are several', () => {
  const leases = [
    { accountId: 'A1', revoked: false, expiresAt: future, createdAt: '2026-07-18T10:00:00.000Z' },
    { accountId: 'A3', revoked: false, expiresAt: future, createdAt: '2026-07-18T11:55:00.000Z' }, // newest
    { accountId: 'A2', revoked: false, expiresAt: future, createdAt: '2026-07-18T11:00:00.000Z' },
  ];
  assert.equal(activeLeaseAccount(leases, accounts, NOW)._id, 'A3');
});

test('returns null when the active lease account is not in the accounts list (deleted)', () => {
  const leases = [{ accountId: 'GONE', revoked: false, expiresAt: future, createdAt: past }];
  assert.equal(activeLeaseAccount(leases, accounts, NOW), null);
});

test('returns null on empty / malformed input (caller falls back to fresh selection)', () => {
  assert.equal(activeLeaseAccount([], accounts, NOW), null);
  assert.equal(activeLeaseAccount(null, accounts, NOW), null);
  assert.equal(activeLeaseAccount([{ revoked: false, expiresAt: future }], accounts, NOW), null); // no accountId
});

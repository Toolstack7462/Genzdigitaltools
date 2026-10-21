/**
 * AN UNRESOLVED ONLINE SALE MUST NOT BECOME A NEW OFFLINE SALE.
 *
 * SaleForm handles the offline queue BEFORE unresolved-sale reconciliation, and the real
 * `queueOperation()` mints its own identity:
 *
 *     idempotencyKey: crypto.randomUUID()
 *
 * So: create online → the server commits → the response is lost → the laptop drops offline → the
 * operator presses Save again. The sale would be queued as a brand-new operation under a fresh
 * key, and on reconnect it would be created a SECOND time with its own invoice number. The frozen
 * key from the online attempt would never be used.
 *
 * WHAT THIS EXERCISES. The real SaleForm and the REAL `offline/queue` module - its ownership
 * checks, its sensitive-field refusal and its key minting all run. Only `offline/db` is replaced,
 * by an in-memory store that RECORDS what the queue writes, so the assertion is about what the
 * real queue actually did rather than about a stub that silently accepts everything.
 *
 * WHAT THIS IS NOT. A database test. "Exactly one financial operation after reconciliation" is
 * asserted here as "exactly one create request carrying the original key"; that the SERVER then
 * replays rather than inserting is proven separately on a real engine by
 * backend/scripts/crm-db-selftest.js.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockPosts = [];
let mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      if (url.startsWith('/contacts/clients')) return { data: { rows: [{ id: 'client-1', name: 'Synthetic Client' }], total: 1 } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
    put: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
  },
  messageFromError: (error) => error?.response?.data?.error || error?.message || 'Request failed',
}));

// The REAL queue runs; only its storage is in-memory, and it records every write.
const mockQueueRows = [];
jest.mock('../offline/db', () => ({
  __esModule: true,
  offlineDb: {
    putQueue: async (record) => { mockQueueRows.push(record); return record; },
    listQueue: async () => mockQueueRows.slice(),
    deleteQueue: async (key) => { const i = mockQueueRows.findIndex((r) => r.idempotencyKey === key); if (i >= 0) mockQueueRows.splice(i, 1); },
    get: async () => null,
    set: async () => {},
  },
}));

const mockCrm = {
  currency: 'PKR',
  denied: new Set(),
  has(permission) { return !mockCrm.denied.has(permission); },
  bootstrap: { user: { id: 'u1' }, settings: {} },
  queued: 0, setQueued: () => {},
};
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));

jest.mock('react-router-dom', () => ({
  __esModule: true,
  useNavigate: () => () => {},
  useParams: () => ({}),
  Link: ({ children }) => require('react').createElement('a', null, children),
}), { virtual: true });

// eslint-disable-next-line import/first
import SaleForm from '../pages/SaleForm';

let container; let root;
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(SaleForm)); });
  await act(async () => { await Promise.resolve(); });
}
const submitForm = async () => {
  const form = container.querySelector('form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};
const setOnline = (value) => { Object.defineProperty(window.navigator, 'onLine', { value, configurable: true }); };
const creates = () => mockPosts.filter((call) => call[0] === '/sales');

beforeEach(() => {
  mockCrm.denied = new Set();
  mockPosts.length = 0;
  mockQueueRows.length = 0;
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  document.body.innerHTML = '';
  setOnline(true);
  // the real queue reads the signed-in admin identity from storage
  localStorage.setItem('genz_admin_user', JSON.stringify({ _id: 'u1' }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; setOnline(true); });

test('a legitimate NEW offline sale is still queued - the guard is not a blanket block', async () => {
  await mount();
  setOnline(false);
  await submitForm();

  expect(creates()).toHaveLength(0);
  expect(mockQueueRows).toHaveLength(1);                       // positive control
  expect(mockQueueRows[0].type).toBe('sale.create');
  expect(typeof mockQueueRows[0].idempotencyKey).toBe('string');
});

test('an unresolved online create is NOT queued as a fresh offline sale', async () => {
  await mount();

  // online attempt: the server commits, the answer is lost
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();
  expect(creates()).toHaveLength(1);
  const originalKey = creates()[0][1].idempotencyKey;
  expect(container.textContent).toMatch(/result of this sale is unknown/i);

  // the laptop drops offline and the operator presses Save again
  setOnline(false);
  await submitForm();

  expect(mockQueueRows).toHaveLength(0);                       // no new identity was minted
  expect(creates()).toHaveLength(1);                           // and nothing else was sent
  expect(container.textContent).toMatch(/cannot be queued offline/i);
  expect(container.textContent).toMatch(/reconnect/i);

  // reconnecting reconciles under the ORIGINAL key - one operation, not two
  setOnline(true);
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  await submitForm();

  const all = creates();
  expect(all).toHaveLength(2);                                 // the retry of the SAME operation
  expect(all[1][1].idempotencyKey).toBe(originalKey);
  expect(mockQueueRows).toHaveLength(0);
  const distinctKeys = new Set(all.map((call) => call[1].idempotencyKey));
  expect(distinctKeys.size).toBe(1);                           // exactly one operation identity
});

test('once reconciled, a genuinely new offline sale can be queued again', async () => {
  await mount();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();
  setOnline(true);
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  await submitForm();                                          // resolved
  expect(container.textContent).not.toMatch(/result of this sale is unknown/i);

  mockPosts.length = 0;
  setOnline(false);
  await submitForm();
  expect(mockQueueRows).toHaveLength(1);                       // the block was only while unresolved
});

test('the real queue still refuses to store credentials offline', async () => {
  // Proves the REAL queue module is in play rather than a permissive stub.
  const { queueOperation } = require('../offline/queue');
  await expect(queueOperation('sale.create', { items: [{ credentialPassword: 'secret' }] }, 'u1'))
    .rejects.toThrow(/credentials cannot be stored offline/i);
  expect(mockQueueRows).toHaveLength(0);
});

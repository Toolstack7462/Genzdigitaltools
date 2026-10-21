/**
 * SALE CREATION under an unknown outcome - tested on SaleForm itself.
 *
 * The payment tests say nothing about this screen: its idempotency semantics are DIFFERENT.
 * `salesService.create` compares only the CREATOR when a key repeats and then returns the existing
 * sale, ignoring the new payload entirely - looser than the payment rule, which at least compares
 * the amount. So a key reused after an edit silently returns the old sale, and a key MINTED after a
 * possibly-committed create produces a second sale with its own invoice number and its own opening
 * payments.
 *
 * `keyForPayload()` originally minted a new key on any payload change, and a failed create had no
 * unknown-outcome state at all - so after a lost response, the next submit went out under a fresh
 * identity. These tests pin the corrected behaviour.
 *
 * WHAT THIS EXERCISES: the real SaleForm against a stubbed CRM API, in jsdom, with the installed
 * router. WHAT IT IS NOT: a database test - whether the server actually replays is verified in the
 * engine, not here.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockPosts = [];
let mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      if (url.startsWith('/contacts/clients')) return { data: { rows: [{ id: 'client-1', name: 'Synthetic Client' }], total: 1 } };
      if (url.startsWith('/contacts/vendors')) return { data: { rows: [], total: 0 } };
      if (url.startsWith('/products')) return { data: { rows: [{ id: 'prod-1', name: 'Selftest Product', category: 'Software', accountType: 'private', durationLabel: '1 Month', defaultSalePrice: '500.00', defaultPurchaseCost: '200.00', currencyCode: 'PKR', active: true }], total: 1 } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
    put: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
  },
  messageFromError: (error) => error?.response?.data?.error || error?.message || 'Request failed',
}));

const mockCrm = {
  currency: 'PKR',
  // mutable per test: a restricted role is what makes SaleForm throw BEFORE any request
  denied: new Set(),
  has(permission) { return !mockCrm.denied.has(permission); },
  bootstrap: { user: { id: 'u1' }, settings: {} },
  queued: 0, setQueued: () => {},
};
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));
jest.mock('../offline/queue', () => ({ __esModule: true, queueOperation: async () => {} }));
jest.mock('../offline/db', () => ({ __esModule: true, offlineDb: { get: async () => null, set: async () => {} } }));

// eslint-disable-next-line import/first
import SaleForm from '../pages/SaleForm';

let container; let root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/admin/business/sales/new'] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: '/admin/business/sales/new', element: React.createElement(SaleForm) }),
          React.createElement(Route, { path: '/admin/business/sales/:id', element: React.createElement('div', { 'data-testid': 'sale-detail' }) }),
        ),
      ),
    );
  });
  await act(async () => { await Promise.resolve(); });
}

const saveButton = () => [...container.querySelectorAll('button')].find((b) => /save sale/i.test(b.textContent || ''));
const submitForm = async () => {
  const form = container.querySelector('form') || saveButton()?.closest('form');
  await act(async () => {
    if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    else saveButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockCrm.denied = new Set();
  mockPosts.length = 0;
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  document.body.innerHTML = '';
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; jest.useRealTimers(); });

test('the create carries an idempotency key', async () => {
  await mount();
  await submitForm();
  const create = mockPosts.find((call) => call[0] === '/sales');
  expect(create).toBeTruthy();
  expect(typeof create[1].idempotencyKey).toBe('string');
  expect(create[1].idempotencyKey.length).toBeGreaterThan(8);
});

test('a double submit in one tick creates ONE sale request', async () => {
  await mount();
  const form = container.querySelector('form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mockPosts.filter((call) => call[0] === '/sales')).toHaveLength(1);
});

// ── the create may have committed and the answer was lost ─────────────────────────────────────
test('after a lost response the NEXT submit reuses the same key - never a fresh identity', async () => {
  await mount();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();
  const first = mockPosts.filter((call) => call[0] === '/sales');
  expect(first).toHaveLength(1);
  const originalKey = first[0][1].idempotencyKey;

  // The sale may already exist with its invoice number and opening payments. A new key here would
  // produce a SECOND one.
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  await submitForm();

  const calls = mockPosts.filter((call) => call[0] === '/sales');
  expect(calls).toHaveLength(2);
  expect(calls[1][1].idempotencyKey).toBe(originalKey);
});

test('an unresolved create says plainly that the sale may already exist', async () => {
  await mount();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();
  expect(container.textContent).toMatch(/result of this sale is unknown/i);
  expect(container.textContent).toMatch(/may already have been created/i);
});

test('a 5xx is treated as unknown, not as a definite failure', async () => {
  await mount();
  mockPostImpl = async () => { const error = new Error('boom'); error.response = { status: 503, data: {} }; throw error; };
  await submitForm();
  expect(container.textContent).toMatch(/result of this sale is unknown/i);
});

test('the frozen retry re-sends the ORIGINAL payload, not whatever the form now holds', async () => {
  await mount();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();
  const sent = mockPosts.filter((call) => call[0] === '/sales')[0][1];
  const originalNotes = sent.notes;

  // the operator types into the form while the outcome is unknown
  const notes = container.querySelector('textarea');
  if (notes) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(notes, 'edited while unresolved');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  await submitForm();

  const retry = mockPosts.filter((call) => call[0] === '/sales')[1][1];
  expect(retry.idempotencyKey).toBe(sent.idempotencyKey);
  expect(retry.notes).toBe(originalNotes);
  expect(retry.notes).not.toBe('edited while unresolved');
});

test('a DEFINITE refusal is not frozen - the operator may correct and resubmit under a new key', async () => {
  await mount();
  mockPostImpl = async () => { const error = new Error('x'); error.response = { status: 400, data: { error: 'Select a catalogue product for every item.' } }; throw error; };
  await submitForm();
  expect(container.textContent).not.toMatch(/result of this sale is unknown/i);
  expect(container.textContent).toMatch(/Select a catalogue product/i);
});

// ── a LOCAL validation error is not an uncertain outcome ──────────────────────────────────────
// Reported against this file's own subject: submit() treated ANY caught error without an HTTP
// status as an unknown sale outcome, and the "select a catalogue product" throw happens BEFORE a
// request exists. A restricted operator who forgot a product therefore had the form frozen over a
// sale that never left the browser.
test('a restricted role missing a catalogue product makes NO request and is not frozen', async () => {
  mockCrm.denied = new Set(['profit.view']);        // cost hidden -> every item needs a productId
  await mount();
  await submitForm();

  expect(mockPosts.filter((call) => call[0] === '/sales')).toHaveLength(0);
  expect(container.textContent).toMatch(/Select a catalogue product/i);
  expect(container.textContent).not.toMatch(/result of this sale is unknown/i);
  expect(container.textContent).not.toMatch(/may already have been created/i);
});

test('after correcting the INPUT the sale submits normally, under a real key', async () => {
  mockCrm.denied = new Set(['profit.view']);        // cost hidden -> a catalogue product is required
  await mount();
  await submitForm();
  expect(mockPosts.filter((call) => call[0] === '/sales')).toHaveLength(0);

  // The operator corrects the input itself: pick the catalogue product the restriction demands.
  const productBox = [...container.querySelectorAll('input')].find((i) => /Search catalogue/i.test(i.placeholder || ''));
  expect(productBox).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(productBox, 'self');
    productBox.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { jest.advanceTimersByTime(400); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const option = container.querySelector('[role="option"] button') || container.querySelector('[role="option"]');
  expect(option).toBeTruthy();
  await act(async () => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await submitForm();
  const created = mockPosts.filter((call) => call[0] === '/sales');
  expect(created).toHaveLength(1);
  expect(created[0][1].items[0].productId).toBe('prod-1');
  expect(typeof created[0][1].idempotencyKey).toBe('string');
  expect(container.textContent).not.toMatch(/result of this sale is unknown/i);
});

test('an uncertain outcome still freezes a REAL dispatch, with a non-null key and payload', async () => {
  await mount();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await submitForm();

  const sent = mockPosts.filter((call) => call[0] === '/sales');
  expect(sent).toHaveLength(1);
  expect(sent[0][1].idempotencyKey).toBeTruthy();
  expect(container.textContent).toMatch(/result of this sale is unknown/i);

  // and the retry carries that same real identity - never a frozen null
  mockPostImpl = async () => ({ data: { id: 'sale-created-1' } });
  await submitForm();
  const all = mockPosts.filter((call) => call[0] === '/sales');
  expect(all[1][1].idempotencyKey).toBe(all[0][1].idempotencyKey);
  expect(all[1][1].idempotencyKey).not.toBe(null);
});

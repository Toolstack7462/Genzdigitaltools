/**
 * COMMERCIAL CONFIRMATION on the Products screen.
 *
 * The server decides whether an imported product's price is zero. That sounds like a detail and is
 * the whole point: while a product is NEEDS_SETUP the API deliberately returns its price as null,
 * so this screen genuinely cannot tell "intentionally free" from "not priced yet". The first
 * version read that null as 0 and therefore sent `confirmFree: true` on EVERY confirmation, which
 * silently removed the explicit-free check the server was relying on it to carry.
 *
 * It now confirms without claiming anything, and only asks the operator when the server answers
 * PRICE_NOT_CONFIRMED. It also sends the product `version`, so a confirmation made against values
 * someone else has since edited is refused rather than applied.
 *
 * WHAT THIS EXERCISES: the real Products page against a stubbed CRM API in jsdom. WHAT IT IS NOT:
 * proof of the server's behaviour - the version guard and the confirmation race are verified
 * against a real database in backend/scripts/crm-catalogue-db-selftest.js.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

const NEEDS_SETUP_ROW = {
  id: 'prod-imported-1',
  name: 'Imported Writer',
  category: 'Writing',
  account_type: null,
  duration_label: null,
  default_sale_price: null,      // blanked by the API while NEEDS_SETUP - this is the trap
  default_purchase_cost: null,
  currency_code: null,
  active: 1,
  notes: null,
  version: 7,
  commercialDetailsConfirmed: false,
  source: {
    namespace: 'WEBSITE_TOOL', readiness: 'NEEDS_SETUP', availability: 'AVAILABLE',
    ignored: false, nameOverridden: false, lastSeenAt: null, sellable: false,
  },
};

const mockPosts = [];
let mockPostImpl = async () => ({ data: {} });

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      if (url.startsWith('/products/catalogue/status')) {
        return { data: { fresh: true, lastRunAt: '2026-10-22T10:00:00Z', linked: 1, needsSetup: 1 } };
      }
      if (url.startsWith('/products')) return { data: { rows: [NEEDS_SETUP_ROW], total: 1, page: 1, pageSize: 100 } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
  },
  codeFromError: (error) => error?.response?.data?.code || '',
  messageFromError: (error) => error?.response?.data?.error || error?.message || 'Request failed',
}));

const mockCrm = {
  currency: 'PKR',
  denied: new Set(),
  has(permission) { return !mockCrm.denied.has(permission); },
  bootstrap: { user: { id: 'u1' }, settings: {} },
  queued: 0, setQueued: () => {},
};
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));

// eslint-disable-next-line import/first
import Products from '../pages/Products';

let container; let root; let confirmAnswer; let confirmPrompts;

const refusal = (code, message) => {
  const error = new Error(message || code);
  error.response = { status: code === 'PRICE_NOT_CONFIRMED' ? 422 : 409, data: { code, error: message || code } };
  return error;
};

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(Products)); });
}

function clickConfirmDetails() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => /Confirm details/i.test(b.textContent));
  if (!button) throw new Error('the "Confirm details" action is not on the screen');
  return act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  mockPosts.length = 0;
  mockPostImpl = async () => ({ data: {} });
  mockCrm.denied = new Set();
  confirmAnswer = true;
  confirmPrompts = [];
  window.confirm = (message) => { confirmPrompts.push(message); return confirmAnswer; };
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  if (container) container.remove();
  root = null; container = null;
});

const confirmCalls = () => mockPosts.filter(([url]) => url.includes('/catalogue/confirm-ready'));

test('a confirmation carries the product version and claims nothing about the price', async () => {
  await mount();
  await clickConfirmDetails();
  const calls = confirmCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('/products/prod-imported-1/catalogue/confirm-ready');
  expect(calls[0][1]).toEqual({ confirmFree: false, version: 7 });
  expect(confirmPrompts).toHaveLength(0);
});

test('a zero price is only confirmed free after the SERVER says so and the operator agrees', async () => {
  let attempt = 0;
  mockPostImpl = async (url) => {
    if (!url.includes('confirm-ready')) return { data: {} };
    attempt += 1;
    if (attempt === 1) throw refusal('PRICE_NOT_CONFIRMED', 'Set a sale price, or confirm explicitly that this product is free');
    return { data: { readiness: 'READY', confirmedFree: true } };
  };
  await mount();
  await clickConfirmDetails();
  const calls = confirmCalls();
  expect(calls.map(([, body]) => body)).toEqual([
    { confirmFree: false, version: 7 },
    { confirmFree: true, version: 7 },
  ]);
  expect(confirmPrompts).toHaveLength(1);
  expect(confirmPrompts[0]).toMatch(/intentionally FREE/i);
});

test('declining the free prompt sends nothing further', async () => {
  confirmAnswer = false;
  mockPostImpl = async (url) => {
    if (!url.includes('confirm-ready')) return { data: {} };
    throw refusal('PRICE_NOT_CONFIRMED');
  };
  await mount();
  await clickConfirmDetails();
  expect(confirmCalls()).toHaveLength(1);
  expect(confirmPrompts).toHaveLength(1);
});

test('any OTHER refusal is surfaced and never retried as a free confirmation', async () => {
  // This is the case the old code could not reach: with the price read as 0 it sent confirmFree on
  // the first attempt, so a VERSION_CONFLICT could never be distinguished from a free product.
  mockPostImpl = async (url) => {
    if (!url.includes('confirm-ready')) return { data: {} };
    throw refusal('VERSION_CONFLICT', 'This product changed while you were confirming it');
  };
  await mount();
  await clickConfirmDetails();
  expect(confirmCalls()).toHaveLength(1);
  expect(confirmCalls()[0][1]).toEqual({ confirmFree: false, version: 7 });
  expect(confirmPrompts).toHaveLength(0);
  expect(container.textContent).toMatch(/changed while you were confirming/i);
});

test('an unconfirmed product is labelled and its placeholder money is not shown as a value', async () => {
  await mount();
  expect(container.textContent).toMatch(/Needs setup/);
  expect(container.textContent).not.toMatch(/0\.00/);
});

test('a products.view-only viewer triggers no catalogue write at all', async () => {
  mockCrm.denied = new Set(['products.manage', 'profit.view']);
  await mount();
  expect(mockPosts).toHaveLength(0);
});

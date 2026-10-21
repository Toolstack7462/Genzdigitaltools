/**
 * QUICK-CREATE: "Create new client" -> "Save and select", inside the real sale form.
 *
 * This was previously only source-scanned, which is not evidence. These drive the actual modal and
 * the actual contact-create contract, and assert the things that would hurt an operator: a lost
 * sale draft, a duplicate contact, or the parent sale being submitted by accident.
 *
 * WHAT THIS EXERCISES: the real SaleForm + Combobox + Modal against a stubbed CRM API, in jsdom.
 * WHAT IT IS NOT: live authenticated acceptance, and not proof of server-side contact idempotency
 * (the create route's own replay behaviour is a separate, unverified question - see the report).
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockGets = [];
const mockPosts = [];
let mockDetail = {};
let mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'New Client', whatsapp: '03000000000', company: 'Fresh Co' } });

const CLIENTS = [{ id: 'cA', name: 'Ali Raza', whatsapp: '03001234567', email: 'ali@example.test', company: 'Raza Traders' }];

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      mockGets.push(url);
      const detail = /^\/contacts\/clients\/([a-zA-Z0-9]+)$/.exec(url);
      if (detail) {
        const entry = mockDetail[detail[1]];
        if (!entry) return { data: { totals: [] } };
        if (entry.promise) return entry.promise;
        return { data: entry };
      }
      if (url.startsWith('/contacts/clients')) return { data: { rows: CLIENTS, total: CLIENTS.length } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => {
      mockPosts.push(args);
      if (args[0] === '/contacts/clients') return mockCreateImpl(...args);
      return Promise.resolve({ data: { id: 'sale-1' } });
    },
    put: (...args) => { mockPosts.push(args); return Promise.resolve({ data: { id: 'sale-1' } }); },
  },
  messageFromError: (error) => error?.response?.data?.error || error?.message || 'Request failed',
}));

const mockCrm = {
  currency: 'PKR', denied: new Set(),
  has(permission) { return !mockCrm.denied.has(permission); },
  bootstrap: { user: { id: 'u1' }, settings: {} },
  queued: 0, setQueued: () => {},
};
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));
jest.mock('../offline/queue', () => ({ __esModule: true, queueOperation: async () => {} }));
jest.mock('../offline/db', () => ({ __esModule: true, offlineDb: { get: async () => null, set: async () => {}, putCache: async () => {} } }));

// eslint-disable-next-line import/first
import SaleForm from '../pages/SaleForm';

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

let container; let root;
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ['/admin/business/sales/new'] }, React.createElement(SaleForm)));
  });
  await act(async () => { await Promise.resolve(); });
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };
const summary = () => container.querySelector('.bcrm-clientsum');
const modal = () => container.querySelector('.bcrm-modal');
const modalButton = (re) => [...(modal() ? modal().querySelectorAll('button') : [])].find((b) => re.test(b.textContent || ''));
const saleCreates = () => mockPosts.filter((call) => call[0] === '/sales');
const contactCreates = () => mockPosts.filter((call) => call[0] === '/contacts/clients');

const setInput = async (element, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const setTextarea = async (element, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

async function typeDraft(text) {
  const notes = container.querySelector('textarea');
  if (notes) await setTextarea(notes, text);
  return notes;
}
// "Create new client" is the client Combobox's FOOTER, so it only exists while that dropdown is
// open. Opening it is part of the real operator path, not a test shortcut.
async function openQuickCreate() {
  const widget = container.querySelectorAll('.bcrm-combo')[0];
  const reopen = widget.querySelector('.bcrm-combo-value');
  if (reopen) await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const box = widget.querySelector('input[role="combobox"]');
  await act(async () => { box.dispatchEvent(new MouseEvent('focus', { bubbles: true })); });
  await setInput(box, 'zzz-no-match');
  await advance(300);
  await flush();

  const trigger = [...widget.querySelectorAll('button')].find((b) => /create new client/i.test(b.textContent || ''));
  if (!trigger) throw new Error('no quick-create trigger; buttons: ' + [...widget.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).join(' | '));
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

async function pickExistingClient(text) {
  const widget = container.querySelectorAll('.bcrm-combo')[0];
  const reopen = widget.querySelector('.bcrm-combo-value');
  if (reopen) await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await setInput(widget.querySelector('input[role="combobox"]'), text);
  await advance(300);
  await flush();
  const node = [...widget.querySelectorAll('[role="option"]')].find((n) => (n.textContent || '').includes(text));
  const button = node.querySelector('button') || node;
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGets.length = 0; mockPosts.length = 0;
  mockDetail = {};
  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'New Client', whatsapp: '03000000000', company: 'Fresh Co' } });
  mockCrm.denied = new Set();
  document.body.innerHTML = '';
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; jest.useRealTimers(); });

test('the quick-create trigger opens a modal without submitting the sale', async () => {
  await mount();
  await openQuickCreate();
  expect(modal()).toBeTruthy();
  expect(saleCreates()).toHaveLength(0);
});

test('cancelling preserves the sale draft', async () => {
  await mount();
  await typeDraft('draft worth keeping');
  await openQuickCreate();
  await act(async () => { modalButton(/cancel/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  expect(modal()).toBeFalsy();
  expect(container.querySelector('textarea').value).toBe('draft worth keeping');
  expect(saleCreates()).toHaveLength(0);
});

test('a failed create keeps the typed values and submits no sale', async () => {
  await mount();
  await typeDraft('draft worth keeping');
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'Broken Client');
  mockCreateImpl = async () => { const error = new Error('x'); error.response = { status: 409, data: { error: 'A client with that name already exists' } }; throw error; };

  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  expect(modal()).toBeTruthy();
  expect(modal().querySelector('input').value).toBe('Broken Client');
  expect(modal().textContent).toMatch(/already exists/i);
  expect(container.querySelector('textarea').value).toBe('draft worth keeping');
  expect(saleCreates()).toHaveLength(0);
});

test('success selects the CONFIRMED client, shows its summary and keeps the draft', async () => {
  mockDetail.cNEW = { name: 'New Client', whatsapp: '03000000000', company: 'Fresh Co', totals: [] };
  await mount();
  await typeDraft('draft worth keeping');
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'New Client');

  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  expect(modal()).toBeFalsy();
  expect(container.querySelector('textarea').value).toBe('draft worth keeping');
  expect(summary()).toBeTruthy();
  expect(summary().textContent).toContain('New Client');
  expect(mockGets.filter((u) => u === '/contacts/clients/cNEW')).toHaveLength(1);
  expect(saleCreates()).toHaveLength(0);
});

test('repeated clicks produce exactly ONE contact create', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'New Client');
  const save = modalButton(/save and select/i);
  await act(async () => {
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  expect(contactCreates()).toHaveLength(1);
});

test('Enter inside the modal does not submit the parent sale', async () => {
  await mount();
  await openQuickCreate();
  const input = modal().querySelector('input');
  await setInput(input, 'New Client');
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await flush();
  expect(saleCreates()).toHaveLength(0);
});

test('a late create response cannot override a deliberate later selection', async () => {
  const slow = deferred();
  mockDetail.cA = { name: 'Ali Raza', whatsapp: '03001234567', totals: [] };
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'New Client');
  mockCreateImpl = () => slow.promise;
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await act(async () => { modalButton(/cancel/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  await pickExistingClient('Ali Raza');
  expect(summary().textContent).toContain('Ali Raza');

  await act(async () => { slow.resolve({ data: { id: 'cNEW', name: 'New Client' } }); });
  await flush();
  expect(summary().textContent).toContain('Ali Raza');
});

// ── a COMMITTED create whose response was lost ────────────────────────────────────────────────
// The synchronous guard stops simultaneous clicks; it does nothing about a request that reached
// the server and whose answer never came back. Without a key the retry creates a SECOND contact.
// The server side of this (one row, one audit event, UNIQUE column, cross-actor conflict) runs on
// a real engine in backend/scripts/crm-db-selftest.js.
test('the create carries an idempotency key', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'Keyed Client');
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const create = contactCreates()[0];
  expect(create).toBeTruthy();
  expect(typeof create[1].idempotencyKey).toBe('string');
  expect(create[1].idempotencyKey.length).toBeGreaterThan(8);
});

test('a lost response then a retry reuses the SAME key - one intended contact', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'Keyed Client');

  mockCreateImpl = async () => { throw new Error('Network Error'); };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  expect(contactCreates()).toHaveLength(1);
  const firstKey = contactCreates()[0][1].idempotencyKey;
  expect(modal()).toBeTruthy();                       // still open so the operator can retry

  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Keyed Client' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all).toHaveLength(2);
  expect(all[1][1].idempotencyKey).toBe(firstKey);    // same operation, so the server replays
  expect(new Set(all.map((c) => c[1].idempotencyKey)).size).toBe(1);
});

test('editing the name before retrying mints a NEW key - a different intended contact', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelector('input'), 'First Name');
  mockCreateImpl = async () => { const e = new Error('x'); e.response = { status: 400, data: { error: 'bad' } }; throw e; };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  const firstKey = contactCreates()[0][1].idempotencyKey;

  await setInput(modal().querySelector('input'), 'Corrected Name');
  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Corrected Name' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all[1][1].name).toBe('Corrected Name');
  expect(all[1][1].idempotencyKey).not.toBe(firstKey);
});

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

// ── THE UNCOVERED CASE: committed, answer lost, operator EDITS, then retries ───────────────────
// Previously covered: an UNCHANGED retry after a network error, and an EDITED retry after an
// explicit 400. Neither is this. Here the server committed, the answer never arrived, and the
// operator "fixes" the phone number before trying again - the exact sequence where a new key
// turns one uncertain contact into two.
test('editing after an UNKNOWN outcome still retries the ORIGINAL operation', async () => {
  await mount();
  await openQuickCreate();
  const nameField = () => modal().querySelectorAll('input')[0];
  const phoneField = () => modal().querySelectorAll('input')[1];

  await setInput(nameField(), 'Ayesha Siddiqui');
  if (phoneField()) await setInput(phoneField(), '03001111111');

  // the create COMMITS on the server; the response is lost
  mockCreateImpl = async () => { throw new Error('Network Error'); };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const first = contactCreates();
  expect(first).toHaveLength(1);
  const originalKey = first[0][1].idempotencyKey;
  const originalPhone = first[0][1].whatsapp;
  expect(modal()).toBeTruthy();
  expect(modal().textContent).toMatch(/may already have been created/i);
  expect(modal().textContent).toMatch(/not saved yet/i);

  // the operator edits the phone number, believing nothing was saved
  if (phoneField()) await setInput(phoneField(), '03002222222');
  expect(phoneField().value).toBe('03002222222');        // the proposal is preserved on screen

  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Ayesha Siddiqui', whatsapp: originalPhone } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all).toHaveLength(2);
  // SAME key and SAME body: the server replays the original row instead of creating a second one
  expect(all[1][1].idempotencyKey).toBe(originalKey);
  expect(all[1][1].whatsapp).toBe(originalPhone);
  expect(all[1][1].whatsapp).not.toBe('03002222222');
  expect(new Set(all.map((c) => c[1].idempotencyKey)).size).toBe(1);
});

test('after reconciliation a genuinely NEW contact gets its own key', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'First Contact');
  mockCreateImpl = async () => { throw new Error('Network Error'); };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  const originalKey = contactCreates()[0][1].idempotencyKey;

  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'First Contact' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  expect(modal()).toBeFalsy();                            // resolved and selected

  // a second, deliberate contact afterwards is a different operation
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Second Contact');
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all[all.length - 1][1].name).toBe('Second Contact');
  expect(all[all.length - 1][1].idempotencyKey).not.toBe(originalKey);
});

test('an explicit validation rejection stays correctable and submits normally', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Bad Name');
  mockCreateImpl = async () => { const e = new Error('x'); e.response = { status: 400, data: { error: 'name must be at least 2 characters' } }; throw e; };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  expect(modal().textContent).toMatch(/at least 2 characters/i);
  expect(modal().textContent).not.toMatch(/may already have been created/i);   // NOT uncertain

  const rejectedKey = contactCreates()[0][1].idempotencyKey;
  await setInput(modal().querySelectorAll('input')[0], 'Corrected Name');
  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Corrected Name' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all[1][1].name).toBe('Corrected Name');          // the correction really is sent
  expect(all[1][1].idempotencyKey).not.toBe(rejectedKey); // a definite refusal is a new operation
  expect(modal()).toBeFalsy();
});

// ── CLOSING THE DIALOG DOES NOT CANCEL A REQUEST ALREADY SENT ─────────────────────────────────
// Cancel/Close bumps quickGeneration, and the catch used to `return` on a generation mismatch
// BEFORE recording the uncertain operation. So closing the modal erased all knowledge of a
// request that may have committed, and the next attempt created a duplicate. Ownership of the
// SCREEN and bookkeeping of the OPERATION are now separate concerns.
test('closing while a create is pending keeps the operation known, without touching the selection', async () => {
  const slow = deferred();
  mockDetail.cA = { name: 'Ali Raza', whatsapp: '03001234567', totals: [] };
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Pending Contact');

  mockCreateImpl = () => slow.promise;
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const sentKey = contactCreates()[0][1].idempotencyKey;

  // the operator gives up on the dialog and picks an existing client instead
  await act(async () => { modalButton(/cancel/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  await pickExistingClient('Ali Raza');
  expect(summary().textContent).toContain('Ali Raza');

  // the server had committed; the answer is lost
  await act(async () => { slow.reject(new Error('Network Error')); });
  await flush();

  // the newer deliberate selection is untouched...
  expect(summary().textContent).toContain('Ali Raza');
  expect(summary().textContent).not.toContain('Pending Contact');

  // ...but the uncertain operation is still known, so reopening retries THAT one
  await openQuickCreate();
  expect(modal().textContent).toMatch(/still unconfirmed|may already have been created/i);
  await setInput(modal().querySelectorAll('input')[0], 'Renamed Contact');
  mockCreateImpl = async () => ({ data: { id: 'cPEND', name: 'Pending Contact' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const all = contactCreates();
  expect(all).toHaveLength(2);
  expect(all[1][1].idempotencyKey).toBe(sentKey);          // same operation, not a new contact
  expect(all[1][1].name).toBe('Pending Contact');          // original body, not the rename
  expect(new Set(all.map((c) => c[1].idempotencyKey)).size).toBe(1);
});

test('a superseded SUCCESS resolves the operation without moving the selection', async () => {
  const slow = deferred();
  mockDetail.cA = { name: 'Ali Raza', whatsapp: '03001234567', totals: [] };
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Pending Contact');
  mockCreateImpl = () => slow.promise;
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await act(async () => { modalButton(/cancel/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  await pickExistingClient('Ali Raza');

  await act(async () => { slow.resolve({ data: { id: 'cPEND', name: 'Pending Contact' } }); });
  await flush();

  expect(summary().textContent).toContain('Ali Raza');      // late success does not hijack
  // and the operation is resolved, so the next quick-create is a genuinely new one
  await openQuickCreate();
  expect(modal().textContent).not.toMatch(/still unconfirmed|may already have been created/i);
  await setInput(modal().querySelectorAll('input')[0], 'Brand New');
  mockCreateImpl = async () => ({ data: { id: 'cNEW2', name: 'Brand New' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  const all = contactCreates();
  expect(all[all.length - 1][1].idempotencyKey).not.toBe(all[0][1].idempotencyKey);
});

// ── WHAT WAS ACTUALLY SAVED ───────────────────────────────────────────────────────────────────
test('after reconciliation the operator is told which values were really saved', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Ayesha Siddiqui');
  const phone = modal().querySelectorAll('input')[1];
  if (phone) await setInput(phone, '03001111111');

  mockCreateImpl = async () => { throw new Error('Network Error'); };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  // the operator "corrects" the phone, then reconciles
  if (modal().querySelectorAll('input')[1]) await setInput(modal().querySelectorAll('input')[1], '03002222222');
  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Ayesha Siddiqui', whatsapp: '03001111111', email: '' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const body = container.textContent;
  expect(body).toMatch(/Reconciled to the contact that was already created/i);
  expect(body).toMatch(/later edits were not sent/i);
  expect(body).toContain('03001111111');                    // what the server actually holds
  expect(body).toContain('03002222222');                    // what the operator typed, not lost
  expect(body).toMatch(/Open the contact to correct it/i);  // the existing edit workflow
  expect(contactCreates()).toHaveLength(2);                 // still ONE operation identity
  expect(new Set(contactCreates().map((c) => c[1].idempotencyKey)).size).toBe(1);
});

test('a reconciliation with NO differences shows no scary notice', async () => {
  await mount();
  await openQuickCreate();
  await setInput(modal().querySelectorAll('input')[0], 'Same Values');
  mockCreateImpl = async () => { throw new Error('Network Error'); };
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  mockCreateImpl = async () => ({ data: { id: 'cNEW', name: 'Same Values', whatsapp: '', email: '' } });
  await act(async () => { modalButton(/save and select/i).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  expect(container.textContent).not.toMatch(/Reconciled to the contact/i);
});

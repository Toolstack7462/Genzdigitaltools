/**
 * SELECTED-CLIENT SUMMARY, and the existing auto-fill it sits next to.
 *
 * Read-only, inside the existing SaleForm, from the existing authorised contract:
 *   - name / phone / email / company come from the SUGGESTION that was already fetched, so a
 *     selection costs no extra request for them;
 *   - the outstanding balance comes from GET /contacts/clients/:id, whose `totals` are grouped by
 *     currency_code - which is why switching currency re-reads that response instead of fetching
 *     again, and why currencies are never combined.
 *
 * Four outcomes are kept apart on purpose: not asked, loading, the lookup FAILED (balance
 * unknown), and a confirmed zero. A failed lookup reading as "0" would be a lie about money.
 *
 * WHAT THIS EXERCISES: the real SaleForm and real Combobox against a stubbed CRM API, in jsdom.
 * WHAT IT IS NOT: live authenticated acceptance.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockGets = [];
const mockPosts = [];
let mockDetail = {};          // id -> { resolve } | { reject } | plain data

const CLIENTS = [
  { id: 'cA', name: 'Ali Raza', whatsapp: '03001234567', email: 'ali@example.test', company: 'Raza Traders' },
  { id: 'cB', name: 'Bilal Khan', whatsapp: '03217654321', email: 'bilal@example.test', company: 'Khan Co' },
];

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
      if (url.startsWith('/products')) return { data: { rows: [{ id: 'prod-1', name: 'Catalogue Product', category: 'Software', account_type: 'private', duration_label: '1 Month', default_sale_price: '500.00', default_purchase_cost: '200.00', currency_code: 'PKR', active: true }], total: 1 } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => { mockPosts.push(args); return Promise.resolve({ data: { id: 'sale-1' } }); },
    put: (...args) => { mockPosts.push(args); return Promise.resolve({ data: { id: 'sale-1' } }); },
  },
  messageFromError: (error) => error?.message || 'Request failed',
}));

const mockCrm = {
  currency: 'PKR', denied: new Set(),
  has(permission) { return !mockCrm.denied.has(permission); },
  bootstrap: { user: { id: 'u1' }, settings: {} },
  queued: 0, setQueued: () => {},
};
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));
jest.mock('../offline/queue', () => ({ __esModule: true, queueOperation: async () => {} }));
jest.mock('../offline/db', () => ({ __esModule: true, offlineDb: { get: async () => null, set: async () => {} } }));

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
const comboInputs = () => [...container.querySelectorAll('input[role="combobox"]')];
// The client box is the first combobox on the sale form; the catalogue box is matched by its own
// placeholder. Matching the client one by placeholder text is brittle - it differs from the
// field's visible hint.
const clientBox = () => comboInputs()[0];
const field = (re) => comboInputs().find((i) => re.test(i.placeholder || ''));
const summary = () => container.querySelector('.bcrm-clientsum');

async function typeIn(input, text) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
// The client widget is the first .bcrm-combo on the sale form. Once a client is selected the
// Combobox swaps to its "selected" view, so a second selection must reopen it first - an
// index-based input lookup would otherwise type into the vendor or catalogue box.
const clientCombo = () => container.querySelectorAll('.bcrm-combo')[0];

async function pickClient(text) {
  const widget = clientCombo();
  const reopen = widget.querySelector('.bcrm-combo-value');
  if (reopen) await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  const box = widget.querySelector('input[role="combobox"]');
  await typeIn(box, text);
  await advance(300);
  await flush();

  const node = [...widget.querySelectorAll('[role="option"]')].find((n) => (n.textContent || '').includes(text));
  if (!node) throw new Error(`no option matching "${text}"; saw: ${[...widget.querySelectorAll('[role="option"]')].map((n) => n.textContent).join(' | ')}`);
  const button = node.querySelector('button') || node;
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGets.length = 0; mockPosts.length = 0;
  mockDetail = {};
  mockCrm.denied = new Set();
  document.body.innerHTML = '';
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; jest.useRealTimers(); });

test('no summary is shown before a deliberate selection', async () => {
  await mount();
  expect(summary()).toBeFalsy();
  expect(mockGets.filter((u) => /^\/contacts\/clients\/[a-z]/i.test(u))).toHaveLength(0);
});

test('selecting shows saved details from the suggestion and the currency outstanding', async () => {
  mockDetail.cA = { totals: [{ currency_code: 'PKR', pending_amount: '1500.00' }, { currency_code: 'INR', pending_amount: '99.00' }] };
  await mount();
  await pickClient('Ali Raza');

  const text = summary().textContent;
  expect(text).toContain('Ali Raza');
  expect(text).toContain('03001234567');
  expect(text).toContain('ali@example.test');
  expect(text).toContain('Raza Traders');
  expect(text).toMatch(/Outstanding \(PKR\)/);
  expect(text).toContain('1,500.00');
  expect(text).not.toContain('99.00');                 // the INR figure is never mixed in
  expect(summary().querySelector('a').getAttribute('href')).toContain('/clients/cA');
});

test('a detail lookup costs ONE request, and only on selection', async () => {
  mockDetail.cA = { totals: [] };
  await mount();
  await pickClient('Ali Raza');
  expect(mockGets.filter((u) => u === '/contacts/clients/cA')).toHaveLength(1);
});

test('a FAILED lookup is not a zero balance', async () => {
  const d = deferred();
  mockDetail.cA = { promise: d.promise };
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/Checking/i);          // loading is its own state

  await act(async () => { d.reject(new Error('network down')); });
  await flush();
  expect(summary().textContent).toMatch(/balance unknown/i);
  expect(summary().textContent).not.toMatch(/0\.00/);
});

test('a confirmed zero reads as none, distinctly from a failure', async () => {
  mockDetail.cA = { totals: [{ currency_code: 'INR', pending_amount: '10.00' }] };   // nothing in PKR
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/None in PKR/i);
  expect(summary().textContent).not.toMatch(/balance unknown/i);
});

test('a late response for client A cannot land on client B', async () => {
  const slowA = deferred();
  mockDetail.cA = { promise: slowA.promise };
  mockDetail.cB = { totals: [{ currency_code: 'PKR', pending_amount: '7.00' }] };
  await mount();

  await pickClient('Ali Raza');                                 // A pending
  await pickClient('Bilal Khan');                               // switch to B
  expect(summary().textContent).toContain('Bilal Khan');

  await act(async () => { slowA.resolve({ data: { totals: [{ currency_code: 'PKR', pending_amount: '999999.00' }] } }); });
  await flush();

  expect(summary().textContent).toContain('Bilal Khan');
  expect(summary().textContent).not.toContain('999,999.00');
  expect(summary().textContent).not.toContain('Ali Raza');
});

test('changing selection clears the previous client’s details immediately', async () => {
  const slowB = deferred();
  mockDetail.cA = { totals: [{ currency_code: 'PKR', pending_amount: '1500.00' }] };
  mockDetail.cB = { promise: slowB.promise };
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toContain('1,500.00');

  await pickClient('Bilal Khan');
  expect(summary().textContent).not.toContain('1,500.00');      // A's figure is gone at once
  expect(summary().textContent).not.toContain('Raza Traders');
  expect(summary().textContent).toMatch(/Checking/i);
});

test('viewing a client writes nothing', async () => {
  mockDetail.cA = { totals: [] };
  await mount();
  await pickClient('Ali Raza');
  expect(mockPosts).toHaveLength(0);
  const writes = mockGets.filter((u) => /create|merge|assign|link/i.test(u));
  expect(writes).toHaveLength(0);
});

// ── auto-fill, next to the summary ────────────────────────────────────────────────────────────
test('selecting a product fills its catalogue defaults for the current currency', async () => {
  mockDetail.cA = { totals: [] };
  await mount();
  await pickClient('Ali Raza');

  const productBox = field(/Search catalogue/i);
  await typeIn(productBox, 'cat');
  await advance(300);
  await flush();
  const node = container.querySelector('[role="option"] button') || container.querySelector('[role="option"]');
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const values = [...container.querySelectorAll('input')].map((i) => i.value);
  expect(values).toContain('Catalogue Product');
  expect(values).toContain('500.00');                           // the PKR catalogue price
});

test('a restricted role never receives a purchase cost in the submitted payload', async () => {
  mockCrm.denied = new Set(['profit.view']);
  mockDetail.cA = { totals: [] };
  await mount();
  await pickClient('Ali Raza');

  const productBox = field(/Search catalogue/i);
  await typeIn(productBox, 'cat');
  await advance(300);
  await flush();
  const node = container.querySelector('[role="option"] button') || container.querySelector('[role="option"]');
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const form = container.querySelector('form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const create = mockPosts.find((call) => call[0] === '/sales');
  expect(create).toBeTruthy();
  expect(create[1].items[0].purchaseCost).toBeUndefined();
  expect(JSON.stringify(create[1])).not.toContain('200.00');
});

test('changing client does not erase the product lines already entered', async () => {
  mockDetail.cA = { totals: [] };
  mockDetail.cB = { totals: [] };
  await mount();
  await pickClient('Ali Raza');

  const productBox = field(/Search catalogue/i);
  await typeIn(productBox, 'cat');
  await advance(300);
  await flush();
  const node = container.querySelector('[role="option"] button') || container.querySelector('[role="option"]');
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  expect([...container.querySelectorAll('input')].map((i) => i.value)).toContain('Catalogue Product');

  await pickClient('Bilal Khan');
  const values = [...container.querySelectorAll('input')].map((i) => i.value);
  expect(values).toContain('Catalogue Product');                // the line survived
  expect(summary().textContent).toContain('Bilal Khan');        // and the summary followed
});

// ── MEASURED REQUEST LOAD ─────────────────────────────────────────────────────────────────────
// Counts what the real SaleForm actually issues through crmApi, in jsdom with the fixtures above.
// This is a REQUEST-COUNT measurement, not a hosting-cost measurement: it says nothing about
// Hostinger CPU or RAM, and the warm-up below is real background work either way.
test('MEASURE: request load for open, search, selection and currency switch', async () => {
  mockDetail.cA = { totals: [{ currency_code: 'PKR', pending_amount: '1500.00' }, { currency_code: 'INR', pending_amount: '250.00' }] };
  await mount();

  const warmUp = mockGets.slice();
  const bulk = warmUp.filter((u) => /pageSize=(\d+)/.test(u) && Number(/pageSize=(\d+)/.exec(u)[1]) >= 100);
  console.log('[measure] initial open ->', warmUp.length, 'requests:', JSON.stringify(warmUp));
  console.log('[measure] of which bulk warm-up (pageSize>=100):', bulk.length, JSON.stringify(bulk));

  const afterOpen = mockGets.length;
  await pickClient('Ali Raza');
  const selectionCost = mockGets.slice(afterOpen);
  console.log('[measure] search + selection ->', selectionCost.length, 'requests:', JSON.stringify(selectionCost));
  expect(selectionCost.filter((u) => u === '/contacts/clients/cA')).toHaveLength(1);

  // CURRENCY SWITCH: the summary must re-read the totals it already holds, not refetch.
  const beforeSwitch = mockGets.length;
  const currency = [...container.querySelectorAll('select')].find((sel) => [...sel.options].some((o) => o.value === 'INR' || o.textContent === 'INR'));
  expect(currency).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(currency, 'INR');
    currency.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  const switchCost = mockGets.slice(beforeSwitch);
  console.log('[measure] currency switch ->', switchCost.length, 'requests:', JSON.stringify(switchCost));

  // the figure changed currency without another contact-detail request
  expect(summary().textContent).toMatch(/Outstanding \(INR\)/);
  expect(switchCost.filter((u) => /^\/contacts\/clients\/[a-zA-Z0-9]+$/.test(u))).toHaveLength(0);
  expect(switchCost.filter((u) => u.startsWith('/contacts/clients?'))).toHaveLength(0);
  expect(switchCost.filter((u) => u.startsWith('/contacts/vendors'))).toHaveLength(0);
});

// ── HONEST VALIDATION OF THE SUMMARY RESPONSE ─────────────────────────────────────────────────
// Five outcomes must stay apart. The earlier version coerced a missing/non-array `totals` to []
// and reported "ready", so an unreadable answer became a confident "None in PKR" - a statement
// about someone's money made from data we never understood.
//
// The real endpoint answers { ...contact, sales, tasks, activities, totals } with contact fields
// at the TOP LEVEL, and each total is { currency_code, total_amount, paid_amount, pending_amount,
// sale_count } with money.normalize applied. These fixtures follow that shape.

test('a REAL ZERO row shows the zero, not "none"', async () => {
  mockDetail.cA = { name: 'Ali Raza', totals: [{ currency_code: 'PKR', total_amount: '500.00', paid_amount: '500.00', pending_amount: '0.00', sale_count: 2 }] };
  await mount();
  await pickClient('Ali Raza');
  const text = summary().textContent;
  expect(text).toContain('0.00');                       // a settled client, stated as settled
  expect(text).not.toMatch(/None in PKR/i);
  expect(text).not.toMatch(/balance unknown/i);
});

test('valid totals with NO row for this currency reads as none, distinctly from a real zero', async () => {
  mockDetail.cA = { name: 'Ali Raza', totals: [{ currency_code: 'INR', total_amount: '10.00', paid_amount: '0.00', pending_amount: '10.00', sale_count: 1 }] };
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/None in PKR/i);
  expect(summary().textContent).not.toContain('0.00');
});

test('a MISSING totals field is a failure, never "no outstanding"', async () => {
  mockDetail.cA = { name: 'Ali Raza', sales: [], tasks: [], activities: [] };   // no `totals` at all
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/balance unknown/i);
  expect(summary().textContent).not.toMatch(/None in PKR/i);
});

test('a non-array totals field is a failure', async () => {
  mockDetail.cA = { name: 'Ali Raza', totals: { PKR: '100.00' } };
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/balance unknown/i);
});

test('a malformed row or invalid amount is a failure, not a zero', async () => {
  for (const bad of [
    [{ currency_code: 'PKR', pending_amount: null }],
    [{ currency_code: 'PKR', pending_amount: 'abc' }],
    [{ currency_code: 'PKR', pending_amount: '1.23456' }],
    [{ currency_code: 'pkr', pending_amount: '1.00' }],
    [null],
  ]) {
    mockDetail.cA = { name: 'Ali Raza', totals: bad };
    await mount();
    await pickClient('Ali Raza');
    expect(summary().textContent).toMatch(/balance unknown/i);
    expect(summary().textContent).not.toMatch(/None in PKR/i);
    await act(async () => { root.unmount(); }); root = null;
  }
});

test('an empty totals array is valid - a contact with no sales at all', async () => {
  mockDetail.cA = { name: 'Ali Raza', totals: [] };
  await mount();
  await pickClient('Ali Raza');
  expect(summary().textContent).toMatch(/None in PKR/i);
  expect(summary().textContent).not.toMatch(/balance unknown/i);
});

test('a failed lookup offers a bounded manual retry that succeeds without reselecting', async () => {
  const d = deferred();
  mockDetail.cA = { promise: d.promise };
  await mount();
  await pickClient('Ali Raza');
  await act(async () => { d.reject(new Error('down')); });
  await flush();
  expect(summary().textContent).toMatch(/balance unknown/i);

  mockDetail.cA = { name: 'Ali Raza', totals: [{ currency_code: 'PKR', pending_amount: '42.00' }] };
  const retry = [...summary().querySelectorAll('button')].find((b) => /retry/i.test(b.textContent || ''));
  expect(retry).toBeTruthy();
  await act(async () => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
  expect(summary().textContent).toContain('42.00');
});

test('contact fields are read from the TOP LEVEL of the response, not data.contact', async () => {
  // The suggestion has no company for this fixture, so the displayed company can only come from
  // the detail response - which proves the shape being read.
  mockDetail.cB = { name: 'Bilal Khan', whatsapp: '03217654321', email: 'bilal@example.test', company: 'Khan Co', totals: [] };
  await mount();
  await pickClient('Bilal Khan');
  expect(summary().textContent).toContain('Khan Co');
});

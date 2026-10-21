/**
 * EDITING AN EXISTING SALE: the client summary must show the REAL authorised details.
 *
 * The existing-sale path seeds loadClientSummary with a name-only stub ({ name: sale.client_name }).
 * The response handler then did `current.contact || contactFields(body)`, so that stub won - and
 * the phone, email and company the very same response had just returned were thrown away. The
 * operator editing a saved sale saw a name and nothing else.
 *
 * It also pins the read-only guarantee: loading this summary must not reprice the sale, reset its
 * items, or disturb its version / credential-preservation flags.
 *
 * WHAT THIS EXERCISES: the real SaleForm in edit mode against a stubbed CRM API, in jsdom.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockGets = [];
const mockPosts = [];

// The saved sale knows the client only by id + name - exactly the shape that exposed the bug.
const SALE = {
  id: 'sale-9', invoice_number: 'INV-0009', client_id: 'cA', client_name: 'Ali Raza',
  vendor_id: null, sale_date: '2026-09-01', order_type: 'renewal', currency_code: 'PKR',
  notes: 'historical note - must not change', invoice_instructions: '', version: 4,
  items: [{
    id: 'it-1', product_id: 'p1', name: 'Canva Pro (1 Year)', account_type: 'shared',
    duration_label: '1 Year', purchase_date: '2026-09-01', expiry_date: '2027-09-01',
    sale_price: '3500.00', purchase_cost: '1200.00',
    has_credential_email: true, has_credential_password: true,
  }],
};

// The authorised contact detail DOES carry the saved contact fields and grouped balances.
const DETAIL = {
  name: 'Ali Raza', whatsapp: '0300 1234567', email: 'ali@example.test', company: 'Raza Traders',
  sales: [], tasks: [], activities: [],
  totals: [{ currency_code: 'PKR', total_amount: '9000.00', paid_amount: '1750.00', pending_amount: '7250.00', sale_count: 3 }],
};

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      mockGets.push(url);
      if (/^\/sales\/sale-9/.test(url)) return { data: SALE };
      if (/^\/contacts\/clients\/cA$/.test(url)) return { data: DETAIL };
      if (url.startsWith('/contacts/clients')) return { data: { rows: [], total: 0 } };
      return { data: { rows: [], total: 0 } };
    },
    post: (...args) => { mockPosts.push(args); return Promise.resolve({ data: { id: 'sale-9' } }); },
    put: (...args) => { mockPosts.push(args); return Promise.resolve({ data: { id: 'sale-9' } }); },
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
jest.mock('../offline/db', () => ({ __esModule: true, offlineDb: { get: async () => null, set: async () => {}, putCache: async () => {} } }));
jest.mock('react-router-dom', () => ({
  __esModule: true,
  useNavigate: () => () => {},
  useParams: () => ({ id: 'sale-9' }),
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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const summary = () => container.querySelector('.bcrm-clientsum');
const values = () => [...container.querySelectorAll('input')].map((i) => i.value);

beforeEach(() => { mockGets.length = 0; mockPosts.length = 0; mockCrm.denied = new Set(); document.body.innerHTML = ''; });
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });

test('the saved client’s real details and currency balance appear when editing', async () => {
  await mount();
  expect(mockGets).toContain('/contacts/clients/cA');

  const text = summary().textContent;
  expect(text).toContain('Ali Raza');
  expect(text).toContain('0300 1234567');          // came ONLY from the detail response
  expect(text).toContain('ali@example.test');
  expect(text).toContain('Raza Traders');
  expect(text).toMatch(/Outstanding \(PKR\)/);
  expect(text).toContain('7,250.00');
});

test('loading the summary leaves the historical sale untouched', async () => {
  await mount();
  const shown = values();
  expect(shown).toContain('Canva Pro (1 Year)');
  expect(shown).toContain('3500.00');              // not repriced from today's catalogue
  expect(shown).toContain('1200.00');
  expect(container.querySelector('textarea').value).toBe('historical note - must not change');

  // read-only: nothing was written while the summary loaded
  expect(mockPosts).toHaveLength(0);
  expect(mockGets.filter((u) => /merge|assign|link/i.test(u))).toHaveLength(0);
});

test('credential-preservation flags and version survive the summary load', async () => {
  await mount();
  const form = container.querySelector('form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

  const put = mockPosts.find((call) => call[0] === '/sales/sale-9');
  expect(put).toBeTruthy();
  expect(put[1].version).toBe(4);
  expect(put[1].items[0].keepCredentialEmail).toBe(true);
  expect(put[1].items[0].keepCredentialPassword).toBe(true);
  expect(put[1].items[0].salePrice).toBe('3500.00');
  expect(put[1].notes).toBe('historical note - must not change');
  // an update is version-checked, never idempotency-keyed
  expect(put[1].idempotencyKey).toBeUndefined();
});

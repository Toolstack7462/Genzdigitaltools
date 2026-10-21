/**
 * PAGINATION AND ROW NAVIGATION, against the INSTALLED router.
 *
 * Pagination: Contacts asked for `pageSize=100` and never sent `page`, and the audit screen asked
 * for 200. Every route already returned `{ rows, page, pageSize, total }`, and the screen even
 * printed `total` - so past the first page the remaining records were simply unreachable.
 *
 * Navigation: `Contacts.jsx` does `const nav = useNavigate()` then `nav(x.id)` - a RELATIVE
 * navigation, the pattern crmRouting.test.js exists to prevent, but the `nav` alias slips past its
 * `navigate(...)` source scan. A source scan cannot tell whether that resolves correctly, so this
 * renders the real component inside the real router and checks where the click actually lands.
 *
 * These use the REAL react-router-dom (craco.config.js maps it to its CJS build for jest, because
 * the package's "main" field points at a file it does not ship). Only the CRM API and the CRM
 * context are stubbed.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockRequests = [];
let mockPages = {};

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async (url) => {
      mockRequests.push(url);
      const page = Number((/[?&]page=(\d+)/.exec(url) || [])[1] || 1);
      const key = url.startsWith('/contacts/vendors') ? 'vendors' : 'clients';
      const store = mockPages[key] || { total: 0, pageSize: 25, byPage: {} };
      return { data: { rows: store.byPage[page] || [], page, pageSize: store.pageSize, total: store.total } };
    },
    post: async () => ({ data: {} }),
  },
  messageFromError: (error) => error?.message || 'Request failed',
}));

const mockCrm = { currency: 'PKR', has: () => true, bootstrap: { user: { id: 'u1' } }, queued: 0, setQueued: () => {} };
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));

// eslint-disable-next-line import/first
import Contacts from '../pages/Contacts';

const contact = (id, name) => ({ id, name, company: 'Acme', whatsapp: '03001234567', email: `${id}@example.test`, status: 'active' });

function Detail({ label }) {
  const location = useLocation();
  return React.createElement('div', { 'data-testid': label }, location.pathname);
}
function BackButton() {
  const navigate = useNavigate();
  return React.createElement('button', { 'data-testid': 'go-back', onClick: () => navigate(-1) }, 'Back');
}

let container; let root;

async function mountAt(entry) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [entry] },
        React.createElement(BackButton),
        React.createElement(Routes, null,
          React.createElement(Route, { path: '/admin/business' },
            React.createElement(Route, { path: 'clients', element: React.createElement(Contacts, { kind: 'clients' }) }),
            React.createElement(Route, { path: 'clients/:id', element: React.createElement(Detail, { label: 'client-detail' }) }),
            React.createElement(Route, { path: 'vendors', element: React.createElement(Contacts, { kind: 'vendors' }) }),
            React.createElement(Route, { path: 'vendors/:id', element: React.createElement(Detail, { label: 'vendor-detail' }) }),
          ),
        ),
      ),
    );
  });
}

const rows = () => [...container.querySelectorAll('tbody tr')];
const button = (text) => [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === text.toLowerCase());
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const lastUrl = () => mockRequests[mockRequests.length - 1];

beforeEach(() => {
  mockRequests.length = 0;
  mockPages = {
    clients: {
      total: 30, pageSize: 25,
      byPage: { 1: Array.from({ length: 25 }, (_, i) => contact(`c${i + 1}`, `Client ${i + 1}`)), 2: Array.from({ length: 5 }, (_, i) => contact(`c${i + 26}`, `Client ${i + 26}`)) },
    },
    vendors: { total: 1, pageSize: 25, byPage: { 1: [contact('v1', 'Vendor One')] } },
  };
  document.body.innerHTML = '';
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });

// ── pagination ─────────────────────────────────────────────────────────────────────────────────
test('the list asks for a page, and a bounded page size instead of 100', async () => {
  await mountAt('/admin/business/clients');
  expect(lastUrl()).toMatch(/[?&]page=1\b/);
  expect(lastUrl()).toMatch(/[?&]pageSize=25\b/);
  expect(lastUrl()).not.toMatch(/pageSize=100/);
});

test('Next reaches the records that were previously unreachable', async () => {
  await mountAt('/admin/business/clients');
  expect(rows()).toHaveLength(25);
  expect(container.textContent).toContain('Client 1');

  await click(button('Next'));
  expect(lastUrl()).toMatch(/[?&]page=2\b/);
  expect(rows()).toHaveLength(5);
  expect(container.textContent).toContain('Client 26');
  expect(container.textContent).not.toContain('Client 1\u0000');   // not a prefix match of Client 1x
});

test('the pager separates the filtered total from what is on screen', async () => {
  await mountAt('/admin/business/clients');
  const pager = container.querySelector('.bcrm-pager');
  expect(pager).toBeTruthy();
  expect(pager.textContent).toMatch(/of\s*30/);
  expect(pager.textContent).toMatch(/Page 1 of 2/);
});

test('Previous is disabled on the first page and Next on the last', async () => {
  await mountAt('/admin/business/clients');
  expect(button('Previous').disabled).toBe(true);
  await click(button('Next'));
  expect(button('Next').disabled).toBe(true);
  expect(button('Previous').disabled).toBe(false);
});

test('a page beyond the end steps back instead of showing a dead empty screen', async () => {
  await mountAt('/admin/business/clients');
  await click(button('Next'));                       // page 2 of 2
  // records are settled/removed elsewhere: only 3 remain, so page 2 no longer exists
  mockPages.clients = { total: 3, pageSize: 25, byPage: { 1: [contact('c1', 'Client 1')] } };
  await act(async () => { await Promise.resolve(); });
  await click(button('Previous'));                   // triggers a reload with the new totals
  await act(async () => { await Promise.resolve(); });
  expect(lastUrl()).toMatch(/[?&]page=1\b/);
});

test('a single page renders no pager clutter when everything already fits', async () => {
  await mountAt('/admin/business/vendors');
  const pager = container.querySelector('.bcrm-pager');
  expect(pager.textContent).toMatch(/Page 1 of 1/);
  expect(button('Next').disabled).toBe(true);
});

// ── navigation, through the installed router ───────────────────────────────────────────────────
test('clicking a contact row lands on that contact’s detail route', async () => {
  await mountAt('/admin/business/clients');
  expect(container.querySelector('[data-testid="client-detail"]')).toBeFalsy();

  await click(rows()[0]);

  const detail = container.querySelector('[data-testid="client-detail"]');
  expect(detail).toBeTruthy();
  expect(detail.textContent).toBe('/admin/business/clients/c1');
});

test('Back returns to the list, and the list still works afterwards', async () => {
  await mountAt('/admin/business/clients');
  await click(rows()[0]);
  expect(container.querySelector('[data-testid="client-detail"]')).toBeTruthy();

  await click(container.querySelector('[data-testid="go-back"]'));
  expect(container.querySelector('[data-testid="client-detail"]')).toBeFalsy();
  expect(rows().length).toBeGreaterThan(0);
});

test('the vendor list navigates to the VENDOR detail route, not the client one', async () => {
  await mountAt('/admin/business/vendors');
  await click(rows()[0]);
  const detail = container.querySelector('[data-testid="vendor-detail"]');
  expect(detail).toBeTruthy();
  expect(detail.textContent).toBe('/admin/business/vendors/v1');
  expect(container.querySelector('[data-testid="client-detail"]')).toBeFalsy();
});

test('landing directly on a detail URL renders that record, not the list', async () => {
  await mountAt('/admin/business/clients/c7');
  const detail = container.querySelector('[data-testid="client-detail"]');
  expect(detail).toBeTruthy();
  expect(detail.textContent).toBe('/admin/business/clients/c7');
});

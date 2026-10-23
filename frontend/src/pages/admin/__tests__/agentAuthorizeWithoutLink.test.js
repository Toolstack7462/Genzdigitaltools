// ADMIN → AUTHORIZE WRITEHUMAN AGENT: the page must work WITHOUT the one-time link.
//
// THE FAILURE THIS PREVENTS. An enrolment is valid for ten minutes. The page required
// `?e=<enrollId>` and dead-ended without it ("This link is missing its request id."), and a 404 on
// a stale id produced a bare error. The id exists only in the agent's console output and log, so an
// operator who lost the link — or who spent the window signing in — had no screen anywhere that
// would simply show the pending request. A revoked machine then could not be re-authorized in
// practice, which is exactly what happened on the live RDP.
//
// The id is now an optional shortcut: with no id, or a stale one, the page lists the live requests
// and approves one. The backend already exposed this (GET .../enrollments); only the UI never used it.
//
// SCOPE: the real page rendered in jsdom against a stubbed service. The admin layout is stubbed for
// the same reason as supportContactWriteGuard — it pulls a router subpath that does not resolve
// here. Server-side enrolment semantics (TTL, pruning, single-consumption) are covered in
// backend/tests/writehumanAgentEnroll.test.js, not here.
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../../components/AdminLayoutEnhanced', () => ({
  __esModule: true,
  default: ({ children }) => children,
  ADMIN_CARD_VARIANTS: { default: '' },
}));

const mockCalls = [];
let mockList = [];
let mockTtl = 10;
let mockGetImpl = async () => { throw Object.assign(new Error('gone'), { response: { status: 404 } }); };
let mockAuthImpl = async (id) => ({ data: { enrollment: { enrollId: id, name: 'Source RDP', status: 'consumed', hostname: 'WIN-K0R6CCFHB4L', agentVersion: '3.5.16', agentIdShort: 'abc1234567890...', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } } });

jest.mock('../../../services/writeHumanV2Service', () => ({
  __esModule: true,
  writeHumanV2Admin: {
    listEnrollments: async () => { mockCalls.push(['list']); return { data: { ok: true, enrollments: mockList, ttlMinutes: mockTtl } }; },
    getEnrollment: async (id) => { mockCalls.push(['get', id]); return mockGetImpl(id); },
    authorizeEnrollment: async (id, headers) => { mockCalls.push(['authorize', id, headers]); return mockAuthImpl(id); },
  },
}));
jest.mock('../../../services/launchService', () => ({
  __esModule: true,
  withCsrfRetry: async (fn) => fn({ 'x-csrf-token': 'test-token' }),
}));

// eslint-disable-next-line import/first
import AdminWriteHumanAuthorize from '../AdminWriteHumanAuthorize';

const row = (over = {}) => ({
  enrollId: 'enr_live_1',
  name: 'Source RDP',
  hostname: 'WIN-K0R6CCFHB4L',
  agentVersion: '3.5.16',
  agentIdShort: 'abc1234567890...',
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 9 * 60000).toISOString(),
  expired: false,
  ...over,
});

let container; let root;
async function mount(search) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/admin/writehuman/agent-authorize' + (search || '')] },
        React.createElement(Routes, null,
          React.createElement(Route, {
            path: '/admin/writehuman/agent-authorize',
            element: React.createElement(AdminWriteHumanAuthorize),
          }))),
    );
  });
}
const click = (re) => {
  const b = Array.from(container.querySelectorAll('button')).find((x) => re.test(x.textContent));
  if (!b) throw new Error('no button matching ' + re + '; saw: ' + Array.from(container.querySelectorAll('button')).map((x) => x.textContent).join(' | '));
  return act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['Date'] });
  mockCalls.length = 0;
  mockList = [row()];
  mockTtl = 10;
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  if (container) container.remove();
  root = null; container = null;
  jest.useRealTimers();
});

test('with NO link, the page lists the waiting machine instead of dead-ending', async () => {
  await mount();
  expect(container.textContent).not.toMatch(/missing its request id/i);
  expect(container.textContent).toMatch(/1 machine waiting for approval/i);
  expect(container.textContent).toMatch(/WIN-K0R6CCFHB4L/);
  expect(container.textContent).toMatch(/3\.5\.16/);
  expect(mockCalls.some(([k]) => k === 'list')).toBe(true);
  expect(mockCalls.some(([k]) => k === 'get')).toBe(false);
});

test('a STALE link falls back to the list and says why, rather than stranding the operator', async () => {
  await mount('?e=enr_expired_old');
  expect(mockCalls.some(([k, id]) => k === 'get' && id === 'enr_expired_old')).toBe(true);
  expect(container.textContent).toMatch(/no longer exists/i);
  expect(container.textContent).toMatch(/1 machine waiting for approval/i);
  // and the live request is approvable from here
  expect(container.textContent).toMatch(/Authorize this device/i);
});

test('approving from the list posts the ROW id, with the CSRF header', async () => {
  await mount();
  await click(/Authorize this device/i);
  const call = mockCalls.find(([k]) => k === 'authorize');
  expect(call).toBeDefined();
  expect(call[1]).toBe('enr_live_1');
  expect(call[2]).toMatchObject({ 'x-csrf-token': 'test-token' });
  expect(container.textContent).toMatch(/Authorized\./);
});

test('an expired request is never offered for approval', async () => {
  mockList = [row({ enrollId: 'enr_dead', expired: true })];
  await mount();
  expect(container.textContent).toMatch(/No machine is waiting/i);
  expect(Array.from(container.querySelectorAll('button')).some((b) => /Authorize this device/i.test(b.textContent))).toBe(false);
});

test('an empty list explains what to do instead of showing an error', async () => {
  mockList = [];
  await mount();
  expect(container.textContent).toMatch(/No machine is waiting/i);
  expect(container.textContent).toMatch(/Start the agent on the machine/i);
  expect(container.textContent).toMatch(/valid for about 10 minutes/i);
  expect(container.textContent).not.toMatch(/Could not load/i);
});

test('the list refreshes on its own, so a request minted later appears without a reload', async () => {
  mockList = [];
  await mount();
  expect(container.textContent).toMatch(/No machine is waiting/i);
  mockList = [row({ enrollId: 'enr_minted_later' })];
  await act(async () => { jest.advanceTimersByTime(5000); });
  await act(async () => {});
  expect(container.textContent).toMatch(/1 machine waiting for approval/i);
});

test('a valid link still uses the single-request flow it always had', async () => {
  mockGetImpl = async (id) => ({ data: { enrollment: row({ enrollId: id }) } });
  await mount('?e=enr_live_1');
  expect(container.textContent).toMatch(/WIN-K0R6CCFHB4L/);
  expect(container.textContent).not.toMatch(/machine waiting for approval/i);
  await click(/Authorize this device/i);
  expect(mockCalls.find(([k]) => k === 'authorize')[1]).toBe('enr_live_1');
  expect(container.textContent).toMatch(/Authorized\./);
  mockGetImpl = async () => { throw Object.assign(new Error('gone'), { response: { status: 404 } }); };
});

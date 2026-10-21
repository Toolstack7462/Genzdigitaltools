/**
 * PAYMENT SAFETY - one intended payment must stay one payment.
 *
 * `Payments.jsx` posted with no in-flight guard and no idempotency key, so a double-click sent two
 * independent POSTs. The server was already prepared for this: `validation.js` permits
 * `idempotencyKey` on the payment schema and `paymentService.recordPayment` replays on it inside a
 * `SELECT ... FOR UPDATE` transaction. The UI simply never used it.
 *
 * THE SERVER'S REPLAY BOUNDARY, which these tests pin because it drives the UI design:
 * `sameOperation` compares created_by, sale_id, party_type and AMOUNT. It does NOT compare
 * paymentDate, method, reference or notes. So a key reused after editing the method replays the
 * ORIGINAL row - the endpoint still answers 201 and the edit is silently lost. The UI therefore
 * re-mints the key whenever the payload changes, and refuses edits while an outcome is unknown.
 *
 * WHAT THIS EXERCISES: the real Payments page against a stubbed CRM API, in jsdom.
 * WHAT IT IS NOT: a database test. Concurrency, overpayment refusal and reversal consistency run
 * in the engine, not here, and are reported separately as not executed.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockPosts = [];
let mockPostImpl = async () => ({ data: { replayed: false } });

jest.mock('../api', () => ({
  __esModule: true,
  crmApi: {
    get: async () => ({ data: { rows: [mockRow], total: 1 } }),
    post: (...args) => { mockPosts.push(args); return mockPostImpl(...args); },
  },
  messageFromError: (error) => error?.response?.data?.error || error?.message || 'Request failed',
}));

jest.mock('react-router-dom', () => ({
  __esModule: true,
  Link: ({ children }) => require('react').createElement('a', null, children),
  useNavigate: () => () => {},
}), { virtual: true });

const mockCrm = { currency: 'PKR', has: () => true, bootstrap: { user: { id: 'u1' } }, queued: 0, setQueued: () => {} };
jest.mock('../BusinessCrmContext', () => ({ __esModule: true, useBusinessCrm: () => mockCrm }));

const mockRow = {
  id: 'sale-1', invoice_number: 'INV-001', party_name: 'Synthetic Client', sale_date: '2026-10-01',
  currency_code: 'PKR', total_amount: '5000.00', paid_amount: '1000.00', pending_amount: '4000.00',
};

// eslint-disable-next-line import/first
import Payments from '../pages/Payments';

let container; let root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(Payments, { type: 'client' })); });
}

const buttons = (text) => [...container.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().toLowerCase().includes(text.toLowerCase()));
// The row action and the dialog's submit share the label "Post payment"; the dialog is rendered
// after the table, so its control is the LAST match. Picking the first one silently re-opened the
// dialog instead of submitting it.
const byText = (text) => buttons(text)[buttons(text).length - 1];
const rowAction = (text) => buttons(text)[0];
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const openDialog = async () => { await click(rowAction('Post payment')); };
const dialogSubmit = () => byText('Post payment');

beforeEach(() => {
  mockPosts.length = 0;
  mockPostImpl = async () => ({ data: { replayed: false } });
  document.body.innerHTML = '';
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });

test('a double-click mockPosts exactly ONE payment', async () => {
  await mount();
  await openDialog();
  const submit = dialogSubmit();
  // Two clicks in the same tick: `disabled` repaints a frame later, so only a synchronous guard
  // can stop the second one.
  await act(async () => {
    submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(mockPosts).toHaveLength(1);
});

test('every post carries an idempotency key', async () => {
  await mount();
  await openDialog();
  await click(dialogSubmit());
  expect(mockPosts).toHaveLength(1);
  expect(typeof mockPosts[0][1].idempotencyKey).toBe('string');
  expect(mockPosts[0][1].idempotencyKey.length).toBeGreaterThan(8);
});

test('an unknown outcome keeps the SAME key on retry - it never becomes a second payment', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { const error = new Error('Network Error'); throw error; };   // no response at all
  await click(dialogSubmit());
  expect(mockPosts).toHaveLength(1);
  const firstKey = mockPosts[0][1].idempotencyKey;

  mockPostImpl = async () => ({ data: { replayed: true } });
  const retry = byText('Retry same payment');
  expect(retry).toBeTruthy();
  await click(retry);

  expect(mockPosts).toHaveLength(2);
  expect(mockPosts[1][1].idempotencyKey).toBe(firstKey);
  expect(mockPosts[1][1].amount).toBe(mockPosts[0][1].amount);
});

test('a 5xx is also treated as unknown, not as a definite failure', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { const error = new Error('boom'); error.response = { status: 502, data: {} }; throw error; };
  await click(dialogSubmit());
  expect(byText('Retry same payment')).toBeTruthy();
});

test('a definite 4xx refusal keeps the entered values and offers no replay', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { const error = new Error('x'); error.response = { status: 409, data: { error: 'Payment exceeds remaining balance' } }; throw error; };
  await click(dialogSubmit());
  expect(byText('Retry same payment')).toBeFalsy();          // nothing to reconcile
  expect(container.textContent).toContain('Payment exceeds remaining balance');
  expect(container.querySelector('.bcrm-paycontext')).toBeTruthy();   // the form is still open
});

const setValue = async (selector, value) => {
  const field = container.querySelector(selector);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

// The previous version of this test completed a SUCCESSFUL payment, let the dialog close, then
// reopened a new one and observed a different key. That only proved that two separate operations
// get separate identities - it never exercised the edit-then-retry boundary it claimed to cover.
// This one keeps ONE dialog open across a definite refusal and inspects the keys actually sent.
test('after a definite refusal, EDITING the amount sends a different key', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { const error = new Error('x'); error.response = { status: 409, data: { error: 'Payment exceeds remaining balance' } }; throw error; };
  await click(dialogSubmit());
  expect(mockPosts).toHaveLength(1);
  const firstKey = mockPosts[0][1].idempotencyKey;
  const firstAmount = mockPosts[0][1].amount;

  // same dialog, edited amount - the server's replay check compares amount, so reusing the key
  // here would be rejected as PAYMENT_IDEMPOTENCY_CONFLICT instead of posting the corrected figure
  await setValue('input[inputmode="decimal"]', '250.00');
  await click(dialogSubmit());

  expect(mockPosts).toHaveLength(2);
  expect(mockPosts[1][1].amount).toBe('250.00');
  expect(mockPosts[1][1].amount).not.toBe(firstAmount);
  expect(mockPosts[1][1].idempotencyKey).not.toBe(firstKey);
});

test('after a definite refusal, retrying UNCHANGED keeps the same key', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { const error = new Error('x'); error.response = { status: 400, data: { error: 'Payment must be greater than zero' } }; throw error; };
  await click(dialogSubmit());
  await click(dialogSubmit());
  expect(mockPosts).toHaveLength(2);
  // the key tracks the PAYLOAD, not the number of clicks
  expect(mockPosts[1][1].idempotencyKey).toBe(mockPosts[0][1].idempotencyKey);
  expect(mockPosts[1][1].amount).toBe(mockPosts[0][1].amount);
});

// ── the server COMMITTED and the answer was lost ───────────────────────────────────────────────
test('a committed-but-unanswered payment is reconciled, never replaced under a new identity', async () => {
  await mount();
  await openDialog();
  // the write lands; the response never arrives
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await click(dialogSubmit());
  const originalKey = mockPosts[0][1].idempotencyKey;
  const originalAmount = mockPosts[0][1].amount;

  // the operator reaches for the escape hatch. It must NOT mint a fresh identity for money that
  // may already be recorded.
  const check = byText('Check this payment first');
  expect(check).toBeTruthy();
  expect(byText('Start a new payment')).toBeFalsy();

  mockPostImpl = async () => ({ data: { replayed: true } });
  await click(check);

  expect(mockPosts).toHaveLength(2);
  expect(mockPosts[1][1].idempotencyKey).toBe(originalKey);
  expect(mockPosts[1][1].amount).toBe(originalAmount);
  expect(container.textContent).toMatch(/reconciled to the original payment/i);
  // and only after the answer is known is a further payment offered - deliberately, from the row
  expect(container.textContent).toMatch(/use Post payment on the refreshed row/i);
});

test('closing the dialog while unresolved is refused, not silently accepted', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await click(dialogSubmit());

  const cancel = byText('Cancel');
  if (cancel) await click(cancel);
  // the dialog is still open and says plainly that the outcome is unestablished
  expect(container.querySelector('.bcrm-paycontext')).toBeTruthy();
  expect(container.textContent).toMatch(/still unreconciled|outcome unknown/i);
});

test('a failed reconcile leaves the operation unresolved rather than pretending it settled', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await click(dialogSubmit());
  await click(byText('Check this payment first'));          // still no answer
  expect(mockPosts).toHaveLength(2);
  expect(mockPosts[1][1].idempotencyKey).toBe(mockPosts[0][1].idempotencyKey);
  expect(byText('Retry same payment')).toBeTruthy();        // still in the unresolved state
  expect(container.querySelector('input[inputmode="decimal"]').disabled).toBe(true);
});

test('while the outcome is unknown the fields are locked, so no replacement payment can be typed', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => { throw new Error('Network Error'); };
  await click(dialogSubmit());

  const amount = container.querySelector('input[inputmode="decimal"]');
  expect(amount.disabled).toBe(true);
  expect(container.textContent).toMatch(/outcome unknown/i);
});

test('a replayed response is reported honestly, never as a fresh save', async () => {
  await mount();
  await openDialog();
  mockPostImpl = async () => ({ data: { replayed: true } });
  await click(dialogSubmit());
  expect(container.textContent).toMatch(/reconciled to the original payment/i);
  expect(container.textContent).not.toMatch(/^Payment recorded\.$/);
  // and it states plainly that edited metadata was not applied
  expect(container.textContent).toMatch(/were not applied/i);
});

test('the form is cleared only after a confirmed outcome', async () => {
  await mount();
  await openDialog();
  expect(container.querySelector('.bcrm-paycontext')).toBeTruthy();
  mockPostImpl = async () => ({ data: { replayed: false } });
  await click(dialogSubmit());
  expect(container.querySelector('.bcrm-paycontext')).toBeFalsy();
  expect(container.textContent).toMatch(/Payment recorded/);
});

test('the dialog shows party, invoice, outstanding and the resulting balance', async () => {
  await mount();
  await openDialog();
  const context = container.querySelector('.bcrm-paycontext');
  expect(context.textContent).toContain('Synthetic Client');
  expect(context.textContent).toContain('INV-001');
  expect(context.textContent).toMatch(/Outstanding now/);
  expect(context.textContent).toMatch(/After this payment/);
});

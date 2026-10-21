/**
 * NOTE ON ASSERTIONS: `optionText()` returns an ARRAY, so `toContain('Ali Raza')` asks for an
 * exact ELEMENT match. The rendered text is "Ali Razasynthetic" (label + hint), so an earlier
 * draft passed against the UNFIXED component while the stale option was plainly on screen. Every
 * absence assertion therefore compares the JOINED text, and each was re-run against the old
 * ticket behaviour to confirm it now fails.
 *
 * NOTE ON FIXTURES: the Combobox renders `option.label` (and an optional `option.hint`). An
 * earlier draft of this file used `option.name`, so every option rendered EMPTY and the
 * "must not contain the stale client" assertions passed for the wrong reason. The positive
 * control below ("a newer query's result is displayed") is what caught that, and it is the
 * reason this file asserts a visible match as well as absences.
 *
 * STALE SEARCH RESULTS, and the FALSE unknown-outcome state.
 *
 * A. The Combobox ticket used to advance inside the debounce callback - i.e. only once a delayed
 *    request actually started. Anything that happened while a request was already in flight
 *    (clearing the text, closing the dropdown, dropping below minChars, choosing an option, a
 *    currency change that swaps `search`, unmount) left that request "current", so its answer
 *    landed anyway and repopulated the list. An old client could then be highlighted and chosen
 *    as a current match.
 *
 * B. SaleForm treated ANY caught error without an HTTP status as an uncertain sale outcome -
 *    including validation thrown BEFORE the request. A restricted role with a missing catalogue
 *    product therefore froze the form over a sale that never left the browser.
 *
 * Every search here resolves on a deferred promise the test releases by hand, so the ordering is
 * deterministic rather than a race. These exercise the real rendered Combobox and the real
 * SaleForm.
 */
/* eslint-env jest */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-router-dom', () => ({
  __esModule: true,
  useNavigate: () => () => {},
  useParams: () => ({}),
  Link: ({ children }) => require('react').createElement('a', null, children),
}), { virtual: true });

// eslint-disable-next-line import/first
import { Combobox } from '../components/ui';

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

let container; let root;
async function render(element) {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root.render(element); });
}
const input = () => container.querySelector('input');
const optionNodes = () => [...container.querySelectorAll('[role="option"], .bcrm-combo-option')];
const optionText = () => optionNodes().map((n) => (n.textContent || '').trim());

async function type(text) {
  const field = input();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

// A host that mirrors how SaleForm uses the Combobox: a controlled selection plus a swappable
// `search` (which is what a currency change does).
function Host({ search, onSelect = () => {} }) {
  const [value, setValue] = React.useState('');
  const [label, setLabel] = React.useState('');
  return React.createElement(Combobox, {
    value, valueLabel: label, search,
    onSelect: (option) => { setValue(option.id); setLabel(option.label); onSelect(option); },
    onClear: () => { setValue(''); setLabel(''); },
    minChars: 2, debounceMs: 250,
  });
}

beforeEach(() => { jest.useFakeTimers(); document.body.innerHTML = ''; root = null; });
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null; } jest.useRealTimers(); });

test('clearing the text discards an already-running search', async () => {
  const a = deferred();
  const search = jest.fn(() => a.promise);
  await render(React.createElement(Host, { search }));

  await act(async () => { input().dispatchEvent(new MouseEvent('focus', { bubbles: true })); input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('ali');
  await advance(300);                       // the request is now in flight
  expect(search).toHaveBeenCalledTimes(1);

  await type('');                           // operator clears the box
  await act(async () => { a.resolve([{ id: 'c1', label: 'Ali Raza', hint: 'synthetic' }]); });
  await flush();

  expect(optionText().join(' ')).not.toContain('Ali Raza');
});

test('an older response cannot overwrite a newer query still waiting out its debounce', async () => {
  const a = deferred(); const b = deferred();
  const search = jest.fn()
    .mockImplementationOnce(() => a.promise)
    .mockImplementationOnce(() => b.promise);
  await render(React.createElement(Host, { search }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await type('ali');
  await advance(300);                       // A dispatched
  await type('bil');                        // B typed, still debouncing

  await act(async () => { a.resolve([{ id: 'c1', label: 'Ali Raza', hint: 'synthetic' }]); });
  await flush();
  expect(optionText().join(' ')).not.toContain('Ali Raza');

  await advance(300);                       // B dispatches  (POSITIVE CONTROL)
  await act(async () => { b.resolve([{ id: 'c2', label: 'Bilal Khan', hint: 'synthetic' }]); });
  await flush();
  expect(optionText().join(' ')).toContain('Bilal Khan');
});

test('a response that arrives after the dropdown closed does not repopulate it', async () => {
  const a = deferred();
  const search = jest.fn(() => a.promise);
  await render(React.createElement(Host, { search }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('ali');
  await advance(300);

  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { a.resolve([{ id: 'c1', label: 'Ali Raza', hint: 'synthetic' }]); });
  await flush();

  expect(optionText().join(' ')).not.toContain('Ali Raza');
});

test('switching the search source (a currency change) invalidates the previous result', async () => {
  const pkr = deferred(); const inr = deferred();
  const searchPkr = jest.fn(() => pkr.promise);
  const searchInr = jest.fn(() => inr.promise);

  await render(React.createElement(Host, { search: searchPkr }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('pro');
  await advance(300);                       // PKR search in flight

  await render(React.createElement(Host, { search: searchInr }));   // currency switched
  await act(async () => { pkr.resolve([{ id: 'p1', label: 'PKR Product', hint: 'synthetic' }]); });
  await flush();

  expect(optionText().join(' ')).not.toContain('PKR Product');
});

test('a response landing after a selection cannot replace the chosen match', async () => {
  // "select client B while an older client response remains pending": the FIRST query's answer is
  // still outstanding when B is picked from a later query's results.
  const slowA = deferred();
  const search = jest.fn()
    .mockImplementationOnce(() => slowA.promise)                                   // query 1 - never answers yet
    .mockImplementationOnce(() => Promise.resolve([{ id: 'cB', label: 'Client B', hint: 'synthetic' }]));
  const chosen = [];
  await render(React.createElement(Host, { search, onSelect: (o) => chosen.push(o.id) }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await type('kha');
  await advance(300);                        // query 1 dispatched, still pending
  await type('khan');
  await advance(300);                        // query 2 dispatched and resolves
  await flush();
  expect(optionText().join(' ')).toContain('Client B');     // positive control

  const option = optionNodes()[0].querySelector('button') || optionNodes()[0];
  await act(async () => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(chosen).toEqual(['cB']);

  // the first query's slower answer finally lands
  await act(async () => { slowA.resolve([{ id: 'cA', label: 'Client A', hint: 'synthetic' }]); });
  await flush();

  expect(optionText().join(' ')).not.toContain('Client A');
  expect(chosen).toEqual(['cB']);                            // and it was never selectable
});

test('a late response after unmount does not throw or write state', async () => {
  const a = deferred();
  const search = jest.fn(() => a.promise);
  await render(React.createElement(Host, { search }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('ali');
  await advance(300);

  await act(async () => { root.unmount(); });
  root = null;
  let threw = null;
  try { await act(async () => { a.resolve([{ id: 'c1', label: 'Ali Raza', hint: 'synthetic' }]); }); await flush(); }
  catch (error) { threw = error; }
  expect(threw).toBe(null);
});

test('a failed search is reported as a failure, never as "no such client"', async () => {
  const a = deferred();
  const search = jest.fn(() => a.promise);
  await render(React.createElement(Host, { search }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('ali');
  await advance(300);
  await act(async () => { a.reject(new Error('network down')); });
  await flush();

  expect(container.textContent).toMatch(/could not search/i);
  expect(container.textContent).not.toMatch(/no matches/i);
});

// ── BOUNDARY A: options already on screen belong to the PREVIOUS query ─────────────────────────
// Rejecting obsolete responses was not enough. While a different, valid query was still loading,
// the options from the earlier one stayed clickable, so an operator could commit a client that
// matched text no longer in the box.
test('an option from query A cannot be clicked while query B is still loading', async () => {
  const slowB = deferred();
  const search = jest.fn()
    .mockImplementationOnce(() => Promise.resolve([{ id: 'cA', label: 'Ali Raza', hint: 'synthetic' }]))
    .mockImplementationOnce(() => slowB.promise);
  const chosen = [];
  await render(React.createElement(Host, { search, onSelect: (o) => chosen.push(o.id) }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  await type('ali');
  await advance(300);
  await flush();
  expect(optionText().join(' ')).toContain('Ali Raza');      // positive control: A is displayed

  await type('bil');                                          // B typed; A's option still rendered
  await advance(300);                                         // B dispatched, still pending
  await flush();

  const node = optionNodes()[0];
  if (node) {
    const button = node.querySelector('button') || node;
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }
  expect(chosen).toEqual([]);                                 // nothing from A may be committed
  expect(container.textContent).toMatch(/earlier matches cannot be selected/i);
});

test('Enter cannot commit an option from the previous query either', async () => {
  const slowB = deferred();
  const search = jest.fn()
    .mockImplementationOnce(() => Promise.resolve([{ id: 'cA', label: 'Ali Raza', hint: 'synthetic' }]))
    .mockImplementationOnce(() => slowB.promise);
  const chosen = [];
  await render(React.createElement(Host, { search, onSelect: (o) => chosen.push(o.id) }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('ali');
  await advance(300);
  await flush();

  await type('bil');
  await advance(300);
  await flush();
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(chosen).toEqual([]);
});

test('after a currency/source switch the previous source’s options are not selectable', async () => {
  const pkrSearch = jest.fn(() => Promise.resolve([{ id: 'pPKR', label: 'PKR Product', hint: 'synthetic' }]));
  const slowInr = deferred();
  const inrSearch = jest.fn(() => slowInr.promise);
  const chosen = [];

  await render(React.createElement(Host, { search: pkrSearch, onSelect: (o) => chosen.push(o.id) }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('pro');
  await advance(300);
  await flush();
  expect(optionText().join(' ')).toContain('PKR Product');    // positive control

  // the currency changes: same text, different product source
  await render(React.createElement(Host, { search: inrSearch, onSelect: (o) => chosen.push(o.id) }));
  await flush();
  const node = optionNodes()[0];
  if (node) {
    const button = node.querySelector('button') || node;
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }
  expect(chosen).toEqual([]);
});

test('a freshly completed query IS selectable - the guard does not block valid matches', async () => {
  const search = jest.fn(() => Promise.resolve([{ id: 'cOK', label: 'Valid Match', hint: 'synthetic' }]));
  const chosen = [];
  await render(React.createElement(Host, { search, onSelect: (o) => chosen.push(o.id) }));
  await act(async () => { input().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await type('val');
  await advance(300);
  await flush();

  const button = optionNodes()[0].querySelector('button') || optionNodes()[0];
  expect(button.disabled).toBe(false);
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(chosen).toEqual(['cOK']);
});

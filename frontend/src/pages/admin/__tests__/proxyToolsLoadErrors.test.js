/**
 * The vault + assignment section at the bottom of the WriteHuman admin page loads three
 * independent things. Promise.all discarded all three whenever any one rejected, so a single slow
 * call blanked the whole section — which is how it appeared to vanish while two of its three calls
 * were fine. These pin that a partial failure stays partial, and that the existing classifications
 * are not lost.
 */
/* eslint-env jest */
const { describeLoadFailures } = require('../proxyToolsLoadErrors');

const ok = () => ({ status: 'fulfilled', value: { data: {} } });
const fail = (reason) => ({ status: 'rejected', reason });
const http = (status, error) => ({ response: { status, data: error ? { error } : {} } });
const offline = () => ({ message: 'Network Error' });   // axios: no .response at all

test('nothing failed -> no message at all', () => {
  expect(describeLoadFailures([['stats', ok()], ['accounts', ok()], ['clients', ok()]])).toBeNull();
  expect(describeLoadFailures([])).toBeNull();
  expect(describeLoadFailures(null)).toBeNull();
});

test('ONE failure names that part and says the rest is still shown', () => {
  const msg = describeLoadFailures([
    ['stats', fail(offline())], ['accounts', ok()], ['clients', ok()],
  ]);
  expect(msg).toMatch(/partly unavailable/i);
  expect(msg).toMatch(/stats: could not reach the server/);
  expect(msg).toMatch(/rest of the section is still shown/i);
  // The parts that loaded are NOT named as failures.
  expect(msg).not.toMatch(/accounts:/);
  expect(msg).not.toMatch(/clients:/);
});

test('the account vault surviving a stats outage is the whole point', () => {
  const msg = describeLoadFailures([
    ['stats', fail(http(500, 'boom'))], ['accounts', ok()], ['clients', ok()],
  ]);
  expect(msg).toMatch(/stats: HTTP 500 — boom/);
  expect(msg).not.toMatch(/^Failed to load Proxy Tools/);
});

test('two failures are both named', () => {
  const msg = describeLoadFailures([
    ['stats', fail(http(404))], ['accounts', ok()], ['clients', fail(offline())],
  ]);
  expect(msg).toMatch(/stats: route unavailable \(404\)/);
  expect(msg).toMatch(/clients: could not reach the server/);
  expect(msg).not.toMatch(/accounts:/);
});

test('all three down for the same reason reads as one outage, not three lines', () => {
  const msg = describeLoadFailures([
    ['stats', fail(offline())], ['accounts', fail(offline())], ['clients', fail(offline())],
  ]);
  expect(msg).toBe('Failed to load Proxy Tools — could not reach the server.');
});

test('the 404 classification is preserved — a stale backend deploy still reads as such', () => {
  const all404 = describeLoadFailures([
    ['stats', fail(http(404))], ['accounts', fail(http(404))], ['clients', fail(http(404))],
  ]);
  expect(all404).toMatch(/route unavailable \(404\)/);
  // The backend's own wording is recognised too, not just the status code.
  const byMessage = describeLoadFailures([['stats', fail(http(500, 'Route not found'))], ['accounts', ok()], ['clients', ok()]]);
  expect(byMessage).toMatch(/stats: route unavailable \(404\)/);
});

test('all three down for DIFFERENT reasons lists each one', () => {
  const msg = describeLoadFailures([
    ['stats', fail(http(404))], ['accounts', fail(http(500))], ['clients', fail(offline())],
  ]);
  expect(msg).toMatch(/partly unavailable/i);
  expect(msg).toMatch(/stats: route unavailable/);
  expect(msg).toMatch(/accounts: HTTP 500/);
  expect(msg).toMatch(/clients: could not reach/);
});

test('a malformed rejection does not throw', () => {
  expect(() => describeLoadFailures([['stats', fail(undefined)], ['accounts', ok()], ['clients', ok()]])).not.toThrow();
  expect(describeLoadFailures([['stats', fail(undefined)], ['accounts', ok()], ['clients', ok()]]))
    .toMatch(/stats: could not reach the server/);
});

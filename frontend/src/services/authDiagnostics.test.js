/**
 * Regression tests for the centralized error sanitizer (authDiagnostics.sanitizeError).
 *
 * These lock in the security fix behind the "[API_CONNECTION_FAILED]" leak: NO failure —
 * network, timeout, DNS/CORS, 4xx, or 5xx — may ever surface the API host, an internal
 * [CODE], a stack trace, a raw server response body, or troubleshooting steps to a member.
 *
 * Run with:  CI=true npx craco test src/services/authDiagnostics.test.js --watchAll=false
 */
import { sanitizeError, SAFE_GENERIC_MESSAGE } from './authDiagnostics';

// Anything that would betray an internal detail to a production member. Every user-facing
// message the sanitizer produces must fail to match ALL of these.
const LEAK_PATTERNS = [
  /genzdigitalstore/i,   // API host / any of our hostnames
  /https?:\/\//i,        // a URL
  /\[[A-Z0-9_]+\]/,      // a bracketed internal [CODE]
  /\bapi\b/i,            // the word "api"
  /VPN|firewall|ad-?blocker|antivirus|incognito|private window/i, // troubleshooting steps
  /stack|trace|econnaborted|err_network|cors/i, // transport internals / stack traces
  /localhost|127\.0\.0\.1/i,
];

function expectNoLeak(message) {
  expect(typeof message).toBe('string');
  expect(message.length).toBeGreaterThan(0);
  for (const re of LEAK_PATTERNS) {
    expect(message).not.toMatch(re);
  }
}

// Axios-shaped error factories.
const networkError = () => ({ code: 'ERR_NETWORK', request: {}, message: 'Network Error' }); // no response
const timeoutError = () => ({ code: 'ECONNABORTED', request: {}, message: 'timeout of 6000ms exceeded' });
const httpError = (status, data = {}) => ({ response: { status, data } });

describe('sanitizeError — no user-facing leak', () => {
  const cases = [
    ['network / DNS / CORS / cert (no response)', networkError()],
    ['client-side timeout', timeoutError()],
    ['401 invalid credentials', httpError(401, { code: 'INVALID_CREDENTIALS', error: 'Invalid email or password' })],
    ['403 forbidden (with server body)', httpError(403, { error: 'Account suspended: internal note XYZ' })],
    ['404 route not found', httpError(404, { error: 'Route /api/crm/foo not found' })],
    ['409 account exists', httpError(409, { error: 'duplicate key user@example.com' })],
    ['429 rate limited', httpError(429, {})],
    ['500 server error (leaky body)', httpError(500, { error: 'ECONNREFUSED api.genzdigitalstore.com:3306', stack: 'at db.js:42' })],
    ['503 gateway (leaky body)', httpError(503, { error: 'upstream https://api.genzdigitalstore.com down' })],
    ['device pending', httpError(403, { code: 'DEVICE_PENDING' })],
    ['device blocked', httpError(403, { code: 'DEVICE_BLOCKED' })],
    ['unknown / thrown non-axios value', new Error('boom at api.genzdigitalstore.com')],
  ];

  test.each(cases)('%s → userMessage leaks nothing', (_label, err) => {
    const { userMessage } = sanitizeError(err);
    expectNoLeak(userMessage);
  });
});

describe('sanitizeError — correct classification', () => {
  test('network failure is a connection failure with the safe generic message', () => {
    const r = sanitizeError(networkError());
    expect(r.connection).toBe(true);
    expect(r.code).toBe('API_CONNECTION_FAILED');
    expect(r.userMessage).toBe(SAFE_GENERIC_MESSAGE);
  });

  test('offline device is classified as a connection failure', () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    try {
      const r = sanitizeError({ message: 'Network Error' });
      expect(r.connection).toBe(true);
      expect(r.code).toBe('API_CONNECTION_FAILED');
      expect(r.userMessage).toBe(SAFE_GENERIC_MESSAGE);
    } finally {
      if (original) Object.defineProperty(window.navigator, 'onLine', original);
      else Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
    }
  });

  test('timeout is a connection failure (TIMEOUT code) with the safe generic message', () => {
    const r = sanitizeError(timeoutError());
    expect(r.connection).toBe(true);
    expect(r.code).toBe('TIMEOUT');
    expect(r.userMessage).toBe(SAFE_GENERIC_MESSAGE);
  });

  test('401 → wrong-credentials message, not a connection failure, no bracketed code', () => {
    const r = sanitizeError(httpError(401, {}));
    expect(r.connection).toBe(false);
    expect(r.code).toBe('WRONG_CREDENTIALS');
    expect(r.userMessage).toMatch(/incorrect email or password/i);
    expectNoLeak(r.userMessage);
  });

  test('500 → generic safe message and never echoes the server body', () => {
    const r = sanitizeError(httpError(500, { error: 'secret db string api.genzdigitalstore.com' }));
    expect(r.connection).toBe(false);
    expect(r.userMessage).toBe(SAFE_GENERIC_MESSAGE);
  });

  test('device-pending keeps an actionable (non-leaky) message', () => {
    const r = sanitizeError(httpError(403, { code: 'DEVICE_PENDING' }));
    expect(r.code).toBe('NEW_DEVICE_PENDING');
    expect(r.userMessage).toMatch(/new device/i);
    expectNoLeak(r.userMessage);
  });
});

describe('on-screen diagnostics gating (non-development build)', () => {
  afterEach(() => {
    try { window.localStorage.removeItem('genz_login_debug'); } catch (_) { /* ignore */ }
  });

  // jest runs with NODE_ENV='test' (i.e. NOT 'development'), which mirrors the deployed
  // production bundle: diagnosticsVisible() is false, so the on-screen devMessage the pages
  // render is identical to the safe userMessage.
  test('devMessage equals the safe userMessage outside a development build', () => {
    const r = sanitizeError(networkError());
    expect(r.devMessage).toBe(r.userMessage);
    expectNoLeak(r.devMessage);
  });

  test('the ?debug / localStorage opt-in NEVER leaks internals on screen in production', () => {
    // The opt-in enables the rich CONSOLE dump (support tool) but must not change the
    // on-screen text in a non-development build — the security guarantee is unconditional.
    window.localStorage.setItem('genz_login_debug', '1');
    const r = sanitizeError(networkError());
    expect(r.devMessage).toBe(r.userMessage);
    expectNoLeak(r.devMessage);
  });
});

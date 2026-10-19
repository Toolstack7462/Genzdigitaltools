/**
 * The "Sign-in" badge must never be green without evidence.
 *
 * The row previously recognised exactly one negative — sessionState === 'LOGIN_REQUIRED' — and
 * painted everything else "signed in". The first three tests here fail against that logic and are
 * the ones that matter: an account whose Session row says "no session", one whose renewal has
 * stalled, and one whose source browser reported holding NO auth cookies all showed green.
 */
/* eslint-env jest */
const { signInDisplay, SIGNED_IN_STATES } = require('../writeHumanSignIn');

const cookies = (n) => ({ browserAuthCookies: n });

describe('evidence of being signed in', () => {
  test('HEALTHY with cookies is the only ordinary green', () => {
    const r = signInDisplay(cookies(4), 'HEALTHY');
    expect(r).toEqual({ label: 'signed in', tone: 'ok', established: true });
  });

  test('REFRESHING is still signed in — a renewal in flight over a live session', () => {
    expect(signInDisplay(cookies(4), 'REFRESHING').tone).toBe('ok');
  });

  test('the signed-in set is exactly those two', () => {
    expect([...SIGNED_IN_STATES].sort()).toEqual(['HEALTHY', 'REFRESHING']);
  });
});

describe('the states that used to go green', () => {
  test('ERROR — whose own row reads "no session" — is NOT signed in', () => {
    const r = signInDisplay(cookies(4), 'ERROR');
    expect(r.tone).not.toBe('ok');
    expect(r.established).toBe(false);
    expect(r.label).toMatch(/not established/);
  });

  test('STALLED is not signed in either', () => {
    const r = signInDisplay(cookies(4), 'STALLED');
    expect(r.tone).not.toBe('ok');
    expect(r.label).toMatch(/not established/);
  });

  test('an absent session state is not signed in', () => {
    const r = signInDisplay(cookies(4), null);
    expect(r.tone).toBe('mut');
    expect(r.label).toBe('not established');
    expect(r.established).toBe(false);
  });

  test('an unrecognised state is not signed in, and is named', () => {
    const r = signInDisplay(cookies(4), 'SOMETHING_NEW');
    expect(r.tone).not.toBe('ok');
    expect(r.label).toMatch(/something_new/);
  });
});

describe('what the source browser reported', () => {
  test('browserAuthCookies === false means signed OUT, not signed in', () => {
    const r = signInDisplay({ browserAuthCookies: false }, 'HEALTHY');
    expect(r.tone).toBe('bad');
    expect(r.label).toMatch(/no auth cookies/);
  });

  test('zero cookies is the same answer', () => {
    expect(signInDisplay(cookies(0), 'HEALTHY').tone).toBe('bad');
  });

  test('nothing reported stays unknown, and says why when a device is silent', () => {
    expect(signInDisplay({ browserAuthCookies: null }, 'HEALTHY')).toEqual({
      label: 'unknown', tone: 'mut', established: false,
    });
    expect(signInDisplay({ browserAuthCookies: undefined, telemetryFrozen: true }, 'HEALTHY').label)
      .toBe('unknown · no device reporting');
  });

  test('an explicit LOGIN_REQUIRED still reads signed out', () => {
    expect(signInDisplay(cookies(4), 'LOGIN_REQUIRED')).toEqual({
      label: 'signed out', tone: 'bad', established: true,
    });
  });

  test('a missing account object does not throw', () => {
    expect(() => signInDisplay(undefined, undefined)).not.toThrow();
    expect(signInDisplay().tone).toBe('mut');
  });
});

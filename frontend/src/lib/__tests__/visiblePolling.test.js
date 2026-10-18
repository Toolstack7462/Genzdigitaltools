// Background tabs must not keep polling the backend.
//
// ClientDashboardEnhanced ran two fixed 45s setIntervals. Its visibilitychange handler only added an
// EXTRA immediate poll when the tab came back — it never stopped the interval — so an open-but-hidden
// dashboard kept hitting the API for as long as the tab existed. pollNotifications() alone issues
// three requests per tick (/client/announcements, /client/extension-notice,
// /extension/version-info), which is the bulk of a dashboard's background request volume and is paid
// per open tab by every client at once.
//
// These tests pin the contract: no ticks while hidden, an immediate catch-up poll on return, the
// visible cadence unchanged, and every timer/listener released on stop.
import { startVisiblePolling } from '../visiblePolling';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('startVisiblePolling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('polls on the given cadence while visible', () => {
    const fn = jest.fn();
    const stop = startVisiblePolling(fn, 45000);
    expect(fn).not.toHaveBeenCalled();            // mount schedules only; caller owns initial load
    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(90000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  test('stops completely while the tab is hidden', () => {
    const fn = jest.fn();
    const stop = startVisiblePolling(fn, 45000);
    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    const atHide = fn.mock.calls.length;
    jest.advanceTimersByTime(45000 * 20);          // 15 minutes in a background tab
    expect(fn).toHaveBeenCalledTimes(atHide);      // ZERO further requests
    stop();
  });

  test('catches up immediately when the tab becomes visible again', () => {
    const fn = jest.fn();
    const stop = startVisiblePolling(fn, 45000);
    setVisibility('hidden');
    jest.advanceTimersByTime(45000 * 5);
    const atHide = fn.mock.calls.length;

    setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(atHide + 1);  // fresh data before anyone can read a stale screen

    jest.advanceTimersByTime(45000);               // and the cadence resumes
    expect(fn).toHaveBeenCalledTimes(atHide + 2);
    stop();
  });

  test('does not stack duplicate intervals across repeated show events', () => {
    const fn = jest.fn();
    const stop = startVisiblePolling(fn, 45000, { pollOnShow: false });
    for (let i = 0; i < 5; i++) setVisibility('visible');   // already visible
    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);                    // one interval, not six
    stop();
  });

  test('stop() releases the timer and the listeners', () => {
    const fn = jest.fn();
    const stop = startVisiblePolling(fn, 45000);
    stop();
    jest.advanceTimersByTime(45000 * 10);
    expect(fn).not.toHaveBeenCalled();
    setVisibility('visible');                     // a late event must not revive it
    expect(fn).not.toHaveBeenCalled();
  });

  test('a throwing poll does not break the schedule', () => {
    const fn = jest.fn(() => { throw new Error('network'); });
    const stop = startVisiblePolling(fn, 45000);
    setVisibility('hidden');
    expect(() => setVisibility('visible')).not.toThrow();
    jest.advanceTimersByTime(45000);
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  test('ignores nonsense arguments instead of throwing', () => {
    expect(typeof startVisiblePolling(null, 1000)).toBe('function');
    expect(typeof startVisiblePolling(() => {}, 0)).toBe('function');
  });
});

// The dashboard must actually USE it — otherwise the helper is dead code and the background tab
// keeps polling. This is the regression that reintroduces the original defect.
describe('ClientDashboardEnhanced uses visibility-gated polling', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/pages/client/ClientDashboardEnhanced.js'), 'utf8');

  test('the notification poll is visibility-gated, not a bare setInterval', () => {
    expect(src).toMatch(/startVisiblePolling\(/);
    expect(src).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*\{\s*pollNotifications\(\);\s*\}/);
  });

  // The in-flight guard is only as good as the promise it waits on. pollNotifications issues three
  // requests; if it resolves on the first, the guard releases while two are still in flight.
  test('pollNotifications awaits ALL THREE of its requests, not just the first', () => {
    const body = src.slice(src.indexOf('const pollNotifications'),
                           src.indexOf('}, [getDismissedAnnouncementIds, showInfo]);'));
    expect(body).toMatch(/await Promise\.all\(\[/);
    for (const ep of ['/client/announcements', '/client/extension-notice', 'getLatestExtension(']) {
      expect(body).toContain(ep);
    }
    // No request may be left as a floating statement outside the awaited group.
    expect(body).not.toMatch(/\n\s*api\.get\([^\n]*\)\.then\([^\n]*\);/);
    expect(body).not.toMatch(/\n\s*getLatestExtension\([^\n]*\)\.then\([^\n]*\);/);
  });
});

// ── Event pairing and overlap ────────────────────────────────────────────────────────────────────
//
// Two defects in the first version of this helper, both of which multiply the request volume the
// gating was added to reduce:
//
//  1. PAIRED EVENTS. One user action — switching back to the tab — fires BOTH `visibilitychange`
//     AND `focus`. Both were wired to the same handler, so a single return ran the poll twice. On
//     the dashboard that is two full groups, i.e. SIX backend requests for one tab switch. The
//     original "no stacked duplicate intervals" test missed this because it passed
//     `pollOnShow: false`, so it only ever checked interval identity, never callback count.
//
//  2. OVERLAP. Nothing tracked whether a poll was still running, so an interval tick (or a focus
//     event) could start a second group while the first was still in flight — concurrent duplicate
//     requests, and later responses racing earlier ones into state.
//
// The in-flight guard must span the WHOLE request group. pollNotifications awaited only its first
// request and left the other two as floating promises, so a guard keyed on its returned promise
// would have released while two requests were still outstanding.
describe('startVisiblePolling — event pairing and overlap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => { jest.useRealTimers(); });

  const show = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  };

  test('one tab return (visibilitychange + focus) polls ONCE, not twice', () => {
    const fn = jest.fn(() => Promise.resolve());
    const stop = startVisiblePolling(fn, 45000);

    setVisibility('hidden');
    fn.mockClear();

    // Exactly what a browser does for a single user action, in this order.
    show();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));

    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  test('repeated focus events in quick succession collapse to one poll', () => {
    const fn = jest.fn(() => Promise.resolve());
    const stop = startVisiblePolling(fn, 45000);
    fn.mockClear();

    for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  test('a later, separate tab return still polls again', async () => {
    const fn = jest.fn(() => Promise.resolve());
    const stop = startVisiblePolling(fn, 45000);
    fn.mockClear();

    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(1);
    await Promise.resolve();                         // let the group settle, releasing the guard

    // Past the pairing window but short of the 45s interval, so this isolates the dedupe rule
    // from the cadence.
    jest.advanceTimersByTime(2000);
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(2);             // a genuine second return is NOT swallowed
    stop();
  });

  test('does not start a new poll while the previous group is still in flight', async () => {
    let release;
    const fn = jest.fn(() => new Promise((r) => { release = r; }));
    const stop = startVisiblePolling(fn, 45000);

    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(45000);                 // tick while the first is unresolved
    expect(fn).toHaveBeenCalledTimes(1);             // skipped, not queued

    release();
    await Promise.resolve(); await Promise.resolve();

    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(2);             // resumes once the group completed
    stop();
  });

  test('the in-flight guard waits for the WHOLE group, not just the first request', async () => {
    // Mirrors pollNotifications: three requests, and the returned promise must represent all of
    // them. If it settles on the first, the guard releases early and the next tick overlaps.
    let r1; let r2; let r3;
    const fn = jest.fn(() => Promise.all([
      new Promise((r) => { r1 = r; }),
      new Promise((r) => { r2 = r; }),
      new Promise((r) => { r3 = r; }),
    ]));
    const stop = startVisiblePolling(fn, 45000);

    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);

    r1(); await Promise.resolve();                   // first request done, two still outstanding
    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);             // still held

    r2(); r3();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  test('a rejected group releases the guard instead of wedging it shut', async () => {
    let reject;
    const fn = jest.fn(() => new Promise((_, rj) => { reject = rj; }));
    const stop = startVisiblePolling(fn, 45000);

    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(1);

    reject(new Error('offline'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    jest.advanceTimersByTime(45000);
    expect(fn).toHaveBeenCalledTimes(2);             // a failed poll must not stop all future polls
    stop();
  });
});

// ── OPT-IN BOUNDED BACKOFF ────────────────────────────────────────────────────────────────────
// A server refusing requests is not helped by being asked again on the same cadence. With
// maxBackoffSteps > 0 each consecutive FAILED group sits out 2^k - 1 ticks (k capped), and the
// first success restores the normal cadence. Default (0) must behave exactly as before, which the
// tests above already cover.
describe('bounded backoff', () => {
  // Same harness as the suite above, plus a microtask flush: backoff state is decided in the
  // promise handlers, so the pending rejection must settle before the next tick is advanced.
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('default: a failing poll keeps the fixed cadence', async () => {
    let calls = 0;
    const stop = startVisiblePolling(() => { calls += 1; return Promise.reject(new Error('x')); }, 1000);
    for (let i = 0; i < 4; i++) { jest.advanceTimersByTime(1000); await flush(); }
    stop();
    expect(calls).toBe(4);   // no backoff unless asked for
  });

  test('consecutive failures skip an increasing, CAPPED number of ticks', async () => {
    const seen = [];
    const stop = startVisiblePolling(() => { seen.push('try'); return Promise.reject(new Error('x')); },
      1000, { maxBackoffSteps: 3 });
    // tick1 -> attempt (fail, skip 1); tick2 skipped; tick3 attempt (fail, skip 3);
    // ticks 4,5,6 skipped; tick7 attempt (fail, skip 7) …
    const attemptsAfter = [];
    for (let i = 1; i <= 16; i++) { jest.advanceTimersByTime(1000); await flush(); attemptsAfter.push(seen.length); }
    stop();
    expect(attemptsAfter[0]).toBe(1);   // tick 1
    expect(attemptsAfter[1]).toBe(1);   // tick 2 skipped
    expect(attemptsAfter[2]).toBe(2);   // tick 3
    expect(attemptsAfter[5]).toBe(2);   // ticks 4-6 skipped
    expect(attemptsAfter[6]).toBe(3);   // tick 7
    // Capped: never more than 2^3-1 = 7 skipped ticks between attempts.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.length).toBeLessThan(16);
  });

  test('one success resets the cadence immediately', async () => {
    let calls = 0;
    let fail = true;
    const stop = startVisiblePolling(() => {
      calls += 1;
      return fail ? Promise.reject(new Error('x')) : Promise.resolve();
    }, 1000, { maxBackoffSteps: 3 });
    jest.advanceTimersByTime(1000); await flush();   // attempt 1, fails -> skip 1
    expect(calls).toBe(1);
    fail = false;
    jest.advanceTimersByTime(1000); await flush();   // skipped
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1000); await flush();   // attempt 2, succeeds -> reset
    expect(calls).toBe(2);
    jest.advanceTimersByTime(1000); await flush();   // back to every tick
    expect(calls).toBe(3);
    jest.advanceTimersByTime(1000); await flush();
    expect(calls).toBe(4);
    stop();
  });

  test('returning to the tab FORCES a poll even while backing off', async () => {
    // Backing off must never make the page look dead to somebody actually looking at it.
    let calls = 0;
    const stop = startVisiblePolling(() => { calls += 1; return Promise.reject(new Error('x')); },
      1000, { maxBackoffSteps: 3 });
    jest.advanceTimersByTime(1000); await flush();   // attempt 1 -> skip 1
    expect(calls).toBe(1);
    document.dispatchEvent(new Event('visibilitychange'));   // user returns
    await flush();
    expect(calls).toBe(2);
    stop();
  });

  test('backoff never starts a second overlapping group', async () => {
    let active = 0; let maxActive = 0;
    let release;
    const stop = startVisiblePolling(() => {
      active += 1; maxActive = Math.max(maxActive, active);
      return new Promise((_, rej) => { release = () => { active -= 1; rej(new Error('x')); }; });
    }, 1000, { maxBackoffSteps: 3 });
    jest.advanceTimersByTime(1000); await flush();
    jest.advanceTimersByTime(1000); await flush();
    jest.advanceTimersByTime(1000); await flush();
    expect(maxActive).toBe(1);
    release(); await flush();
    stop();
  });
});

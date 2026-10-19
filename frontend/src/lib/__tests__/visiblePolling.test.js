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
});

// Behavioural tests for the launch-attempt owner, with fake timers and deferred responses.
// These reproduce the reported sequences rather than asserting on source text.
import { createLaunchAttempts } from '../launchAttempts';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('createLaunchAttempts — one authoritative result per attempt', () => {
  let a;
  beforeEach(() => { jest.useFakeTimers(); a = createLaunchAttempts(); });
  afterEach(() => { jest.useRealTimers(); });

  test('first failure, then success: the new attempt owns the card and the old one cannot write', () => {
    const t = 'tool-A';
    const first = a.begin(t);
    expect(a.isCurrent(t, first)).toBe(true);

    const second = a.begin(t);               // user clicks again
    expect(a.isCurrent(t, second)).toBe(true);
    expect(a.isCurrent(t, first)).toBe(false); // the first attempt is now stale
  });

  test('an OLDER failure arriving after a NEWER success is ignored', async () => {
    const t = 'tool-A';
    const slowFail = deferred();
    const first = a.begin(t);
    const firstDone = slowFail.promise.then(() => a.isCurrent(t, first));

    const second = a.begin(t);               // newer attempt
    expect(a.isCurrent(t, second)).toBe(true);

    slowFail.resolve();                      // the old rejection finally lands
    await expect(firstDone).resolves.toBe(false);
  });

  test("an old clear-timer firing during a new attempt does NOT clear it", () => {
    const t = 'tool-A';
    const cleared = jest.fn();
    const first = a.begin(t);
    a.scheduleClear(t, first, cleared, 8000);
    expect(a.pendingTimers()).toBe(1);

    a.begin(t);                              // new attempt cancels the old timer
    expect(a.pendingTimers()).toBe(0);
    jest.advanceTimersByTime(20000);
    expect(cleared).not.toHaveBeenCalled();
  });

  test('a clear-timer that survives to fire still re-checks ownership', () => {
    const t = 'tool-A';
    const cleared = jest.fn();
    const first = a.begin(t);
    // schedule, then make it stale WITHOUT going through begin() (e.g. dispose path)
    a.scheduleClear(t, first, cleared, 8000);
    a.dispose();
    jest.advanceTimersByTime(20000);
    expect(cleared).not.toHaveBeenCalled();
  });

  test('a clear-timer for the CURRENT attempt does fire', () => {
    const t = 'tool-A';
    const cleared = jest.fn();
    const id = a.begin(t);
    a.scheduleClear(t, id, cleared, 8000);
    jest.advanceTimersByTime(7999);
    expect(cleared).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(a.pendingTimers()).toBe(0);
  });

  test('settle() drops the timer so nothing fires after a confirmed success', () => {
    const t = 'tool-A';
    const cleared = jest.fn();
    const id = a.begin(t);
    a.scheduleClear(t, id, cleared, 8000);
    a.settle(t);
    jest.advanceTimersByTime(20000);
    expect(cleared).not.toHaveBeenCalled();
  });

  test('two tools are isolated — one result never touches the other card', () => {
    const A = a.begin('tool-A');
    const B = a.begin('tool-B');
    expect(a.isCurrent('tool-A', A)).toBe(true);
    expect(a.isCurrent('tool-B', B)).toBe(true);

    a.begin('tool-A');                       // retry A only
    expect(a.isCurrent('tool-A', A)).toBe(false);
    expect(a.isCurrent('tool-B', B)).toBe(true);  // B is untouched
  });

  test("one tool's clear-timer never clears another tool", () => {
    const clearedA = jest.fn(); const clearedB = jest.fn();
    const A = a.begin('tool-A'); a.scheduleClear('tool-A', A, clearedA, 8000);
    const B = a.begin('tool-B'); a.scheduleClear('tool-B', B, clearedB, 16000);
    jest.advanceTimersByTime(8000);
    expect(clearedA).toHaveBeenCalledTimes(1);
    expect(clearedB).not.toHaveBeenCalled();
    jest.advanceTimersByTime(8000);
    expect(clearedB).toHaveBeenCalledTimes(1);
  });

  test('rapid repeated clicks leave exactly ONE owning attempt and one timer', () => {
    const t = 'tool-A';
    const ids = [a.begin(t), a.begin(t), a.begin(t), a.begin(t)];
    const current = ids[ids.length - 1];
    expect(ids.filter((id) => a.isCurrent(t, id))).toEqual([current]);
    a.scheduleClear(t, current, () => {}, 8000);
    expect(a.pendingTimers()).toBe(1);
  });

  test('a stale attempt cannot schedule a clear-timer at all', () => {
    const t = 'tool-A';
    const stale = a.begin(t);
    a.begin(t);
    a.scheduleClear(t, stale, () => {}, 8000);
    expect(a.pendingTimers()).toBe(0);
  });

  test('dispose(): a late response after unmount/logout cannot write, and timers are gone', async () => {
    const t = 'tool-A';
    const slow = deferred();
    const id = a.begin(t);
    a.scheduleClear(t, id, () => {}, 8000);
    const late = slow.promise.then(() => a.isCurrent(t, id));

    a.dispose();
    expect(a.pendingTimers()).toBe(0);
    slow.resolve();
    await expect(late).resolves.toBe(false);
    expect(a.begin(t)).toBe(-1);             // and no new attempt can start
  });

  test('an unknown key is never "current" — no accidental writes to a card we never claimed', () => {
    expect(a.isCurrent('never-started', 1)).toBe(false);
  });
});

// The avatar's timer set must not grow for as long as the page stays open.
//
// useAvatarController's blink loop schedules two timeouts per blink (~every 3-5s) for the whole time
// the avatar is visible, and the original implementation added each id to a Set it never pruned.
// Nothing broke, but the set grew without bound for the lifetime of the mount. These tests pin the
// property that made it a leak: a fired timer is forgotten.
import { createTimerTracker } from '../timerTracker';

describe('createTimerTracker', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('tracks a pending timer and forgets it once it fires', () => {
    const t = createTimerTracker();
    const cb = jest.fn();
    t.set(cb, 100);
    expect(t.size).toBe(1);

    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.size).toBe(0);            // the leak: this used to stay at 1 forever
  });

  test('a long self-rescheduling loop does not accumulate ids', () => {
    const t = createTimerTracker();
    let ticks = 0;
    const loop = () => { ticks += 1; t.set(loop, 150); };
    loop();

    // Stand in for a parked page: hundreds of blink cycles.
    for (let i = 0; i < 500; i++) jest.advanceTimersByTime(150);

    expect(ticks).toBeGreaterThan(400);
    expect(t.size).toBeLessThanOrEqual(1);   // only the one still pending
  });

  test('clearAll cancels everything pending and empties the set', () => {
    const t = createTimerTracker();
    const a = jest.fn(); const b = jest.fn();
    t.set(a, 100); t.set(b, 200);
    expect(t.size).toBe(2);

    t.clearAll();
    expect(t.size).toBe(0);
    jest.advanceTimersByTime(500);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  test('clear() cancels one timer without disturbing the others', () => {
    const t = createTimerTracker();
    const a = jest.fn(); const b = jest.fn();
    const idA = t.set(a, 100); t.set(b, 100);
    t.clear(idA);
    expect(t.size).toBe(1);
    jest.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(t.size).toBe(0);
  });

  test('clearing an already-fired id is harmless', () => {
    const t = createTimerTracker();
    const id = t.set(() => {}, 50);
    jest.advanceTimersByTime(50);
    expect(t.size).toBe(0);
    expect(() => t.clear(id)).not.toThrow();
    expect(t.size).toBe(0);
  });
});

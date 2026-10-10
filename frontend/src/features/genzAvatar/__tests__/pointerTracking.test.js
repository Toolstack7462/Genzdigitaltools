import { clampPupilOffset, isTouchOnlyDevice } from '../usePointerTracking';

describe('clampPupilOffset — safe clamped pupil movement', () => {
  test('zero / non-finite vectors return {0,0}', () => {
    expect(clampPupilOffset(0, 0, 3)).toEqual({ x: 0, y: 0 });
    expect(clampPupilOffset(NaN, 2, 3)).toEqual({ x: 0, y: 0 });
  });
  test('magnitude never exceeds max for any pointer distance', () => {
    for (const [dx, dy] of [[1000, 0], [0, -999], [500, 500], [12, -7], [3, 3]]) {
      const o = clampPupilOffset(dx, dy, 3.2);
      expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(3.2 + 1e-9);
    }
  });
  test('direction is preserved', () => {
    const right = clampPupilOffset(300, 0, 3);
    expect(right.x).toBeGreaterThan(0);
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
    const up = clampPupilOffset(0, -300, 3);
    expect(up.y).toBeLessThan(0);
  });
});

describe('isTouchOnlyDevice — pointer tracking disabled on touch', () => {
  const orig = window.matchMedia;
  afterEach(() => { window.matchMedia = orig; });
  test('true when (hover:none) and (pointer:coarse) matches', () => {
    window.matchMedia = (q) => ({ matches: /hover: none/.test(q) && /coarse/.test(q) });
    expect(isTouchOnlyDevice()).toBe(true);
  });
  test('false for a fine-pointer desktop', () => {
    window.matchMedia = () => ({ matches: false });
    expect(isTouchOnlyDevice()).toBe(false);
  });
  test('never throws if matchMedia is unavailable', () => {
    window.matchMedia = undefined;
    expect(() => isTouchOnlyDevice()).not.toThrow();
    expect(isTouchOnlyDevice()).toBe(false);
  });
});

import { SEMANTIC_STATES, isValidSemantic, resolve, settledSemantic, restingState } from '../avatarStateMachine';

describe('Zee state machine', () => {
  test('every semantic state resolves to a valid expression + animation', () => {
    for (const s of SEMANTIC_STATES) {
      const r = resolve(s);
      expect(r.semantic).toBe(s);
      expect(typeof r.expression).toBe('string');
      expect(typeof r.animation).toBe('string');
      expect(typeof r.durationMs).toBe('number');
    }
  });

  test('unknown / invalid semantic falls back to idle', () => {
    expect(resolve('banana').semantic).toBe('idle');
    expect(resolve(undefined).semantic).toBe('idle');
    expect(resolve(null).semantic).toBe('idle');
    expect(isValidSemantic('idle')).toBe(true);
    expect(isValidSemantic('nope')).toBe(false);
  });

  test('loop vs one-shot flags match the animation kind', () => {
    expect(resolve('idle').loop).toBe(true);
    expect(resolve('thinking').loop).toBe(true);
    expect(resolve('speaking').loop).toBe(true);
    expect(resolve('greeting').oneShot).toBe(true);  // wave
    expect(resolve('success').oneShot).toBe(true);   // celebration
  });

  test('a one-shot settles to a STABLE resting loop (no dangling one-shot)', () => {
    const r = restingState('greeting');
    expect(r.oneShot).toBe(false);
    expect(r.loop).toBe(true);
    expect(settledSemantic('greeting')).toBe('idle');
    expect(settledSemantic('success')).toBe('idle');
    const w = restingState('warning');
    expect(w.oneShot).toBe(false);
    expect(w.loop).toBe(true);
  });

  test('a looping/held state returns itself from restingState', () => {
    const r = restingState('thinking');
    expect(r.semantic).toBe('thinking');
    expect(r.loop).toBe(true);
    expect(r.oneShot).toBe(false);
  });
});

import { resolveAvatarKeys, flowHintToSemantic, SEMANTIC_STATES } from '../avatarStates';

describe('avatarStates — safe semantic → key resolution', () => {
  test('no definition → preferred names + usedFallback (renderer will CSS-fallback)', () => {
    const r = resolveAvatarKeys('greeting', null);
    expect(r.semantic).toBe('greeting');
    expect(r.usedFallback).toBe(true);
    expect(typeof r.expression).toBe('string');
    expect(typeof r.animation).toBe('string');
  });

  test('exact keys present → used as-is, no fallback', () => {
    const def = { expressions: ['neutral', 'happy', 'sad'], animations: ['idle', 'wave', 'celebrate'] };
    const r = resolveAvatarKeys('success', def);
    expect(r.expression).toBe('happy');
    expect(r.animation).toBe('celebrate');
    expect(r.usedFallback).toBe(false);
  });

  test('missing key falls back to neutral/idle when available', () => {
    const def = { expressions: ['neutral'], animations: ['idle'] };
    const r = resolveAvatarKeys('error', def); // prefers sad/error, absent
    expect(r.expression).toBe('neutral');
    expect(r.animation).toBe('idle');
    expect(r.usedFallback).toBe(true);
  });

  test('object-shaped and {states:{}} definitions are tolerated', () => {
    const def = { states: { expressions: { neutral: {}, thinking: {} }, animations: { idle: {}, talk: {} } } };
    const r = resolveAvatarKeys('thinking', def);
    expect(r.expression).toBe('thinking');
    expect(r.animation).toBe('talk');
    expect(r.usedFallback).toBe(false);
  });

  test('unknown semantic coerces to idle; empty key lists never crash', () => {
    expect(resolveAvatarKeys('banana', { expressions: [], animations: [] }).semantic).toBe('idle');
    const r = resolveAvatarKeys('idle', {});
    expect(r.semantic).toBe('idle');
  });

  test('flow hint maps to a valid semantic state', () => {
    expect(SEMANTIC_STATES).toContain(flowHintToSemantic('sad'));
    expect(SEMANTIC_STATES).toContain(flowHintToSemantic('warning'));
    expect(flowHintToSemantic('nonsense')).toBe('idle');
  });
});

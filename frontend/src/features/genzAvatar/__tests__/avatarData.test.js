import { expressionFor, EXPRESSION_NAMES, DEFAULT_EXPRESSION, MOUTH_SHAPES } from '../avatarExpressions';
import { animationFor, isOneShot, isLoop, ANIMATION_NAMES, DEFAULT_ANIMATION } from '../avatarAnimations';

describe('Zee expression data', () => {
  test('every expression has a valid mouth shape + numeric eye openness', () => {
    for (const n of EXPRESSION_NAMES) {
      const e = expressionFor(n);
      expect(MOUTH_SHAPES).toContain(e.mouth);
      expect(typeof e.eyeOpen).toBe('number');
      expect(typeof e.browTilt).toBe('number');
    }
  });
  test('unknown expression → default', () => {
    expect(expressionFor('???')).toBe(expressionFor(DEFAULT_EXPRESSION));
  });
});

describe('Zee animation data', () => {
  test('kind helpers are correct', () => {
    expect(animationFor('idle').kind).toBe('loop');
    expect(isLoop('idle')).toBe(true);
    expect(isOneShot('wave')).toBe(true);
    expect(isOneShot('celebration')).toBe(true);
    expect(isOneShot('idle')).toBe(false);
  });
  test('unknown animation → default idle', () => {
    expect(animationFor('???')).toBe(animationFor(DEFAULT_ANIMATION));
    expect(ANIMATION_NAMES).toEqual(expect.arrayContaining(['idle', 'wave', 'thinking', 'talking', 'celebration', 'warning']));
  });
});

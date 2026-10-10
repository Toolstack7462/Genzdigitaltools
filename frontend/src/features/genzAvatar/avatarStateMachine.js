// Zee — original, explicit state machine (pure). Maps the assistant's public SEMANTIC states to an
// internal expression + animation, validates input (unknown → idle), and defines where a one-shot
// animation settles afterwards so the avatar always returns to a stable resting state.
import { animationFor, isOneShot, DEFAULT_ANIMATION } from './avatarAnimations';
import { DEFAULT_EXPRESSION } from './avatarExpressions';

// Public semantic states (identical set to the client-assistant AvatarRenderer contract).
export const SEMANTIC_STATES = Object.freeze([
  'idle', 'greeting', 'listening', 'thinking', 'speaking', 'success', 'warning', 'error',
]);

const SEMANTIC_MAP = {
  idle:      { expression: 'neutral',     animation: 'idle' },
  greeting:  { expression: 'friendly',    animation: 'wave' },
  listening: { expression: 'attentive',   animation: 'idle' },
  thinking:  { expression: 'thinking',    animation: 'thinking' },
  speaking:  { expression: 'talking',     animation: 'talking' },
  success:   { expression: 'celebrating', animation: 'celebration' },
  warning:   { expression: 'concerned',   animation: 'warning' },
  error:     { expression: 'concerned',   animation: 'warning' },
};

export function isValidSemantic(s) { return SEMANTIC_STATES.includes(s); }

/** Resolve a semantic state → { semantic, expression, animation, loop, oneShot, durationMs }. */
export function resolve(semantic) {
  const s = isValidSemantic(semantic) ? semantic : 'idle';
  const m = SEMANTIC_MAP[s] || SEMANTIC_MAP.idle;
  const anim = animationFor(m.animation);
  return {
    semantic: s,
    expression: m.expression || DEFAULT_EXPRESSION,
    animation: m.animation || DEFAULT_ANIMATION,
    loop: anim.kind === 'loop',
    oneShot: anim.kind === 'oneshot',
    durationMs: anim.durationMs,
  };
}

/** Where a semantic settles once its (one-shot) animation finishes — never leaves a dangling pose. */
export function settledSemantic(semantic) {
  const s = isValidSemantic(semantic) ? semantic : 'idle';
  if (s === 'greeting' || s === 'success') return 'idle'; // wave/celebration → calm idle
  return s; // warning/error settle to a still "concerned" pose; loops just continue
}

/**
 * The resting state a one-shot returns to: the settled expression with motion forced to a stable
 * loop (no dangling one-shot). Looping states return themselves unchanged.
 */
export function restingState(semantic) {
  const current = resolve(semantic);
  if (!current.oneShot) return current; // loops / held states stay as-is
  const settled = resolve(settledSemantic(semantic));
  return {
    ...settled,
    // keep the settled expression but guarantee a stable, non-one-shot animation
    animation: settled.loop ? settled.animation : 'idle',
    loop: true,
    oneShot: false,
  };
}

export { isOneShot };

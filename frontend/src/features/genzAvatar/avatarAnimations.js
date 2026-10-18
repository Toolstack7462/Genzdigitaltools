// Zee — original animation timing (pure data). `kind`: 'loop' (runs until the state changes),
// 'oneshot' (plays once then the controller settles back to a resting loop), or 'state' (a held
// pose, e.g. looking left or sleeping). Durations are original, chosen for a calm, professional feel.

const DATA = {
  idle:        { kind: 'loop',    durationMs: 3800 }, // gentle breathing
  blink:       { kind: 'oneshot', durationMs: 150 },
  wave:        { kind: 'oneshot', durationMs: 1100 },
  nod:         { kind: 'oneshot', durationMs: 850 },
  thinking:    { kind: 'loop',    durationMs: 1700 },
  talking:     { kind: 'loop',    durationMs: 520 },
  celebration: { kind: 'oneshot', durationMs: 1400 },
  warning:     { kind: 'oneshot', durationMs: 900 },
  lookLeft:    { kind: 'state',   durationMs: 380 },
  lookRight:   { kind: 'state',   durationMs: 380 },
  pointLeft:   { kind: 'oneshot', durationMs: 1000 },
  pointRight:  { kind: 'oneshot', durationMs: 1000 },
  sleep:       { kind: 'state',   durationMs: 600 },
  wake:        { kind: 'oneshot', durationMs: 700 },
};

export const ANIMATION_NAMES = Object.keys(DATA);
export const DEFAULT_ANIMATION = 'idle';

export function animationFor(name) {
  return DATA[name] || DATA[DEFAULT_ANIMATION];
}
export function isOneShot(name) { return (DATA[name] || {}).kind === 'oneshot'; }
export function isLoop(name) { return (DATA[name] || {}).kind === 'loop'; }

// Gen Z Guide — semantic avatar-state mapping. The app only ever speaks in SEMANTIC states; this
// module translates them to whatever expression/animation keys the supplied .avatar.json actually
// defines. Unknown/absent keys fall back SAFELY (neutral/idle) so a missing or partial avatar
// definition can never crash the portal. Pure + unit-tested.

// Semantic states the application uses (AvatarRenderer accepts these).
export const SEMANTIC_STATES = [
  'idle', 'greeting', 'listening', 'thinking', 'speaking', 'success', 'warning', 'error',
];

// Default semantic → (expression, animation) suggestion, using the avatar keys SUGGESTED by the
// task. These are only *preferences*: resolveAvatarKeys() verifies each against the real definition
// and falls back when a key is absent. We never assume a key exists.
const PREFERRED = {
  idle:      { expression: 'neutral',  animation: 'idle' },
  greeting:  { expression: 'happy',    animation: 'wave' },
  listening: { expression: 'listening',animation: 'idle' },
  thinking:  { expression: 'thinking', animation: 'talk' },
  speaking:  { expression: 'neutral',  animation: 'talk' },
  success:   { expression: 'happy',    animation: 'celebrate' },
  warning:   { expression: 'warning',  animation: 'idle' },
  error:     { expression: 'sad',      animation: 'error' },
};

// Map a flow's semantic avatar hint (see diagnosticFlows) onto a renderer semantic state.
const FLOW_HINT_TO_SEMANTIC = {
  neutral: 'idle', listening: 'listening', thinking: 'thinking', happy: 'success',
  warning: 'warning', sad: 'error', confused: 'thinking',
};

export function flowHintToSemantic(hint) {
  return FLOW_HINT_TO_SEMANTIC[hint] || 'idle';
}

function listKeys(def, kind) {
  // Tolerant of several plausible shapes without assuming one; returns a Set of available key names.
  const out = new Set();
  if (!def || typeof def !== 'object') return out;
  const bag = def[kind] || (def.states && def.states[kind]) || null;
  if (Array.isArray(bag)) bag.forEach((k) => { if (typeof k === 'string') out.add(k); else if (k && k.name) out.add(k.name); });
  else if (bag && typeof bag === 'object') Object.keys(bag).forEach((k) => out.add(k));
  return out;
}

/**
 * Resolve a semantic state to concrete keys that EXIST in the supplied avatar definition.
 * @param {string} semantic one of SEMANTIC_STATES (anything else → 'idle')
 * @param {object|null} def  parsed .avatar.json (or null when none is loaded)
 * @returns {{expression:string, animation:string, semantic:string, usedFallback:boolean}}
 */
export function resolveAvatarKeys(semantic, def) {
  const sem = SEMANTIC_STATES.includes(semantic) ? semantic : 'idle';
  const pref = PREFERRED[sem] || PREFERRED.idle;
  // No definition at all → return the *preferred* names; the renderer fallback (CSS) ignores them.
  if (!def) return { expression: pref.expression, animation: pref.animation, semantic: sem, usedFallback: true };

  const expressions = listKeys(def, 'expressions');
  const animations = listKeys(def, 'animations');

  const pick = (want, available, safe) => {
    if (available.size === 0) return { key: want, fallback: true };          // nothing declared → let renderer no-op
    if (available.has(want)) return { key: want, fallback: false };
    if (available.has(safe)) return { key: safe, fallback: true };            // neutral / idle
    const first = available.values().next().value;                           // last resort: any valid key
    return { key: first, fallback: true };
  };

  const e = pick(pref.expression, expressions, 'neutral');
  const a = pick(pref.animation, animations, 'idle');
  return { expression: e.key, animation: a.key, semantic: sem, usedFallback: e.fallback || a.fallback };
}

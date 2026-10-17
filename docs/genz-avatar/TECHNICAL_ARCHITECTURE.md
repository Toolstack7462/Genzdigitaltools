# Zee — Technical Architecture

Original React 19 + inline-SVG avatar engine, mounted **behind the existing `AvatarRenderer`
adapter** in the Gen Z Guide client assistant. The public contract stays semantic — client-assistant
components never touch SVG internals.

## Feature layout — `frontend/src/features/genzAvatar/`
- `GenzAvatar.js` — public component: `{ semantic, size, lookDirection?, interactive? }`.
- `GenzAvatarRenderer.js` — orchestrates layers + the controller/animation/pointer/visibility hooks.
- `GenzAvatarFace.js`, `GenzAvatarEyes.js`, `GenzAvatarMouth.js`, `GenzAvatarBody.js` — original SVG
  layer components (all ids/classes `genz-avatar-` prefixed).
- `avatarDefinition.js` — original schema: viewBox, palette tokens, layer ids, geometry constants.
- `avatarStateMachine.js` — pure: semantic → internal `{expression, animation, loop}`; validation;
  unknown → idle; one-shot → resting state.
- `avatarExpressions.js` — per-expression eye/brow/mouth shape parameters (pure data).
- `avatarAnimations.js` — per-animation timing/kind (`loop | oneshot`) + durations (pure data).
- `useAvatarController.js` — applies the state machine; schedules blink + one-shot→rest; cleans up.
- `usePointerTracking.js` — desktop-only, clamped pupil offset; disabled on touch / when inactive.
- `useVisibilityPause.js` — pauses motion when `document.hidden` or `prefers-reduced-motion`.
- `genzAvatar.css` — scoped `genz-avatar-*` styles + reduced-motion rules.
- `__tests__/` — pure-logic + source-guard tests (RTL is not installed in this project).

## State & animation model
Public **semantic** states: `idle, greeting, listening, thinking, speaking, success, warning, error`.
Internal **expressions**: `neutral, friendly, attentive, thinking, talking, happy, celebrating,
concerned, confused, sleeping`. `avatarStateMachine.resolve(semantic)` maps semantic → expression +
animation and marks it `loop` or one-shot. One-shot animations (wave, nod, celebration) auto-return
to the resting loop (`settledSemantic`). Unknown/invalid input falls back to `idle`.

## Integration
`AvatarRenderer` renders `<GenzAvatar>` by default, inside a tiny render-error guard. Hierarchy:
**Zee renders → if it throws → existing CSS/lucide fallback → if the whole assistant fails → the
narrow assistant ErrorBoundary keeps the portal usable.** The adapter's optional imperative
`renderer` prop remains for any future external runtime but is not used by Zee.

## Performance & a11y
Pure vector (no raster, no 3D, no new animation lib — Framer Motion only where it adds value). A
single `requestAnimationFrame` loop drives pointer tracking and is started only on compatible desktop
devices while the panel is active; all timers/listeners/RAF are cleaned up on unmount and paused when
hidden. The root SVG carries an accessible label; internal layers are `aria-hidden`. Motion is never
the sole communication channel (text + status badge). Reduced-motion disables non-essential motion.

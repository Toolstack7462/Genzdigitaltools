// Zee — controller. Turns a public semantic state into the current { expression, animation, loop }
// plus a natural blink, and guarantees a one-shot animation SETTLES back to a stable resting state.
// Honours prefers-reduced-motion and a `paused` flag (hidden tab / closed panel). All timers are
// tracked and cleared on change + unmount — no leaks, no overlapping transitions.
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { resolve, restingState } from './avatarStateMachine';
import { createTimerTracker } from './timerTracker';

export function useAvatarController(semantic, { paused = false } = {}) {
  const reduce = useReducedMotion();
  const [state, setState] = useState(() => resolve(semantic));
  const [blink, setBlink] = useState(false);
  // Self-pruning timer set: ids leave it as they fire, so the blink loop cannot accumulate dead
  // entries for the lifetime of a parked page. Lazy ref init — one tracker per mount.
  const timersRef = useRef(null);
  if (!timersRef.current) timersRef.current = createTimerTracker();
  const timers = timersRef.current;

  // Apply semantic changes; a one-shot schedules its settle to a resting loop.
  useEffect(() => {
    const next = resolve(semantic);
    if (next.oneShot && reduce) {
      setState(restingState(semantic)); // reduced motion → skip the one-shot, rest immediately
      return undefined;
    }
    setState(next);
    if (next.oneShot) {
      const id = timers.set(() => setState(restingState(semantic)), next.durationMs);
      return () => timers.clear(id);
    }
    return undefined;
  }, [semantic, reduce, timers]);

  // Natural blink — paused under reduced motion / hidden / sleeping.
  useEffect(() => {
    if (paused || reduce || state.expression === 'sleeping') { setBlink(false); return undefined; }
    let alive = true;
    let pending;
    const loop = () => {
      const delay = 2600 + Math.random() * 2800;
      pending = timers.set(() => {
        if (!alive) return;
        setBlink(true);
        pending = timers.set(() => { if (alive) { setBlink(false); loop(); } }, 150);
      }, delay);
    };
    loop();
    return () => { alive = false; timers.clear(pending); };
  }, [paused, reduce, state.expression, timers]);

  // Final safety net: clear every timer on unmount (capture the ref per exhaustive-deps guidance).
  useEffect(() => () => timers.clearAll(), [timers]);

  return { ...state, blink, reduced: reduce, paused };
}

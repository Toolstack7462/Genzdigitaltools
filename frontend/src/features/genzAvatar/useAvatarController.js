// Zee — controller. Turns a public semantic state into the current { expression, animation, loop }
// plus a natural blink, and guarantees a one-shot animation SETTLES back to a stable resting state.
// Honours prefers-reduced-motion and a `paused` flag (hidden tab / closed panel). All timers are
// tracked and cleared on change + unmount — no leaks, no overlapping transitions.
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { resolve, restingState } from './avatarStateMachine';

export function useAvatarController(semantic, { paused = false } = {}) {
  const reduce = useReducedMotion();
  const [state, setState] = useState(() => resolve(semantic));
  const [blink, setBlink] = useState(false);
  const timers = useRef(new Set());

  const addTimer = (id) => { timers.current.add(id); return id; };
  const clearAll = () => { timers.current.forEach((id) => clearTimeout(id)); timers.current.clear(); };

  // Apply semantic changes; a one-shot schedules its settle to a resting loop.
  useEffect(() => {
    const next = resolve(semantic);
    if (next.oneShot && reduce) {
      setState(restingState(semantic)); // reduced motion → skip the one-shot, rest immediately
      return undefined;
    }
    setState(next);
    if (next.oneShot) {
      const set = timers.current; // capture per exhaustive-deps (ref may change before cleanup)
      const id = addTimer(setTimeout(() => setState(restingState(semantic)), next.durationMs));
      return () => { clearTimeout(id); set.delete(id); };
    }
    return undefined;
  }, [semantic, reduce]);

  // Natural blink — paused under reduced motion / hidden / sleeping.
  useEffect(() => {
    if (paused || reduce || state.expression === 'sleeping') { setBlink(false); return undefined; }
    let alive = true;
    let pending;
    const loop = () => {
      const delay = 2600 + Math.random() * 2800;
      pending = addTimer(setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        pending = addTimer(setTimeout(() => { if (alive) { setBlink(false); loop(); } }, 150));
      }, delay));
    };
    loop();
    return () => { alive = false; if (pending) clearTimeout(pending); };
  }, [paused, reduce, state.expression]);

  // Final safety net: clear every timer on unmount (capture the ref per exhaustive-deps guidance).
  useEffect(() => {
    const set = timers.current;
    return () => { set.forEach((id) => clearTimeout(id)); set.clear(); };
  }, []);

  return { ...state, blink, reduced: reduce, paused };
}

// Zee — subtle pointer-following eyes. Desktop (fine-pointer) only; disabled on touch-only devices
// and whenever inactive (panel closed / hidden). Pupil offset is clamped to a small safe range. A
// single rAF smooths the motion and is always cancelled on cleanup.
import { useEffect, useRef, useState } from 'react';

/** Pure: clamp a pointer vector (px, from avatar centre) to a small pupil offset (viewBox units). */
export function clampPupilOffset(dx, dy, max, influence = 260) {
  const m = Math.hypot(dx, dy);
  if (!Number.isFinite(m) || m === 0) return { x: 0, y: 0 };
  const reach = Math.min(1, m / influence);     // 0..1 — how far toward the max the pupils travel
  const scale = (max * reach) / m;              // preserves direction; |result| = max*reach ≤ max
  return { x: dx * scale, y: dy * scale };
}

/** True on touch-only devices (no fine hover pointer). */
export function isTouchOnlyDevice() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch { return false; }
}

export function usePointerTracking({ active, max, hostRef }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const raf = useRef(0);

  useEffect(() => {
    if (!active || isTouchOnlyDevice() || typeof window === 'undefined') {
      setOffset({ x: 0, y: 0 });
      return undefined;
    }
    let mounted = true;
    const onMove = (e) => {
      const el = hostRef && hostRef.current;
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      target.current = clampPupilOffset(e.clientX - cx, e.clientY - cy, max);
    };
    const tick = () => {
      if (!mounted) return;
      setOffset((o) => ({ x: o.x + (target.current.x - o.x) * 0.2, y: o.y + (target.current.y - o.y) * 0.2 }));
      raf.current = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    raf.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (raf.current) cancelAnimationFrame(raf.current);
      window.removeEventListener('pointermove', onMove);
    };
  }, [active, max, hostRef]);

  return offset;
}

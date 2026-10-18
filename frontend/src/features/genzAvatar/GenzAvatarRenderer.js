// Zee — renderer. Composes the original SVG layers and drives them from the state machine controller,
// clamped pointer tracking, and the visibility/reduced-motion pauses. Animations are CSS-driven via
// a `data-anim` attribute (breathing on an outer group, one-shot/loop actions on an inner group, so
// transitions never conflict). Decorative SVG is aria-hidden; the accessible label lives on the root.
import { useRef } from 'react';
import { VIEWBOX, PUPIL_MAX_OFFSET, PALETTE, AVATAR_NAME } from './avatarDefinition';
import { expressionFor } from './avatarExpressions';
import { useAvatarController } from './useAvatarController';
import { usePointerTracking } from './usePointerTracking';
import { useVisibilityPause } from './useVisibilityPause';
import GenzAvatarBody from './GenzAvatarBody';
import GenzAvatarFace from './GenzAvatarFace';
import GenzAvatarEyes from './GenzAvatarEyes';
import GenzAvatarMouth from './GenzAvatarMouth';

const BADGE_FOR = { success: 'success', warning: 'warning', error: 'error' };

export default function GenzAvatarRenderer({ semantic = 'idle', size = 48, lookDirection = null, interactive }) {
  const hostRef = useRef(null);
  const hidden = useVisibilityPause();
  const ctrl = useAvatarController(semantic, { paused: hidden });
  const expr = expressionFor(ctrl.expression);

  // Pointer tracking only when it adds value: a larger (panel) avatar, not paused/reduced, and only
  // on fine-pointer desktop devices (the hook disables itself on touch). Caller may force via prop.
  const trackingActive = (interactive != null ? interactive : size >= 72) && !hidden && !ctrl.reduced;
  const track = usePointerTracking({ active: trackingActive, max: PUPIL_MAX_OFFSET, hostRef });

  // Optional contextual attention (point/look) nudges the pupils within the same clamp.
  const look = lookDirection === 'left' ? -PUPIL_MAX_OFFSET * 0.7
    : lookDirection === 'right' ? PUPIL_MAX_OFFSET * 0.7 : 0;
  const pupil = {
    x: Math.max(-PUPIL_MAX_OFFSET, Math.min(PUPIL_MAX_OFFSET, track.x + look)),
    y: Math.max(-PUPIL_MAX_OFFSET, Math.min(PUPIL_MAX_OFFSET, track.y)),
  };

  const badge = BADGE_FOR[ctrl.semantic] || 'none';
  const anim = ctrl.reduced || hidden ? 'idle' : ctrl.animation;

  return (
    <svg
      ref={hostRef}
      className="genz-avatar-root"
      data-anim={anim}
      data-reduced={ctrl.reduced ? '1' : '0'}
      data-paused={hidden ? '1' : '0'}
      width={size} height={size}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      role="img"
      aria-label={`${AVATAR_NAME}, the Gen Z Guide assistant`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <g className="genz-avatar-breathe" aria-hidden="true">
        <g className="genz-avatar-action">
          <GenzAvatarBody badge={badge} />
          <GenzAvatarFace accentColor={PALETTE.blue} />
          <GenzAvatarEyes expr={expr} pupil={pupil} blink={ctrl.blink} />
          <GenzAvatarMouth shape={expr.mouth} />
        </g>
      </g>
    </svg>
  );
}

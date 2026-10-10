// Zee — original eyes layer: rounded-rectangle eye wells, tracking pupils, highlight dots, and
// independent eyebrow bars. All original geometry; `genz-avatar-` prefixed. Decorative (aria-hidden
// is set on the SVG root).
import { PALETTE } from './avatarDefinition';

// Eye well centres (viewBox 120). Rectangular wells = Zee's distinct look (not round anime eyes).
const LEFT = { cx: 46, cy: 58 };
const RIGHT = { cx: 74, cy: 58 };
const WELL = { w: 15, h: 17, rx: 7.5 };
const PUPIL_R = 4.6;

function Eye({ side, center, expr, pupil, blink }) {
  const openY = blink ? 0.08 : Math.max(0.08, expr.eyeOpen);
  return (
    <g className={`genz-avatar-eye genz-avatar-eye-${side}`}>
      {/* well */}
      <g transform={`translate(${center.cx} ${center.cy}) scale(1 ${openY})`}>
        <rect
          className="genz-avatar-eye-well"
          x={-WELL.w / 2} y={-WELL.h / 2} width={WELL.w} height={WELL.h} rx={WELL.rx}
          fill={PALETTE.white} stroke={PALETTE.navy} strokeWidth="2"
        />
        {/* pupil tracks pointer / look direction (clamped upstream) */}
        <g transform={`translate(${pupil.x} ${pupil.y})`}>
          <circle className={`genz-avatar-pupil genz-avatar-pupil-${side}`} cx="0" cy="0" r={PUPIL_R} fill={PALETTE.navy} />
          <circle className="genz-avatar-eye-highlight" cx={-1.5} cy={-1.6} r="1.3" fill={PALETTE.white} />
        </g>
      </g>
    </g>
  );
}

function Brow({ side, center, expr }) {
  const dir = side === 'left' ? 1 : -1;
  return (
    <g
      className={`genz-avatar-brow genz-avatar-brow-${side}`}
      transform={`translate(${center.cx} ${center.cy - 14 + expr.browY}) rotate(${expr.browTilt * dir})`}
    >
      <rect x="-8" y="-1.6" width="16" height="3.2" rx="1.6" fill={PALETTE.navy} />
    </g>
  );
}

export default function GenzAvatarEyes({ expr, pupil = { x: 0, y: 0 }, blink = false }) {
  return (
    <g className="genz-avatar-eyes">
      <Eye side="left" center={LEFT} expr={expr} pupil={pupil} blink={blink} />
      <Eye side="right" center={RIGHT} expr={expr} pupil={pupil} blink={blink} />
      <Brow side="left" center={LEFT} expr={expr} />
      <Brow side="right" center={RIGHT} expr={expr} />
    </g>
  );
}

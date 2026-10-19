// Zee — original head/face surface, the slim guide headset accessory, and a soft highlight. The
// head is a rounded "squircle" (not a plain circle) — Zee's distinct silhouette. `genz-avatar-`
// prefixed; decorative.
import { PALETTE } from './avatarDefinition';

export default function GenzAvatarFace({ accentColor = PALETTE.blue }) {
  return (
    <g className="genz-avatar-face-group">
      {/* head — rounded square (squircle feel via large rx on a near-square) */}
      <rect
        className="genz-avatar-head"
        x="20" y="14" width="80" height="82" rx="30"
        fill={accentColor} stroke={PALETTE.navy} strokeWidth="3"
      />
      {/* face surface — lighter inset panel where the features live */}
      <rect
        className="genz-avatar-face"
        x="27" y="22" width="66" height="64" rx="24"
        fill={PALETTE.face} stroke={PALETTE.faceEdge} strokeWidth="2"
      />
      {/* soft top highlight */}
      <path
        className="genz-avatar-highlight"
        d="M38 30 Q60 24 82 30"
        fill="none" stroke={PALETTE.white} strokeWidth="4" strokeLinecap="round" opacity="0.65"
      />
      {/* guide headset: thin headband arc + left ear cup + mic stub (original, minimal) */}
      <g className="genz-avatar-headset" fill="none" stroke={PALETTE.navy} strokeWidth="3" strokeLinecap="round">
        <path d="M24 44 Q60 6 96 44" />
        <rect x="18" y="44" width="10" height="16" rx="5" fill={PALETTE.navy} stroke="none" />
        <rect x="92" y="44" width="10" height="16" rx="5" fill={PALETTE.navy} stroke="none" />
        <path d="M23 60 Q22 76 38 78" />
        <circle cx="40" cy="78" r="2.6" fill={PALETTE.cyan} stroke="none" />
      </g>
    </g>
  );
}

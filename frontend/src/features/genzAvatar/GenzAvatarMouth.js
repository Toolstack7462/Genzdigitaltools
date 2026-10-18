// Zee — original minimal mouth: a single path centred at (60,82) that swaps between a few original
// shapes. `genz-avatar-` prefixed; decorative.
import { PALETTE } from './avatarDefinition';

// Original path data per shape (viewBox 120; mouth centred around x=60, y=82).
const PATHS = {
  line:  'M51 82 H69',
  smile: 'M51 80 Q60 90 69 80',
  small: 'M56 82 Q60 86 64 82',
  frown: 'M51 86 Q60 78 69 86',
};

export default function GenzAvatarMouth({ shape = 'line' }) {
  // "talk" and "open" are rendered as a filled oral oval (the talking loop animates its height).
  if (shape === 'talk' || shape === 'open') {
    const ry = shape === 'open' ? 6 : 4;
    return (
      <ellipse
        className="genz-avatar-mouth genz-avatar-mouth-oval"
        cx="60" cy="83" rx="7" ry={ry}
        fill={PALETTE.navy}
      />
    );
  }
  return (
    <path
      className="genz-avatar-mouth"
      d={PATHS[shape] || PATHS.line}
      fill="none" stroke={PALETTE.navy} strokeWidth="3" strokeLinecap="round"
    />
  );
}

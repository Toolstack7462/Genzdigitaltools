// Zee — original shoulders/body + status badge. Sits behind the head; `genz-avatar-` prefixed.
import { PALETTE, BADGE_ACCENT } from './avatarDefinition';

export default function GenzAvatarBody({ badge = 'none' }) {
  const badgeColor = PALETTE[BADGE_ACCENT[badge] || 'cyan'] || PALETTE.cyan;
  return (
    <g className="genz-avatar-body-group">
      {/* shoulders: a soft rounded trapezoid rising from the bottom edge */}
      <path
        className="genz-avatar-body"
        d="M26 120 Q26 100 46 97 H74 Q94 100 94 120 Z"
        fill={PALETTE.navy}
      />
      <path
        className="genz-avatar-body-collar"
        d="M48 99 Q60 108 72 99"
        fill="none" stroke={PALETTE.cyan} strokeWidth="3" strokeLinecap="round"
      />
      {/* status badge — a second, non-motion communication channel (success/warning/error) */}
      {badge !== 'none' && (
        <g className="genz-avatar-badge" transform="translate(93 95)">
          <circle r="9" fill={PALETTE.white} stroke={badgeColor} strokeWidth="2.5" />
          <circle r="4" fill={badgeColor} />
        </g>
      )}
    </g>
  );
}

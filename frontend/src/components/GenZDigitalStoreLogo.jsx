/**
 * GenZDigitalStoreLogo.jsx
 * Primary brand logo for Gen Z Digital Store — pure inline vector (crisp at any size,
 * no raster PNG). See DESIGN.md §14 for usage rules.
 *
 * Props:
 *   className  – sizing wrapper, controls height (e.g. "h-9"). Default "h-10".
 *   variant    – "full" (icon + wordmark) | "icon" (mark only). Default "full".
 *   showText   – legacy alias; false forces icon-only.
 *   textSize   – wordmark size: "sm" | "base" | "lg" | "xl" | "2xl". Default "lg".
 */

let _gid = 0;

export const GenZIconMark = ({ className = "", title = "Gen Z Digital Store" }) => {
  // Unique gradient ids so multiple instances never collide.
  const id = `gz${++_gid}`;
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#04335A" />
          <stop offset="1" stopColor="#00091E" />
        </linearGradient>
        <linearGradient id={`${id}-z`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#7DF9FF" />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00C9DD" stopOpacity="0.9" />
          <stop offset="1" stopColor="#008EA3" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {/* Squircle tile */}
      <rect x="1.25" y="1.25" width="45.5" height="45.5" rx="13.5"
            fill={`url(#${id}-tile)`} stroke={`url(#${id}-edge)`} strokeWidth="1.5" />
      {/* Inner top highlight */}
      <rect x="3" y="3" width="42" height="20" rx="11"
            fill="#FFFFFF" opacity="0.05" />

      {/* Z monogram */}
      <path d="M15 16 H33 L16 32 H34"
            fill="none" stroke={`url(#${id}-z)`} strokeWidth="4.4"
            strokeLinecap="round" strokeLinejoin="round" />

      {/* Rising spark (Gen Z energy) */}
      <path d="M35.5 11 L36.6 14.1 L39.7 15.2 L36.6 16.3 L35.5 19.4 L34.4 16.3 L31.3 15.2 L34.4 14.1 Z"
            fill="#7DF9FF" />
    </svg>
  );
};

const TEXT_SIZE = {
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
};

const GenZDigitalStoreLogo = ({
  className = "h-10",
  variant = "full",
  showText = true,
  textSize = "lg",
}) => {
  const iconOnly = variant === "icon" || showText === false;
  const sizeClass = TEXT_SIZE[textSize] || TEXT_SIZE.lg;

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <GenZIconMark className="h-full w-auto aspect-square flex-shrink-0" />
      {!iconOnly && (
        <span
          className={`font-bold leading-none tracking-tight whitespace-nowrap ${sizeClass}`}
          style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
        >
          <span className="text-white">Gen&nbsp;Z </span>
          <span className="text-gradient-teal">Digital Store</span>
        </span>
      )}
    </span>
  );
};

export default GenZDigitalStoreLogo;

import logoPng from '../assets/brand/logo-genz-digital-store.png';

// Original Gen Z Digital Store badge (circular, transparent corners).
// Rendered from the source PNG so the original identity, colours, curves and
// text are preserved exactly — no fake vector trace, no box, no background.
const SIZE_CLASSES = {
  xs: 'h-8 w-8',
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-14 w-14',
  xl: 'h-20 w-20',
  '2xl': 'h-28 w-28',
  // Larger brand presence for the public marketing site (source PNG is 512×512, so
  // these stay sharp even at 2× DPR). Kept separate so admin/client/login sizes are
  // unaffected.
  nav: 'h-16 w-16',              // ~64px — public navbar (sits in the 72px bar)
  footer: 'h-[72px] w-[72px]',   // prominent footer badge
};

const BrandLogo = ({
  size = 'md',
  className = '',
  imgClassName = '',
  ariaLabel = 'Gen Z Digital Store',
  glow = false,   // soft brand halo + drop-shadow so the badge integrates on dark/glass surfaces
}) => {
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;

  return (
    <span
      className={`relative inline-flex items-center justify-center ${className}`}
      role="img"
      aria-label={ariaLabel}
    >
      {glow && (
        <span
          aria-hidden="true"
          className="absolute inset-0 -z-10 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(6,182,212,0.45), transparent 62%)',
            filter: 'blur(14px)',
            transform: 'scale(1.6)',
          }}
        />
      )}
      <img
        src={logoPng}
        alt=""
        className={`${sizeClass} block object-contain select-none ${imgClassName}`}
        style={glow ? { filter: 'drop-shadow(0 6px 16px rgba(7,27,51,0.45))' } : undefined}
        draggable="false"
      />
    </span>
  );
};

export default BrandLogo;

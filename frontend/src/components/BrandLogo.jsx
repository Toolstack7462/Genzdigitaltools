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
};

const BrandLogo = ({
  size = 'md',
  className = '',
  imgClassName = '',
  ariaLabel = 'Gen Z Digital Store',
}) => {
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;

  return (
    <span
      className={`inline-flex items-center ${className}`}
      role="img"
      aria-label={ariaLabel}
    >
      <img
        src={logoPng}
        alt=""
        className={`${sizeClass} block object-contain select-none ${imgClassName}`}
        draggable="false"
      />
    </span>
  );
};

export default BrandLogo;

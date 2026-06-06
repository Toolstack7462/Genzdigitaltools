import logoSvg from '../assets/brand/genz-digital-store-logo.svg';

const SIZE_CLASSES = {
  sm: {
    mark: 'h-8 w-8',
    horizontal: 'h-9 w-auto',
  },
  md: {
    mark: 'h-10 w-10',
    horizontal: 'h-11 w-auto',
  },
  lg: {
    mark: 'h-12 w-12',
    horizontal: 'h-14 w-auto',
  },
};

const BrandLogo = ({
  variant = 'horizontal',
  size = 'md',
  className = '',
  ariaLabel = 'Gen Z Digital Store',
}) => {
  const classes = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const sizeClass = variant === 'mark' ? classes.mark : classes.horizontal;

  return (
    <span className={`inline-flex items-center ${className}`} role="img" aria-label={ariaLabel}>
      <img
        src={logoSvg}
        alt=""
        className={`${sizeClass} block object-contain`}
        draggable="false"
      />
    </span>
  );
};

export default BrandLogo;

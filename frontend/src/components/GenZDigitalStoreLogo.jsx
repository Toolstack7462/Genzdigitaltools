import BrandLogo from './BrandLogo';

const sizeFromText = {
  sm: 'sm',
  base: 'sm',
  lg: 'md',
  xl: 'md',
  '2xl': 'lg',
  '3xl': 'lg',
};

export const GenZIconMark = ({ className = '' }) => (
  <BrandLogo variant="mark" size="md" className={className} />
);

const GenZDigitalStoreLogo = ({
  className = '',
  variant = 'full',
  showText = true,
  textSize = 'lg',
  size,
}) => (
  <BrandLogo
    variant={variant === 'icon' || showText === false ? 'mark' : 'horizontal'}
    size={size || sizeFromText[textSize] || 'md'}
    className={className}
  />
);

export default GenZDigitalStoreLogo;

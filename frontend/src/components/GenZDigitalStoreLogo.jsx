/**
 * GenZDigitalStoreLogo.jsx
 * Primary logo component for Gen Z Digital Store.
 * Uses the uploaded logo converted into an SVG wrapper for exact visual accuracy.
 */

const GenZDigitalStoreLogo = ({ className = "h-10", showText = true, textSize = "xl" }) => {
  return (
    <div className={`flex items-center ${className}`}>
      <img
        src="/logo-genz-digital-store.svg"
        alt="Gen Z Digital Store"
        className="h-full w-auto max-w-full object-contain"
        loading="eager"
        decoding="async"
      />
    </div>
  );
};

export default GenZDigitalStoreLogo;

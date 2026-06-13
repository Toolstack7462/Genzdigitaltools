import { useReveal } from '../../hooks/useReveal';

/**
 * PageHero — premium reusable hero section for inner public pages.
 *
 * Props
 * - eyebrow:     small chip label above title (string)
 * - title:       headline; can include JSX (e.g. <span className="text-grad-brand">word</span>)
 * - subtitle:    supporting paragraph (string | node)
 * - actions:     optional JSX (buttons / links)
 * - align:       'center' (default) | 'left'
 * - children:    optional content rendered under subtitle (e.g. illustration / extra)
 * - compact:     bool — reduces vertical padding for shorter heroes
 */
const PageHero = ({
  eyebrow,
  title,
  subtitle,
  actions,
  align = 'center',
  children,
  compact = false,
}) => {
  const [ref, visible] = useReveal(0.05);
  const isCenter = align === 'center';

  return (
    <section
      className={`page-hero ${compact ? 'pt-28 pb-14 lg:pt-32 lg:pb-16' : 'pt-28 pb-20 lg:pt-32 lg:pb-24'} px-5`}
      data-testid="page-hero"
    >
      {/* Decorative animated blobs */}
      <span className="brand-blob brand-blob-a" aria-hidden="true" />
      <span className="brand-blob brand-blob-b" aria-hidden="true" />
      <span className="brand-blob brand-blob-c" aria-hidden="true" />

      <div className="gz-container">
        <div
          ref={ref}
          className={`reveal ${visible ? 'visible' : ''} ${
            isCenter ? 'max-w-3xl mx-auto text-center' : 'max-w-3xl'
          }`}
        >
          {eyebrow && (
            <div className={`gz-eyebrow-grad mb-6 ${isCenter ? '' : ''}`}>
              <span className="glow-dot" /> {eyebrow}
            </div>
          )}

          <h1 className="font-heading font-extrabold text-genz-navy leading-[1.08] text-4xl sm:text-5xl lg:text-6xl tracking-tight mb-5">
            {title}
          </h1>

          {subtitle && (
            <p className={`text-genz-muted text-[16px] sm:text-[17px] leading-relaxed ${isCenter ? 'max-w-2xl mx-auto' : 'max-w-2xl'}`}>
              {subtitle}
            </p>
          )}

          {actions && (
            <div className={`mt-9 flex flex-wrap gap-3 ${isCenter ? 'justify-center' : ''}`}>
              {actions}
            </div>
          )}

          {children}
        </div>
      </div>
    </section>
  );
};

export default PageHero;

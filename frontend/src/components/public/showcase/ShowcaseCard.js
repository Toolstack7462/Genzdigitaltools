import { ArrowRight, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * ShowcaseCard — Premium SaaS-style case-study card.
 *
 * Props:
 * - title       : string
 * - tag         : short label (e.g. 'Dashboard UI')
 * - description : short pitch
 * - accent      : hex colour for the highlight (border glow, mock accent, button tint)
 * - tags        : tech tags chips ['React','Tailwind',...]
 * - Mock        : React component that renders the visual mockup
 * - ctaLabel    : button label (default 'View Concept')
 * - ctaTo       : router link (default '/contact')
 * - className   : optional extra classes for outer card
 */
const ShowcaseCard = ({
  title,
  tag,
  description,
  accent = '#06B6D4',
  tags = [],
  Mock,
  ctaLabel = 'View Concept',
  ctaTo = '/contact',
  className = '',
}) => (
  <article
    className={`showcase-card group ${className}`}
    style={{ '--showcase-accent': accent }}
    data-testid="showcase-card"
  >
    {/* gradient hairline (top) */}
    <span className="showcase-card__hairline" />

    {/* visual preview area */}
    <div className="showcase-card__preview">
      {/* layered background ribbons / glow */}
      <span className="showcase-card__glow" />
      <span className="showcase-card__grid" />

      {/* category chip — top-left */}
      <span className="showcase-card__chip">
        <span className="showcase-card__chip-dot" /> {tag}
      </span>

      {/* mockup */}
      <div className="showcase-card__mock">
        {Mock && <Mock accent={accent} />}
      </div>
    </div>

    {/* meta */}
    <div className="showcase-card__body">
      <h3 className="showcase-card__title">{title}</h3>
      <p className="showcase-card__desc">{description}</p>

      {tags.length > 0 && (
        <div className="showcase-card__tags">
          {tags.map((t) => (
            <span key={t} className="showcase-card__tag">{t}</span>
          ))}
        </div>
      )}

      <Link to={ctaTo} className="showcase-card__cta" data-testid="showcase-card-cta">
        {ctaLabel}
        <ArrowRight size={14} className="showcase-card__cta-arrow" />
      </Link>
    </div>

    {/* outer glow on hover */}
    <span className="showcase-card__edge-glow" aria-hidden="true" />
  </article>
);

export default ShowcaseCard;
export { ExternalLink };

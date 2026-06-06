import { Link } from 'react-router-dom';
import { Check, Zap } from 'lucide-react';

const PricingCard = ({
  tier,
  price,
  priceNote,
  tagline,
  features,
  cta,
  ctaTo = '/contact',
  highlighted = false,
}) => (
  <div
    className={`relative p-7 flex flex-col h-full ${
      highlighted ? 'border-animated rounded-2xl transition-all duration-300 hover:-translate-y-1' : 'card-premium'
    }`}
    style={
      highlighted
        ? {
            background: 'linear-gradient(160deg,rgba(0,175,193,0.18) 0%,rgba(0,30,60,0.9) 100%)',
            border: '1.5px solid rgba(0,175,193,0.5)',
            boxShadow: '0 0 40px rgba(0,175,193,0.15)',
          }
        : {}
    }
  >
    {highlighted && (
      <div
        className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-bold text-genz-deep-navy"
        style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}
      >
        Most Popular
      </div>
    )}

    {/* Tier */}
    <div className="mb-5">
      <span
        className={`text-xs font-bold uppercase tracking-widest ${
          highlighted ? 'text-genz-teal' : 'text-white/55'
        }`}
      >
        {tier}
      </span>
      <div className="mt-3 flex items-end gap-1.5">
        <span className="text-white font-bold text-3xl">{price}</span>
        {priceNote && (
          <span className="text-white/55 text-sm mb-1">{priceNote}</span>
        )}
      </div>
      <p className="text-white/50 text-sm mt-2">{tagline}</p>
    </div>

    <div className="section-divider mb-5" />

    {/* Features */}
    <ul className="space-y-3 flex-1 mb-7">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <Check
            size={15}
            className="flex-shrink-0 mt-0.5"
            style={{ color: highlighted ? '#00AFC1' : '#4ade80' }}
          />
          <span className="text-white/65 text-sm">{f}</span>
        </li>
      ))}
    </ul>

    {/* CTA */}
    <Link
      to={ctaTo}
      className={`flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all duration-200 ${
        highlighted
          ? 'text-genz-deep-navy hover:opacity-90'
          : 'text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10'
      }`}
      style={highlighted ? { background: 'linear-gradient(135deg,#00AFC1,#008EA3)' } : {}}
    >
      {highlighted && <Zap size={14} />}
      {cta}
    </Link>
  </div>
);

export default PricingCard;

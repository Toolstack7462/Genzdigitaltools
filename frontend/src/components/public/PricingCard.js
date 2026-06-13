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
    className={`gz-card relative p-7 flex flex-col h-full ${highlighted ? 'lg:-translate-y-2' : ''}`}
    style={highlighted ? { borderColor: 'rgba(37,99,235,0.45)', boxShadow: '0 24px 60px rgba(37,99,235,0.16)' } : {}}
  >
    {highlighted && (
      <div
        className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-bold text-white"
        style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}
      >
        Most Popular
      </div>
    )}

    {/* Tier */}
    <div className="mb-5">
      <span className={`text-xs font-bold uppercase tracking-widest ${highlighted ? 'text-genz-blue' : 'text-genz-muted'}`}>
        {tier}
      </span>
      <div className="mt-2 flex items-end gap-1.5">
        <span className="font-heading text-genz-navy font-extrabold text-[26px]">{price}</span>
        {priceNote && <span className="text-genz-muted text-sm mb-1">{priceNote}</span>}
      </div>
      <p className="text-genz-muted text-sm mt-2">{tagline}</p>
    </div>

    <div className="border-t border-genz-border mb-5" />

    {/* Features */}
    <ul className="space-y-3 flex-1 mb-7">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <Check size={15} className="flex-shrink-0 mt-0.5" style={{ color: highlighted ? '#2563EB' : '#16A34A' }} />
          <span className="text-genz-muted text-[13.5px]">{f}</span>
        </li>
      ))}
    </ul>

    {/* CTA */}
    <Link
      to={ctaTo}
      className={`flex items-center justify-center gap-2 py-3 rounded-[14px] text-sm font-bold transition-all duration-200 ${
        highlighted
          ? 'text-white hover:-translate-y-0.5'
          : 'text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06]'
      }`}
      style={highlighted ? { background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 24px rgba(37,99,235,0.22)' } : {}}
    >
      {highlighted && <Zap size={14} />}
      {cta}
    </Link>
  </div>
);

export default PricingCard;

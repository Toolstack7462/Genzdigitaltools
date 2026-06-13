import { Link } from 'react-router-dom';
import { Check, Zap, Sparkles } from 'lucide-react';

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
    className={`gz-card relative p-7 flex flex-col h-full overflow-visible ${highlighted ? 'lg:-translate-y-2 pricing-glow' : ''}`}
    style={highlighted ? { borderColor: 'rgba(37,99,235,0.45)' } : {}}
  >
    {/* Top accent line for highlighted plan */}
    {highlighted && (
      <span
        className="absolute inset-x-0 top-0 h-[3px] rounded-t-[inherit]"
        style={{ background: 'linear-gradient(90deg,#2563EB,#06B6D4,#14B8A6)' }}
      />
    )}

    {highlighted && (
      <div
        className="absolute -top-3.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11.5px] font-bold text-white"
        style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 24px -8px rgba(37,99,235,0.45)' }}
      >
        <Sparkles size={11} /> Most Popular
      </div>
    )}

    {/* Tier */}
    <div className="mb-5">
      <span className={`text-[11.5px] font-bold uppercase tracking-[0.14em] ${highlighted ? 'text-genz-blue' : 'text-genz-muted'}`}>
        {tier}
      </span>
      <div className="mt-2 flex items-end gap-1.5">
        <span className="font-heading text-genz-navy font-extrabold text-[24px] leading-tight">{price}</span>
        {priceNote && <span className="text-genz-muted text-[13px] mb-1">{priceNote}</span>}
      </div>
      <p className="text-genz-muted text-[13.5px] mt-2 leading-relaxed">{tagline}</p>
    </div>

    <div className="border-t border-genz-border mb-5" />

    {/* Features */}
    <ul className="space-y-2.5 flex-1 mb-7">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span
            className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5"
            style={{
              background: highlighted ? 'rgba(37,99,235,0.12)' : 'rgba(22,163,74,0.12)',
              color: highlighted ? '#2563EB' : '#16A34A',
            }}
          >
            <Check size={11} />
          </span>
          <span className="text-genz-navy/80 text-[13.5px] leading-relaxed">{f}</span>
        </li>
      ))}
    </ul>

    {/* CTA */}
    <Link
      to={ctaTo}
      className={`flex items-center justify-center gap-2 py-3 rounded-[14px] text-[14px] font-bold transition-all duration-200 ${
        highlighted
          ? 'text-white hover:-translate-y-0.5'
          : 'text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] hover:border-genz-blue/50'
      }`}
      style={
        highlighted
          ? { background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 26px -8px rgba(37,99,235,0.45)' }
          : {}
      }
    >
      {highlighted && <Zap size={14} />}
      {cta}
    </Link>
  </div>
);

export default PricingCard;

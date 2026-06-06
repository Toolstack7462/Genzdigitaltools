import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

const ServiceCard = ({ icon: Icon, title, description, to, color = 'teal', delay = 0 }) => {
  const colorMap = {
    teal:   { bg: 'rgba(0,175,193,0.1)',  border: 'rgba(0,175,193,0.2)',  text: '#00AFC1' },
    blue:   { bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.2)', text: '#60a5fa' },
    purple: { bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.2)', text: '#a78bfa' },
    green:  { bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.2)',  text: '#4ade80' },
    pink:   { bg: 'rgba(236,72,153,0.1)', border: 'rgba(236,72,153,0.2)', text: '#f472b6' },
    orange: { bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.2)', text: '#fb923c' },
    cyan:   { bg: 'rgba(6,182,212,0.1)',  border: 'rgba(6,182,212,0.2)',  text: '#22d3ee' },
    indigo: { bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.2)', text: '#818cf8' },
  };
  const c = colorMap[color] || colorMap.teal;

  return (
    <Link
      to={to}
      className="group card-premium card-glow block p-6"
      style={{ transitionDelay: `${delay}ms` }}
    >
      {/* Icon */}
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 transition-all duration-300 group-hover:scale-110"
        style={{ background: c.bg, border: `1px solid ${c.border}` }}
      >
        {Icon && <Icon size={22} style={{ color: c.text }} />}
      </div>

      {/* Content */}
      <h3 className="text-white font-semibold text-base mb-2 group-hover:text-genz-teal transition-colors duration-200">
        {title}
      </h3>
      <p className="text-white/50 text-sm leading-relaxed mb-4">{description}</p>

      {/* CTA */}
      <span
        className="inline-flex items-center gap-1.5 text-xs font-semibold transition-all duration-200 group-hover:gap-2.5"
        style={{ color: c.text }}
      >
        Learn More <ArrowRight size={12} />
      </span>
    </Link>
  );
};

export default ServiceCard;

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

const ServiceCard = ({ icon: Icon, title, description, to, color = 'teal', delay = 0 }) => {
  const colorMap = {
    teal:   '#06B6D4',
    blue:   '#2563EB',
    purple: '#7C3AED',
    green:  '#16A34A',
    pink:   '#DB2777',
    orange: '#EA580C',
    cyan:   '#0891B2',
    indigo: '#4F46E5',
  };
  const c = colorMap[color] || colorMap.teal;

  return (
    <Link
      to={to}
      className="gz-card group flex flex-col p-7"
      style={{ transitionDelay: `${delay}ms` }}
    >
      {/* Icon */}
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-105"
        style={{ background: `${c}14`, border: `1px solid ${c}26`, color: c }}
      >
        {Icon && <Icon size={22} />}
      </div>

      {/* Content */}
      <h3 className="text-genz-navy font-bold text-[20px] leading-tight mb-2 transition-colors duration-200 group-hover:text-genz-blue">
        {title}
      </h3>
      <p className="text-genz-muted text-[15px] leading-relaxed mb-5 flex-1">{description}</p>

      {/* CTA */}
      <span
        className="inline-flex items-center gap-1.5 text-[14px] font-semibold transition-all duration-200 group-hover:gap-2.5"
        style={{ color: c }}
      >
        Learn More <ArrowRight size={14} />
      </span>
    </Link>
  );
};

export default ServiceCard;

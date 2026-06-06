import { Link } from 'react-router-dom';
import { MessageCircle, ArrowRight, LayoutDashboard } from 'lucide-react';
import { WHATSAPP_URL } from './PublicNavbar';
import { useReveal } from '../../hooks/useReveal';

const CTASection = ({
  headline = 'Ready to build your digital presence?',
  sub = 'Talk to us today — tools, services, or a fully custom solution.',
}) => {
  const [ref, visible] = useReveal();

  return (
    <section className="py-24 px-4 relative overflow-hidden">
      {/* Background glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 50% 100%, rgba(0,175,193,0.12) 0%, transparent 70%)',
        }}
      />
      <div className="section-divider mb-16" />

      <div
        ref={ref}
        className={`max-w-3xl mx-auto text-center reveal ${visible ? 'visible' : ''}`}
      >
        {/* Glow pill */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-semibold text-genz-teal mb-8"
          style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
          <span className="glow-dot" />
          Get started today
        </div>

        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-5 leading-tight">
          {headline}
        </h2>
        <p className="text-white/50 text-lg mb-10 leading-relaxed">{sub}</p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-7 py-3.5 rounded-full text-base font-bold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
            style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}
          >
            <MessageCircle size={17} />
            Contact on WhatsApp
          </a>
          <Link
            to="/services"
            className="flex items-center gap-2 px-7 py-3.5 rounded-full text-base font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all"
          >
            View Services <ArrowRight size={15} />
          </Link>
          <Link
            to="/client/login"
            className="flex items-center gap-2 px-7 py-3.5 rounded-full text-base font-medium text-white/60 border border-white/10 hover:border-white/25 hover:text-white/80 transition-all"
          >
            <LayoutDashboard size={15} />
            Member Login
          </Link>
        </div>
      </div>
    </section>
  );
};

export default CTASection;

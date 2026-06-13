import { Link } from 'react-router-dom';
import { MessageCircle, ArrowRight, LayoutDashboard } from 'lucide-react';
import { WHATSAPP_URL, APP_LOGIN_URL } from './PublicNavbar';
import { useReveal } from '../../hooks/useReveal';

const CTASection = ({
  headline = 'Ready to build your digital presence?',
  sub = 'Talk to us today — tools, services, or a fully custom solution.',
}) => {
  const [ref, visible] = useReveal();

  return (
    <section className="gz-section px-5">
      <div ref={ref} className={`gz-container reveal ${visible ? 'visible' : ''}`} style={{ maxWidth: 1100 }}>
        <div
          className="gz-panel-dark relative overflow-hidden px-6 py-14 sm:px-12 sm:py-16 text-center"
        >
          {/* Background glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse 70% 70% at 50% 0%, rgba(6,182,212,0.22) 0%, transparent 65%)',
            }}
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest text-genz-cyan mb-7"
              style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.3)' }}>
              <span className="glow-dot" />
              Get started today
            </div>

            <h2 className="type-section-title text-white mb-4">{headline}</h2>
            <p className="text-white/70 text-[17px] mb-9 leading-relaxed max-w-xl mx-auto">{sub}</p>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-7 py-3.5 rounded-[14px] text-[15px] font-bold text-white transition-all hover:-translate-y-0.5"
                style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 28px rgba(6,182,212,0.3)' }}
              >
                <MessageCircle size={17} />
                Contact on WhatsApp
              </a>
              <Link
                to="/services"
                className="flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-semibold text-white border border-white/25 hover:bg-white/10 transition-all"
              >
                View Services <ArrowRight size={15} />
              </Link>
              <a
                href={APP_LOGIN_URL}
                className="flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-medium text-white/70 hover:text-white transition-all"
              >
                <LayoutDashboard size={15} />
                Member Login
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CTASection;

import { Link } from 'react-router-dom';
import { ArrowRight, Cpu, Instagram, PenTool, Globe, Smartphone, Palette, TrendingUp, Settings } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';

const SERVICES = [
  { icon: Cpu,        color: '#00AFC1', title: 'Digital Tools Access',       sub: 'Secure access to AI, SEO, design and productivity tools via your client dashboard.',   to: '/services/digital-tools' },
  { icon: Instagram,  color: '#e1306c', title: 'Social Media Management',    sub: 'Full social media management — content, design, strategy, and growth reporting.',       to: '/services/social-media-management' },
  { icon: PenTool,    color: '#a78bfa', title: 'Writing Services',           sub: 'Website copy, blog articles, business writing, academic support and proofreading.',       to: '/services/writing-services' },
  { icon: Globe,      color: '#60a5fa', title: 'Web Design & Development',   sub: 'Animated, responsive websites — landing pages, business sites, and dashboards.',          to: '/services/web-design-development' },
  { icon: Smartphone, color: '#4ade80', title: 'App Development',            sub: 'Web apps, mobile apps, admin panels, booking systems, and automation tools.',             to: '/services/app-development' },
  { icon: Palette,    color: '#fb923c', title: 'Branding & Design',          sub: 'Brand identity, logos, flyers, social media creatives, and presentation design.',         to: '/services/branding-design' },
  { icon: TrendingUp, color: '#22d3ee', title: 'SEO & Digital Growth',       sub: 'Keyword research, on-page SEO, link building, and long-term digital growth strategies.',  to: '/services/seo-digital-growth' },
  { icon: Settings,   color: '#818cf8', title: 'Business Automation & CRM',  sub: 'Workflow automation, CRM integration, client portals and internal tooling.',              to: '/contact' },
];

const Services = () => {
  const [ref, visible] = useReveal(0.05);
  const [cardsRef, cardsVisible] = useReveal();

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 0%,rgba(0,175,193,0.1),transparent 70%)' }} />
        <div ref={ref} className={`max-w-3xl mx-auto text-center reveal ${visible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> What We Offer
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            All Our <span className="text-gradient-teal">Digital Services</span>
          </h1>
          <p className="text-white/55 text-base sm:text-lg leading-relaxed max-w-2xl mx-auto">
            From secure premium tool access to complete creative and technical services —
            Gen Z Digital Store is your full digital growth partner.
          </p>
        </div>
      </section>

      {/* Services grid */}
      <section className="py-16 px-4 pb-24">
        <div ref={cardsRef} className={`max-w-7xl mx-auto reveal ${cardsVisible ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-2 gap-6">
            {SERVICES.map(({ icon: Icon, color, title, sub, to }) => (
              <Link
                key={to}
                to={to}
                className="group flex gap-6 p-7 rounded-2xl transition-all duration-300 hover:-translate-y-0.5"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <div className="flex-shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300 group-hover:scale-110"
                  style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
                  <Icon size={24} style={{ color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h3 className="text-white font-semibold text-base group-hover:text-genz-teal transition-colors">{title}</h3>
                    <ArrowRight size={15} className="flex-shrink-0 text-white/20 group-hover:text-genz-teal group-hover:translate-x-1 transition-all" />
                  </div>
                  <p className="text-white/50 text-sm leading-relaxed">{sub}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Services;

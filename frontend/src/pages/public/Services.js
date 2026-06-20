import { Link } from 'react-router-dom';
import { ArrowRight, Cpu, Instagram, PenTool, Globe, Smartphone, Palette, TrendingUp, Settings, CheckCircle } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import PageHero from '../../components/public/PageHero';

const SERVICES = [
  { icon: Cpu,        color: '#06B6D4', title: 'Digital Tools Access',       sub: 'Secure access to AI, SEO, design and productivity tools via your client dashboard.',   to: '/services/digital-tools',
    bullets: ['90+ premium tools', 'Encrypted bridge', 'Admin-managed access'], badge: 'Most Popular' },
  { icon: Instagram,  color: '#DB2777', title: 'Social Media Management',    sub: 'Full social media management: content, design, strategy, and growth reporting.',       to: '/services/social-media-management',
    bullets: ['Content calendars', 'Reels & posts', 'Growth reporting'] },
  { icon: PenTool,    color: '#7C3AED', title: 'Writing Services',           sub: 'Website copy, blog articles, business writing, academic support and proofreading.',    to: '/services/writing-services',
    bullets: ['Blog & web copy', 'Research support', 'Proofreading'] },
  { icon: Globe,      color: '#2563EB', title: 'Web Design & Development',   sub: 'Animated, responsive websites: landing pages, business sites, and dashboards.',        to: '/services/web-design-development',
    bullets: ['Responsive & fast', 'Animated UIs', 'SEO-ready'] },
  { icon: Smartphone, color: '#14B8A6', title: 'App Development',            sub: 'Web apps, mobile apps, admin panels, booking systems, and automation tools.',           to: '/services/app-development',
    bullets: ['iOS & Android', 'Admin panels', 'Booking & CRM'] },
  { icon: Palette,    color: '#F97316', title: 'Branding & Design',          sub: 'Brand identity, logos, flyers, social media creatives, and presentation design.',       to: '/services/branding-design',
    bullets: ['Logo & identity', 'Social creatives', 'Pitch decks'] },
  { icon: TrendingUp, color: '#0891B2', title: 'SEO & Digital Growth',       sub: 'Keyword research, on-page SEO, link building, and long-term digital growth strategies.', to: '/services/seo-digital-growth',
    bullets: ['Keyword research', 'On-page SEO', 'Link building'] },
  { icon: Settings,   color: '#4F46E5', title: 'Business Automation & CRM',  sub: 'Workflow automation, CRM integration, client portals and internal tooling.',             to: '/contact',
    bullets: ['Automation flows', 'CRM systems', 'Client portals'] },
];

const Services = () => {
  const [cardsRef, cardsV] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="What We Offer"
        title={<>All Our <span className="text-grad-brand">Digital Services</span></>}
        subtitle="From secure premium tool access to complete creative and technical services, Gen Z Digital Store is your full digital growth partner."
      />

      {/* Services grid */}
      <section className="gz-section px-5 pt-0 -mt-8">
        <div ref={cardsRef} className={`gz-container reveal ${cardsV ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 gap-6">
            {SERVICES.map(({ icon: Icon, color, title, sub, to, bullets, badge }) => (
              <Link
                key={title}
                to={to}
                className="gz-card gz-card-accent sheen group flex flex-col p-7"
              >
                <div className="flex items-start justify-between mb-4">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
                    style={{ background: `${color}14`, border: `1px solid ${color}30`, color }}
                  >
                    <Icon size={24} />
                  </div>
                  {badge && (
                    <span className="ds-badge ds-badge-info">{badge}</span>
                  )}
                </div>
                <h3 className="text-genz-navy font-bold text-[20px] leading-tight mb-2 group-hover:text-genz-blue transition-colors">{title}</h3>
                <p className="text-genz-muted text-[14.5px] leading-relaxed mb-5 flex-1">{sub}</p>
                <ul className="space-y-1.5 mb-5">
                  {bullets.map((b) => (
                    <li key={b} className="flex items-center gap-2 text-[13.5px] text-genz-navy/80">
                      <CheckCircle size={13} style={{ color }} className="flex-shrink-0" /> {b}
                    </li>
                  ))}
                </ul>
                <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold group-hover:gap-2.5 transition-all" style={{ color }}>
                  Learn more <ArrowRight size={15} />
                </span>
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

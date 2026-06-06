import { MessageCircle, Globe, CheckCircle, Zap, Monitor, ShoppingBag, LayoutDashboard, Database } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const WEB_TYPES = [
  { icon: Zap,           color: '#00AFC1', title: 'Animated Landing Pages',   desc: 'High-converting landing pages with smooth animations and strong CTAs.' },
  { icon: Globe,         color: '#60a5fa', title: 'Business Websites',        desc: 'Professional multi-page websites representing your brand at its best.' },
  { icon: Monitor,       color: '#a78bfa', title: 'Portfolio Websites',       desc: 'Stunning portfolio sites for creatives, freelancers, and agencies.' },
  { icon: ShoppingBag,   color: '#fb923c', title: 'E-Commerce Stores',        desc: 'Full-featured online stores with product management and payment integration.' },
  { icon: LayoutDashboard,color: '#4ade80',title: 'Admin Dashboards',         desc: 'Custom admin panels and internal tools for managing your business data.' },
  { icon: Database,      color: '#f472b6', title: 'CRM & Client Portals',     desc: 'Custom CRM systems and client-facing portals for your business operations.' },
];

const TECH = ['React.js', 'Next.js', 'Tailwind CSS', 'Node.js', 'Express', 'MySQL', 'MongoDB', 'Framer Motion'];

const ServiceWebDesign = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [typesRef, typesVisible] = useReveal();
  const [techRef, techVisible] = useReveal();

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(0,175,193,0.13),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> Web Design & Development
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            Websites that look <span className="text-gradient-teal">premium</span> and perform
          </h1>
          <p className="text-white/55 text-base sm:text-lg leading-relaxed mb-8">
            We design and develop animated, responsive, high-performance websites that
            represent your brand at its absolute best — built to convert.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-sm font-bold text-genz-deep-navy transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
            <MessageCircle size={15} /> Discuss Your Website
          </a>
        </div>
      </section>

      {/* Website types */}
      <section className="py-20 px-4">
        <div ref={typesRef} className={`max-w-6xl mx-auto reveal ${typesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-12">What we build</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {WEB_TYPES.map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="p-6 rounded-2xl transition-all hover:-translate-y-0.5"
                style={{ background: `${color}09`, border: `1px solid ${color}20` }}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: `${color}20` }}>
                  <Icon size={20} style={{ color }} />
                </div>
                <h3 className="text-white font-semibold text-sm mb-2">{title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tech stack */}
      <section className="py-16 px-4">
        <div ref={techRef} className={`max-w-4xl mx-auto text-center reveal ${techVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-white mb-4">Our tech stack</h2>
          <p className="text-white/50 text-sm mb-10">We use modern, battle-tested technologies to deliver fast, scalable websites.</p>
          <div className="flex flex-wrap justify-center gap-3">
            {TECH.map(t => (
              <span key={t} className="px-4 py-2 rounded-full text-sm font-medium text-genz-teal"
                style={{ background: 'rgba(0,175,193,0.1)', border: '1px solid rgba(0,175,193,0.2)' }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Standards */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto rounded-3xl p-8" style={{ background: 'rgba(0,175,193,0.06)', border: '1px solid rgba(0,175,193,0.18)' }}>
          <h3 className="text-white font-bold text-xl mb-6 text-center">Every website we build includes</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {['Mobile-first responsive design','Smooth CSS/JS animations','SEO-optimised structure','Fast load times','Clean, maintainable code','Cross-browser compatibility','SSL-ready hosting setup','Post-launch support'].map(f=>(
              <div key={f} className="flex items-start gap-2.5 text-white/65 text-sm">
                <CheckCircle size={14} className="text-genz-teal flex-shrink-0 mt-0.5" /> {f}
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to build your website?" sub="Share your requirements and we will send a proposal within 24 hours." />
    </div>
  );
};

export default ServiceWebDesign;

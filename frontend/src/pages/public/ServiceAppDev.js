import { MessageCircle, Smartphone, Globe, CheckCircle, Settings, Calendar, Users, Cpu } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const APP_TYPES = [
  { icon: Globe,      color: '#4ade80', title: 'Web Applications',    desc: 'Full-stack React web apps with dashboards, user auth, and database integration.' },
  { icon: Smartphone, color: '#60a5fa', title: 'Mobile Apps',         desc: 'iOS and Android-compatible mobile apps built with modern cross-platform frameworks.' },
  { icon: Users,      color: '#a78bfa', title: 'Admin Panels',        desc: 'Powerful internal admin systems for managing users, data, and operations.' },
  { icon: Cpu,        color: '#06B6D4', title: 'Client Portals',      desc: 'Secure client-facing portals for project tracking, file sharing, and communication.' },
  { icon: Calendar,   color: '#fb923c', title: 'Booking Systems',     desc: 'Online appointment and service booking systems with calendar integration.' },
  { icon: Settings,   color: '#f472b6', title: 'Automation Tools',    desc: 'Custom internal tools and workflow automation to save time and reduce manual work.' },
];

const ServiceAppDev = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [typesRef, typesVisible] = useReveal();
  const [processRef, processVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(74,222,128,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.08)', color: '#4ade80' }}>
            <span className="glow-dot" style={{ background: '#4ade80' }} /> App Development
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            Custom apps, built <span style={{ WebkitTextFillColor: 'transparent', background: 'linear-gradient(135deg,#4ade80,#16a34a)', WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>to scale</span>
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            Whether you need a web app, mobile app, admin system, or automation tool —
            we build functional, scalable software tailored exactly to your requirements.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-sm font-bold text-white transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#4ade80,#16a34a)' }}>
            <MessageCircle size={15} /> Discuss Your App Idea
          </a>
        </div>
      </section>

      {/* App types */}
      <section className="py-20 px-4">
        <div ref={typesRef} className={`max-w-6xl mx-auto reveal ${typesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-12">What we build</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {APP_TYPES.map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="p-6 rounded-2xl transition-all hover:-translate-y-0.5"
                style={{ background: `${color}09`, border: `1px solid ${color}20` }}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: `${color}20` }}>
                  <Icon size={20} style={{ color }} />
                </div>
                <h3 className="text-genz-navy font-semibold text-sm mb-2">{title}</h3>
                <p className="text-genz-muted text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section className="py-16 px-4">
        <div ref={processRef} className={`max-w-3xl mx-auto reveal ${processVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-genz-navy text-center mb-10">Our development process</h2>
          <div className="space-y-4">
            {[
              { n:'01', t:'Discovery & Requirements', s:'We analyse your requirements, define scope, and plan the technical architecture.' },
              { n:'02', t:'UI/UX Design',             s:'Wireframes and design mockups created and approved before development begins.' },
              { n:'03', t:'Development',              s:'Front-end and back-end development with regular progress updates.' },
              { n:'04', t:'Testing & QA',             s:'Full testing across devices, browsers, and edge cases before handover.' },
              { n:'05', t:'Launch & Support',         s:'Deployment, documentation, and ongoing maintenance support.' },
            ].map(({ n, t, s }) => (
              <div key={n} className="flex gap-5 p-5 rounded-2xl"
                style={{ background: '#ffffff', border: '1px solid #ffffff' }}>
                <span className="text-2xl font-extrabold flex-shrink-0" style={{ color: 'rgba(74,222,128,0.4)' }}>{n}</span>
                <div>
                  <h3 className="text-genz-navy font-semibold text-sm mb-1">{t}</h3>
                  <p className="text-genz-muted text-sm">{s}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to build your app?" sub="Share your idea and we will send a technical proposal with timeline and pricing." />
    </div>
  );
};

export default ServiceAppDev;

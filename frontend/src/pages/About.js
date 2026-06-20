import { Link } from 'react-router-dom';
import { Shield, Zap, Star, ArrowRight, CheckCircle, Users, Award, Globe, Cpu, Target } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import CTASection from '../components/public/CTASection';
import PageHero from '../components/public/PageHero';

const OFFER = [
  { icon: Cpu,    color: '#06B6D4', title: 'Premium Tools Access',     desc: 'Secure admin-managed access to AI, SEO, design, and productivity tools.' },
  { icon: Users,  color: '#DB2777', title: 'Social Media Management',  desc: 'Full content management, design, strategy, and growth reporting.' },
  { icon: Globe,  color: '#2563EB', title: 'Web Design & Development', desc: 'Animated websites, landing pages, and complete web applications.' },
  { icon: Zap,    color: '#14B8A6', title: 'App Development',          desc: 'Custom web and mobile apps built for real business needs.' },
  { icon: Award,  color: '#F97316', title: 'Branding & Design',        desc: 'Brand identity, social media creatives, and visual design services.' },
  { icon: Shield, color: '#7C3AED', title: 'Business Automation',      desc: 'CRM systems, workflow automation, and client portal development.' },
];

const VALUES = [
  { t: 'Quality over quantity', s: 'Every deliverable, whether a tool, a website, or a piece of content, is held to a high standard.' },
  { t: 'Security first',        s: 'Our tool access system is built with security at the core. No credential exposure, ever.' },
  { t: 'Transparency',          s: 'Clear communication, honest pricing, and no hidden surprises at any stage.' },
  { t: 'Client success',        s: 'We measure our success by the real results our clients achieve with our tools and services.' },
];

const About = () => {
  const [missionRef, missionV] = useReveal();
  const [offerRef, offerV] = useReveal();
  const [valuesRef, valuesV] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="About Us"
        title={<>Built to power your <span className="text-grad-brand">digital growth</span></>}
        subtitle="Gen Z Digital Store is a premium digital platform combining secure tool access with professional creative and technical services, built for individuals, creators, and businesses ready to grow."
      />

      {/* Mission / Vision */}
      <section className="gz-section px-5">
        <div ref={missionRef} className={`gz-container reveal ${missionV ? 'visible' : ''}`}>
          <div className="grid md:grid-cols-2 gap-7 max-w-5xl mx-auto">
            <div className="gz-tint-card" style={{ '--tint': 'linear-gradient(135deg, rgba(6,182,212,0.16), rgba(37,99,235,0.08))' }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5 text-white"
                style={{ background: 'linear-gradient(135deg,#06B6D4,#14B8A6)', boxShadow: '0 12px 26px -10px rgba(6,182,212,0.45)' }}>
                <Target size={22} />
              </div>
              <h3 className="text-genz-navy font-bold text-[22px] mb-3">Our Mission</h3>
              <p className="text-genz-muted text-[15px] leading-relaxed">
                To make premium digital tools and professional services accessible to every creator,
                entrepreneur, and business, through a secure, well-designed, and reliable platform.
              </p>
            </div>
            <div className="gz-tint-card" style={{ '--tint': 'linear-gradient(135deg, rgba(37,99,235,0.14), rgba(20,184,166,0.10))' }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5 text-white"
                style={{ background: 'linear-gradient(135deg,#2563EB,#0891B2)', boxShadow: '0 12px 26px -10px rgba(37,99,235,0.45)' }}>
                <Star size={22} />
              </div>
              <h3 className="text-genz-navy font-bold text-[22px] mb-3">Our Vision</h3>
              <p className="text-genz-muted text-[15px] leading-relaxed">
                To be the go-to digital growth partner for the next generation of online businesses,
                delivering tools, creativity, and technology under one unified brand.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What we offer */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={offerRef} className={`gz-container reveal ${offerV ? 'visible' : ''}`}>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> What we offer</div>
            <h2 className="font-heading text-genz-navy font-extrabold text-3xl sm:text-4xl mb-3">
              Six core service lines, <span className="text-grad-brand">one platform</span>
            </h2>
            <p className="text-genz-muted">Everything your digital brand needs: premium tools and creative services delivered to a high standard.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-6xl mx-auto">
            {OFFER.map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="gz-card-soft group flex gap-4 p-6">
                <div className="w-12 h-12 rounded-2xl flex-shrink-0 flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
                  style={{ background: `${color}14`, border: `1px solid ${color}30`, color }}>
                  <Icon size={20} />
                </div>
                <div>
                  <h4 className="text-genz-navy font-bold text-[15.5px] mb-1.5">{title}</h4>
                  <p className="text-genz-muted text-[14px] leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="gz-section px-5">
        <div ref={valuesRef} className={`gz-container max-w-4xl mx-auto reveal ${valuesV ? 'visible' : ''}`}>
          <div className="text-center mb-12">
            <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> Our values</div>
            <h2 className="font-heading text-genz-navy font-extrabold text-3xl sm:text-4xl mb-3">
              What we <span className="text-grad-cyan-teal">stand for</span>
            </h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
            {VALUES.map(({ t, s }) => (
              <div key={t} className="gz-card-soft flex gap-3 p-6">
                <CheckCircle size={18} className="text-genz-blue flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-genz-navy font-bold text-[15.5px] mb-1.5">{t}</h4>
                  <p className="text-genz-muted text-[14px] leading-relaxed">{s}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-12 flex flex-wrap justify-center gap-3">
            <Link to="/services" className="btn-grad inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
              View Services <ArrowRight size={15} />
            </Link>
            <Link to="/contact" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
              Contact Us
            </Link>
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default About;

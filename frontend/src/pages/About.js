import { Link } from 'react-router-dom';
import { Shield, Zap, Star, ArrowRight, CheckCircle, Users, Award, Globe, Cpu, Target } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import CTASection from '../components/public/CTASection';

const About = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [missionRef, missionVisible] = useReveal();
  const [valuesRef, valuesVisible] = useReveal();
  const [servicesRef, servicesVisible] = useReveal();

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(0,175,193,0.12),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> About Us
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            Built to power your <span className="text-gradient-teal">digital growth</span>
          </h1>
          <p className="text-white/55 text-base sm:text-lg leading-relaxed">
            Gen Z Digital Store is a premium digital platform combining secure tool access with
            professional creative and technical services — built for individuals, creators, and businesses ready to grow.
          </p>
        </div>
      </section>

      {/* Mission */}
      <section className="py-20 px-4">
        <div ref={missionRef} className={`max-w-5xl mx-auto reveal ${missionVisible ? 'visible' : ''}`}>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="rounded-3xl p-8" style={{ background: 'rgba(0,175,193,0.07)', border: '1px solid rgba(0,175,193,0.2)' }}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-5" style={{ background: 'rgba(0,175,193,0.2)' }}>
                <Target size={20} className="text-genz-teal" />
              </div>
              <h3 className="text-white font-bold text-xl mb-3">Our Mission</h3>
              <p className="text-white/55 text-sm leading-relaxed">
                To make premium digital tools and professional services accessible to every creator,
                entrepreneur, and business — through a secure, well-designed, and reliable platform.
              </p>
            </div>
            <div className="rounded-3xl p-8" style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.2)' }}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-5" style={{ background: 'rgba(139,92,246,0.2)' }}>
                <Star size={20} style={{ color: '#a78bfa' }} />
              </div>
              <h3 className="text-white font-bold text-xl mb-3">Our Vision</h3>
              <p className="text-white/55 text-sm leading-relaxed">
                To be the go-to digital growth partner for the next generation of online businesses —
                delivering tools, creativity, and technology under one unified brand.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What we offer */}
      <section className="py-16 px-4">
        <div ref={servicesRef} className={`max-w-5xl mx-auto reveal ${servicesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-12">What Gen Z Digital Store offers</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Cpu,    color: '#00AFC1', title: 'Premium Tools Access',      desc: 'Secure admin-managed access to AI, SEO, design, and productivity tools.' },
              { icon: Users,  color: '#e1306c', title: 'Social Media Management',   desc: 'Full content management, design, strategy, and growth reporting.' },
              { icon: Globe,  color: '#60a5fa', title: 'Web Design & Development',  desc: 'Animated websites, landing pages, and complete web applications.' },
              { icon: Zap,    color: '#4ade80', title: 'App Development',           desc: 'Custom web and mobile apps built for real business needs.' },
              { icon: Award,  color: '#fb923c', title: 'Branding & Design',         desc: 'Brand identity, social media creatives, and visual design services.' },
              { icon: Shield, color: '#a78bfa', title: 'Business Automation',       desc: 'CRM systems, workflow automation, and client portal development.' },
            ].map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="flex gap-4 p-5 rounded-2xl"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center"
                  style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
                  <Icon size={18} style={{ color }} />
                </div>
                <div>
                  <h4 className="text-white font-semibold text-sm mb-1">{title}</h4>
                  <p className="text-white/45 text-xs leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-16 px-4">
        <div ref={valuesRef} className={`max-w-4xl mx-auto reveal ${valuesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-white text-center mb-10">Our values</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { t: 'Quality over quantity', s: 'Every deliverable — whether a tool, a website, or a piece of content — is held to a high standard.' },
              { t: 'Security first', s: 'Our tool access system is built with security at the core. No credential exposure, ever.' },
              { t: 'Transparency', s: 'Clear communication, honest pricing, and no hidden surprises at any stage.' },
              { t: 'Client success', s: 'We measure our success by the real results our clients achieve with our tools and services.' },
            ].map(({ t, s }) => (
              <div key={t} className="flex gap-3 p-5 rounded-2xl"
                style={{ background: 'rgba(0,175,193,0.05)', border: '1px solid rgba(0,175,193,0.12)' }}>
                <CheckCircle size={16} className="text-genz-teal flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-white font-semibold text-sm mb-1">{t}</h4>
                  <p className="text-white/45 text-xs leading-relaxed">{s}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-12 px-4">
        <div className="max-w-xl mx-auto text-center">
          <h2 className="text-2xl font-bold text-white mb-4">Ready to work with us?</h2>
          <p className="text-white/50 text-sm mb-7">Explore our services or get in touch to discuss your project.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link to="/services" className="px-6 py-3 rounded-full text-sm font-bold text-genz-deep-navy"
              style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
              View Services <ArrowRight size={14} className="inline ml-1" />
            </Link>
            <Link to="/contact" className="px-6 py-3 rounded-full text-sm font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all">
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

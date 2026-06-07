import { Link } from 'react-router-dom';
import {
  Zap, ArrowRight, MessageCircle, LayoutDashboard, Shield, Star,
  Globe, Smartphone, Palette, TrendingUp, PenTool, Settings,
  CheckCircle, ChevronRight, FileText,
  Instagram, Code, BarChart2, Layers, Cpu, Headphones, Award,
} from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import ServiceCard from '../components/public/ServiceCard';
import FeatureCard from '../components/public/FeatureCard';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';

const Eyebrow = ({ label }) => (
  <div className="gz-eyebrow mb-5">
    <span className="glow-dot" /> {label}
  </div>
);

const StatBadge = ({ n, label }) => (
  <div>
    <div className="font-heading text-[32px] font-extrabold text-genz-navy leading-none">{n}</div>
    <div className="text-genz-muted text-[13px] mt-1.5 leading-tight">{label}</div>
  </div>
);

/* ── Hero "Service Command Center" — clean, light, aligned tiles ───────── */
const COMMAND_SERVICES = [
  { icon: Cpu,       label: 'Digital Tools',      sub: 'Assigned access',     color: '#06B6D4' },
  { icon: Globe,     label: 'Website Design',     sub: 'Sites & portals',     color: '#2563EB' },
  { icon: BarChart2, label: 'Research Support',   sub: 'Reports & analysis',  color: '#14B8A6' },
  { icon: Palette,   label: 'Graphic Design',     sub: 'Brand visuals',       color: '#4F46E5' },
  { icon: Instagram, label: 'Social Media',       sub: 'Content systems',     color: '#0891B2' },
  { icon: FileText,  label: 'Business Documents', sub: 'Docs & decks',        color: '#0EA5E9' },
];

const ServiceCommandCenter = () => (
  <div className="gz-card p-6 sm:p-7">
    <div className="mb-6 flex items-center justify-between gap-4 border-b border-genz-border pb-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-genz-blue">Service Command Center</p>
        <h2 className="mt-1.5 text-[20px] font-bold text-genz-navy leading-tight">One platform for digital delivery</h2>
      </div>
      <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold text-emerald-600"
        style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.22)' }}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Live support
      </span>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {COMMAND_SERVICES.map(({ icon: Icon, label, sub, color }) => (
        <div
          key={label}
          className="flex items-center gap-3 rounded-2xl px-4 py-3.5 transition-all duration-200 hover:-translate-y-0.5"
          style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${color}14`, color, border: `1px solid ${color}26` }}>
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-genz-navy">{label}</p>
            <p className="mt-0.5 text-[12px] text-genz-muted">{sub}</p>
          </div>
        </div>
      ))}
    </div>

    <div className="mt-6 grid grid-cols-3 gap-3 border-t border-genz-border pt-5 text-center">
      {[['6', 'Core Services'], ['1', 'Trusted Platform'], ['24/7', 'Access']].map(([n, l]) => (
        <div key={l}>
          <div className="font-heading text-[26px] font-extrabold brand-gradient-text leading-none">{n}</div>
          <div className="text-genz-muted text-[12px] mt-1.5 leading-tight">{l}</div>
        </div>
      ))}
    </div>
  </div>
);

const StepBadge = ({ n, label, sub, color = '#2563EB' }) => (
  <div className="flex gap-4">
    <div className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center font-bold text-[14px]"
      style={{ background: `${color}14`, border: `1px solid ${color}2e`, color }}>
      {n}
    </div>
    <div>
      <p className="text-genz-navy font-semibold text-[15px]">{label}</p>
      <p className="text-genz-muted text-[13.5px] mt-0.5 leading-relaxed">{sub}</p>
    </div>
  </div>
);

/* ── Primary services (mapped to existing routes) ─────────────────────── */
const SERVICES = [
  { icon: Cpu,        title: 'Digital Tools',                desc: 'Admin-managed access to AI, SEO, design and productivity tools.',           to: '/services/digital-tools',           color: 'teal'   },
  { icon: PenTool,    title: 'Academic & Research Support',  desc: 'Research help, reports, proofreading, business and academic writing.',       to: '/services/writing-services',        color: 'purple' },
  { icon: Globe,      title: 'Website & App Development',    desc: 'Animated landing pages, business websites, web apps and dashboards.',        to: '/services/web-design-development',  color: 'blue'   },
  { icon: Palette,    title: 'Graphic Design & Branding',    desc: 'Brand identity, logos, flyers, social creatives and presentations.',         to: '/services/branding-design',         color: 'indigo' },
  { icon: Instagram,  title: 'Social Media Marketing',       desc: 'Content calendars, post design, Reels strategy and growth reporting.',       to: '/services/social-media-management', color: 'cyan'   },
  { icon: FileText,   title: 'Document & Business Services',  desc: 'Documents, decks, automation, CRM and client-portal solutions.',             to: '/services',                         color: 'green'  },
];

const FAQS = [
  { q: 'What is Gen Z Digital Store?', a: 'Gen Z Digital Store is a premium digital platform offering secure access to professional tools, plus creative services including social media management, writing, web design, app development, branding, and SEO.' },
  { q: 'Do you only provide tools?', a: 'No. While we offer admin-managed access to premium digital tools, we also deliver a full range of digital services — from content creation and web design to mobile apps and business automation.' },
  { q: 'How does tool access work?', a: 'An admin assigns specific tools to your account. You log in to your client dashboard, and the Chrome extension securely connects you to your assigned tools in one click — no passwords needed.' },
  { q: 'Is the Chrome extension required?', a: 'The extension is required for secure tool access. It communicates with your session to open assigned tools safely. For our other digital services, no extension is needed.' },
  { q: 'Do you manage social media pages?', a: 'Yes — we offer full social media management including content calendars, post design, captions, Reels strategy, profile optimisation, and monthly growth reports.' },
  { q: 'Can you build a website or app?', a: 'Absolutely. We build animated landing pages, business websites, web apps, mobile apps, admin dashboards, CRM systems, client portals, and custom automation tools.' },
  { q: 'How do I order a service?', a: 'Contact us on WhatsApp or fill out our contact form. We will understand your requirements, send a proposal, and get started after confirmation.' },
  { q: 'How do I contact support?', a: 'Via WhatsApp, our contact page, or email. We aim to respond within a few hours during working hours.' },
];

const Home = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [servicesRef, servicesVisible] = useReveal();
  const [whyRef, whyVisible] = useReveal();
  const [howRef, howVisible] = useReveal();
  const [portfolioRef, portfolioVisible] = useReveal();
  const [pricingRef, pricingVisible] = useReveal();
  const [faqRef, faqVisible] = useReveal();

  return (
    <div className="text-genz-navy overflow-x-hidden" style={{ background: 'var(--brand-soft)' }}>

      {/* ── HERO ───────────────────────────────────────────────────── */}
      <section className="relative flex items-center pt-28 pb-20 lg:min-h-[88vh]"
        style={{ background: 'var(--gradient-hero)' }}>
        <div className="gz-container w-full">
          <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 xl:gap-16 items-center">
            <div ref={heroRef} className={`reveal ${heroVisible ? 'visible' : ''}`}>
              <Eyebrow label="Premium Digital Platform" />
              <h1 className="type-display text-genz-navy mb-5">
                Grow Smarter with{' '}
                <span className="brand-gradient-text">Gen Z Digital Store</span>
              </h1>
              <p className="type-body-large text-genz-muted mb-9 max-w-xl">
                Premium digital tools, websites, research support, branding, social media designs,
                documents and presentations — everything you need from one trusted digital platform.
              </p>
              <div className="flex flex-wrap gap-3 mb-12">
                <Link to="/services"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold text-white transition-all hover:-translate-y-0.5"
                  style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 28px rgba(37,99,235,0.25)' }}>
                  <Zap size={16} /> Explore Services
                </Link>
                <Link to="/client/login"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-navy border border-genz-border hover:border-genz-blue/40 hover:text-genz-blue transition-all">
                  <LayoutDashboard size={16} /> Member Dashboard
                </Link>
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-emerald-600 border border-emerald-200 hover:bg-emerald-50 transition-all">
                  <MessageCircle size={16} /> WhatsApp
                </a>
              </div>
              <div className="flex flex-wrap gap-x-10 gap-y-5 pt-8 border-t border-genz-border">
                <StatBadge n="6" label="Core Service Lines" />
                <StatBadge n="100%" label="Business Focused" />
                <StatBadge n="1" label="Trusted Platform" />
              </div>
            </div>

            <div className={`reveal delay-100 ${heroVisible ? 'visible' : ''}`}>
              <ServiceCommandCenter />
            </div>
          </div>
        </div>
      </section>

      {/* ── SERVICES OVERVIEW ──────────────────────────────────────── */}
      <section className="gz-section px-5">
        <div ref={servicesRef} className={`gz-container reveal ${servicesVisible ? 'visible' : ''}`}>
          <div className="text-center max-w-2xl mx-auto mb-14">
            <Eyebrow label="Our Services" />
            <h2 className="type-section-title text-genz-navy mb-4">Everything your digital brand needs</h2>
            <p className="text-genz-muted text-[16px]">
              From secure tool access to complete digital delivery — one platform, six core service lines.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {SERVICES.map((s, i) => <ServiceCard key={s.title} {...s} delay={i * 50} />)}
          </div>
          <div className="text-center mt-10">
            <Link to="/services" className="inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
              View All Services <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── WHY CHOOSE US ──────────────────────────────────────────── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={whyRef} className={`gz-container reveal ${whyVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <Eyebrow label="Why Choose Us" />
              <h2 className="type-section-title text-genz-navy mb-5 leading-tight">A platform built for serious digital work</h2>
              <p className="text-genz-muted text-[16px] leading-relaxed mb-8">
                We are not a generic template service. Gen Z Digital Store delivers premium quality,
                secure systems, and reliable digital expertise — all tailored to your goals.
              </p>
              <Link to="/about" className="inline-flex items-center gap-2 text-[15px] font-semibold text-genz-blue hover:gap-3 transition-all">
                Learn more about us <ArrowRight size={15} />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { icon: Shield,     title: 'Secure Tool Access',           desc: 'Admin-controlled assignment with encrypted extension bridge.',            color: '#06B6D4' },
                { icon: Palette,    title: 'Creative Gen Z Branding',      desc: 'Modern, bold visual styles built for creators and digital-first brands.', color: '#4F46E5' },
                { icon: Award,      title: 'Professional Delivery',        desc: 'Every project delivered at a professional standard, on time.',            color: '#16A34A' },
                { icon: Headphones, title: 'Fast Support',                 desc: 'Quick response for tools, services, and technical questions.',            color: '#2563EB' },
                { icon: Code,       title: 'Scalable Web & App Solutions', desc: 'From MVPs to full-scale platforms — we build what you actually need.',    color: '#0891B2' },
                { icon: Star,       title: 'Affordable Packages',          desc: 'Flexible pricing that scales with you — from individuals to businesses.',  color: '#DB2777' },
              ].map(f => <FeatureCard key={f.title} {...f} accentColor={f.color} />)}
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ───────────────────────────────────────────── */}
      <section className="gz-section px-5">
        <div ref={howRef} className={`gz-container reveal ${howVisible ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="How It Works" />
            <h2 className="type-section-title text-genz-navy mb-4">Simple. Secure. Fast.</h2>
            <p className="text-genz-muted text-[16px]">Two clear paths — tool access for members, services for your business.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="gz-card p-8">
              <div className="flex items-center gap-3 mb-7">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)' }}>
                  <Shield size={18} className="text-genz-cyan" style={{ color: '#06B6D4' }} />
                </div>
                <h3 className="text-genz-navy font-bold text-[20px]">Tool Access Flow</h3>
              </div>
              <div className="space-y-5">
                <StepBadge n="1" label="Admin assigns tools" sub="Your plan includes specific tools assigned by the admin." color="#06B6D4" />
                <StepBadge n="2" label="Client logs in" sub="Access your secure client dashboard with your credentials." color="#06B6D4" />
                <StepBadge n="3" label="Extension connects" sub="The Chrome extension bridges your session to assigned tools." color="#06B6D4" />
                <StepBadge n="4" label="Open tools securely" sub="One-click access — no exposed passwords or shared accounts." color="#06B6D4" />
              </div>
              <Link to="/chrome-extension" className="inline-flex items-center gap-1.5 mt-7 text-[15px] font-semibold text-genz-blue hover:gap-2.5 transition-all">
                Get the extension <ChevronRight size={15} />
              </Link>
            </div>
            <div className="gz-card p-8">
              <div className="flex items-center gap-3 mb-7">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(79,70,229,0.1)' }}>
                  <Layers size={18} style={{ color: '#4F46E5' }} />
                </div>
                <h3 className="text-genz-navy font-bold text-[20px]">Services Flow</h3>
              </div>
              <div className="space-y-5">
                <StepBadge n="1" label="Choose your service" sub="Browse our services and select what fits your goals." color="#4F46E5" />
                <StepBadge n="2" label="Share requirements" sub="Contact us via WhatsApp or the contact form with your brief." color="#4F46E5" />
                <StepBadge n="3" label="Receive proposal" sub="We review your needs and send a clear plan and quote." color="#4F46E5" />
                <StepBadge n="4" label="Project delivery" sub="We execute, revise, and deliver your project professionally." color="#4F46E5" />
              </div>
              <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 mt-7 text-[15px] font-semibold hover:gap-2.5 transition-all" style={{ color: '#4F46E5' }}>
                Contact us now <ChevronRight size={15} />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── PORTFOLIO ──────────────────────────────────────────────── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={portfolioRef} className={`gz-container reveal ${portfolioVisible ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="Portfolio" />
            <h2 className="type-section-title text-genz-navy mb-4">Concept work &amp; live projects</h2>
            <p className="text-genz-muted text-[16px]">A snapshot of what we build — from UI concepts to live digital platforms.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { label: 'Social Media Brand Kit Concept',     category: 'Branding',   color: '#DB2777' },
              { label: 'Animated SaaS Landing Page Concept', category: 'Web Design', color: '#06B6D4' },
              { label: 'Client Dashboard UI Concept',        category: 'Web App',    color: '#4F46E5' },
              { label: 'Digital Tools Access Platform',      category: 'Web App',    color: '#16A34A' },
              { label: 'Mobile App UI Concept',              category: 'App Dev',    color: '#2563EB' },
              { label: 'SEO Growth Strategy Deck Concept',   category: 'SEO',        color: '#0891B2' },
            ].map(({ label, category, color }) => (
              <div key={label} className="gz-card group overflow-hidden">
                <div className="h-44 relative flex items-center justify-center"
                  style={{ background: `linear-gradient(135deg,${color}12 0%, #ffffff 100%)` }}>
                  <div className="absolute inset-0" style={{ backgroundImage: `linear-gradient(${color}10 1px,transparent 1px),linear-gradient(90deg,${color}10 1px,transparent 1px)`, backgroundSize: '24px 24px' }} />
                  <div className="relative z-10 flex gap-3">
                    {[1, 2, 3].map(i => <div key={i} className="rounded-xl" style={{ width: i === 2 ? 52 : 36, height: i === 2 ? 52 : 36, background: `${color}22`, border: `1px solid ${color}40` }} />)}
                  </div>
                  <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[11px] font-semibold" style={{ background: `${color}18`, color, border: `1px solid ${color}38` }}>{category}</span>
                </div>
                <div className="p-6">
                  <h3 className="text-genz-navy font-bold text-[16px] group-hover:text-genz-blue transition-colors">{label}</h3>
                  <p className="text-genz-muted text-[13px] mt-1">Concept — available as a service</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link to="/portfolio" className="inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
              View Full Portfolio <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── PRICING ────────────────────────────────────────────────── */}
      <section className="gz-section px-5">
        <div ref={pricingRef} className={`gz-container reveal ${pricingVisible ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="Pricing" />
            <h2 className="type-section-title text-genz-navy mb-4">Transparent packages</h2>
            <p className="text-genz-muted text-[16px]">Flexible plans for every stage. Not sure what fits? Contact us for a custom quote.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { tier: 'Starter',      price: 'Contact', note: 'for quote', pop: false, features: ['Tool access (up to 3 tools)', 'Basic social media management', 'Content calendar', 'Email support', 'Monthly report'] },
              { tier: 'Professional', price: 'Contact', note: 'for quote', pop: true,  features: ['Tool access (up to 10 tools)', 'Full social media management', 'Blog writing (4 posts/mo)', 'Website or landing page', 'Priority support', 'Weekly reports'] },
              { tier: 'Business',     price: 'Contact', note: 'for quote', pop: false, features: ['Unlimited tool access', 'Social media + ad management', 'Web app or mobile app', 'Branding package', 'SEO strategy', 'Dedicated manager'] },
              { tier: 'Custom',       price: "Let's talk", note: '',       pop: false, features: ['Fully tailored plan', 'Mix of any services', 'API integrations', 'CRM & automation', 'Custom SLA', 'Executive support'] },
            ].map(p => (
              <div key={p.tier} className={`gz-card relative p-7 flex flex-col ${p.pop ? 'lg:-translate-y-2' : ''}`}
                style={p.pop ? { borderColor: 'rgba(37,99,235,0.45)', boxShadow: '0 24px 60px rgba(37,99,235,0.16)' } : {}}>
                {p.pop && <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-[11px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>Most Popular</div>}
                <div className="mb-5">
                  <span className={`text-[11px] font-bold uppercase tracking-[0.14em] ${p.pop ? 'text-genz-blue' : 'text-genz-muted'}`}>{p.tier}</span>
                  <div className="mt-2 font-heading text-genz-navy font-extrabold text-[26px]">{p.price}</div>
                  {p.note && <div className="text-genz-muted text-[12px] mt-0.5">{p.note}</div>}
                </div>
                <ul className="space-y-2.5 flex-1 mb-6">
                  {p.features.map(f => (
                    <li key={f} className="flex items-start gap-2">
                      <CheckCircle size={15} className="flex-shrink-0 mt-0.5" style={{ color: p.pop ? '#2563EB' : '#16A34A' }} />
                      <span className="text-genz-muted text-[13.5px]">{f}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/contact" className={`text-center py-3 rounded-[14px] text-[14px] font-bold transition-all ${p.pop ? 'text-white hover:-translate-y-0.5' : 'text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06]'}`}
                  style={p.pop ? { background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 24px rgba(37,99,235,0.22)' } : {}}>
                  {p.tier === 'Custom' ? 'Get a Custom Quote' : 'Get Started'}
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center text-genz-muted text-[13px] mt-8">Prices vary by scope. Contact us to discuss your specific needs.</p>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={faqRef} className={`mx-auto max-w-3xl reveal ${faqVisible ? 'visible' : ''}`}>
          <div className="text-center mb-12">
            <Eyebrow label="FAQ" />
            <h2 className="type-section-title text-genz-navy mb-4">Common questions</h2>
          </div>
          <div className="space-y-3">
            {FAQS.map((f, i) => <FAQItem key={i} question={f.q} answer={f.a} defaultOpen={i === 0} />)}
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Home;

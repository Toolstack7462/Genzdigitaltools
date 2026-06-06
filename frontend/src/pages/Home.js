import { Link } from 'react-router-dom';
import {
  Zap, ArrowRight, MessageCircle, LayoutDashboard, Shield, Star,
  Globe, Smartphone, Palette, TrendingUp, PenTool, Settings,
  CheckCircle, ChevronRight,
  Instagram, Code, BarChart2, Layers, Cpu, Headphones, Award,
} from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import ServiceCard from '../components/public/ServiceCard';
import FeatureCard from '../components/public/FeatureCard';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';

const SectionPill = ({ label }) => (
  <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-5 uppercase tracking-widest"
    style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
    <span className="glow-dot" /> {label}
  </div>
);

const FloatingCard = ({ icon: Icon, label, color = '#00AFC1', delay = '0s' }) => (
  <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl shadow-xl"
    style={{ background: 'rgba(0,16,48,0.85)', border: `1px solid ${color}35`, backdropFilter: 'blur(10px)', animation: 'float 3.5s ease-in-out infinite', animationDelay: delay }}>
    <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${color}20` }}>
      <Icon size={15} style={{ color }} />
    </div>
    <span className="text-white text-xs font-semibold whitespace-nowrap">{label}</span>
  </div>
);

const StepBadge = ({ n, label, sub, color = '#00AFC1' }) => (
  <div className="flex gap-4">
    <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm"
      style={{ background: `${color}20`, border: `1px solid ${color}40`, color }}>
      {n}
    </div>
    <div>
      <p className="text-white font-semibold text-sm">{label}</p>
      <p className="text-white/45 text-xs mt-0.5">{sub}</p>
    </div>
  </div>
);

const StatBadge = ({ n, label }) => (
  <div className="text-center">
    <div className="text-3xl font-extrabold text-genz-teal mb-1">{n}</div>
    <div className="text-white/50 text-xs leading-tight">{label}</div>
  </div>
);

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
  const [smRef, smVisible] = useReveal();
  const [writeRef, writeVisible] = useReveal();
  const [webRef, webVisible] = useReveal();
  const [appRef, appVisible] = useReveal();
  const [portfolioRef, portfolioVisible] = useReveal();
  const [pricingRef, pricingVisible] = useReveal();
  const [faqRef, faqVisible] = useReveal();

  return (
    <div className="overflow-x-hidden" style={{ background: '#000820' }}>

      {/* HERO */}
      <section className="relative min-h-screen flex items-center pt-20 pb-16 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-50 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse 70% 60% at 50% 40%, rgba(0,175,193,0.12) 0%, transparent 70%)' }} />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div ref={heroRef} className={`reveal ${heroVisible ? 'visible' : ''}`}>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-7 uppercase tracking-widest"
                style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
                <span className="glow-dot animate-pulse" /> Premium Digital Platform
              </div>
              <h1 className="text-4xl sm:text-5xl xl:text-6xl font-extrabold text-white leading-tight mb-5">
                Grow Smarter with{' '}
                <span className="text-gradient-teal">Gen Z Digital Store</span>
              </h1>
              <p className="text-white/55 text-base sm:text-lg leading-relaxed mb-8 max-w-xl">
                From premium digital tools access to social media management, writing services, animated websites,
                and app development — Gen Z Digital Store helps individuals, creators, and businesses work smarter online.
              </p>
              <div className="flex flex-wrap gap-3 mb-10">
                <Link to="/services"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-full text-sm font-bold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
                  style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
                  <Zap size={15} /> Explore Services
                </Link>
                <Link to="/client/login"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all">
                  <LayoutDashboard size={15} /> Member Dashboard
                </Link>
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-full text-sm font-medium text-green-400 border border-green-500/30 hover:bg-green-500/5 transition-all">
                  <MessageCircle size={15} /> WhatsApp
                </a>
              </div>
              <div className="flex gap-8 pt-8 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <StatBadge n="8+" label="Digital Services" />
                <StatBadge n="100%" label="Secure Access" />
                <StatBadge n="24/7" label="Support" />
              </div>
            </div>

            {/* Dashboard visual */}
            <div className="hidden lg:flex flex-col items-center justify-center relative h-[420px]">
              <div className="relative w-72 rounded-3xl overflow-hidden shadow-2xl"
                style={{ background: 'rgba(0,16,48,0.9)', border: '1px solid rgba(0,175,193,0.2)', boxShadow: '0 0 60px rgba(0,175,193,0.12)' }}>
                <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'rgba(0,175,193,0.12)' }}>
                  <div className="flex gap-1.5">
                    {['#ff5f57','#ffbd2e','#28c840'].map(c=><div key={c} className="w-2.5 h-2.5 rounded-full" style={{background:c}}/>)}
                  </div>
                  <div className="flex-1 h-4 rounded-full mx-2" style={{ background: 'rgba(255,255,255,0.05)' }} />
                </div>
                <div className="p-4 space-y-3">
                  {['AI Tools', 'SEO Suite', 'Design Tools', 'Writing Tools'].map((t,i)=>(
                    <div key={t} className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                      style={{ background: i===0?'rgba(0,175,193,0.15)':'rgba(255,255,255,0.04)', border: i===0?'1px solid rgba(0,175,193,0.3)':'1px solid rgba(255,255,255,0.05)' }}>
                      <div className="w-6 h-6 rounded-lg" style={{ background: `rgba(0,175,193,${0.4-i*0.08})` }} />
                      <span className="text-white text-xs font-medium">{t}</span>
                      <div className="ml-auto w-12 h-1.5 rounded-full" style={{ background: i===0?'rgba(0,175,193,0.5)':'rgba(255,255,255,0.1)' }} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="absolute top-4 -left-4"><FloatingCard icon={Instagram} label="Social Media" color="#e1306c" delay="0s" /></div>
              <div className="absolute top-16 -right-8"><FloatingCard icon={Globe} label="Web Design" color="#00AFC1" delay="0.8s" /></div>
              <div className="absolute bottom-20 -left-8"><FloatingCard icon={PenTool} label="Writing" color="#a78bfa" delay="1.4s" /></div>
              <div className="absolute bottom-8 -right-4"><FloatingCard icon={Smartphone} label="App Dev" color="#4ade80" delay="0.5s" /></div>
            </div>
          </div>
        </div>
      </section>

      {/* SERVICES OVERVIEW */}
      <section className="py-24 px-4">
        <div ref={servicesRef} className={`max-w-7xl mx-auto reveal ${servicesVisible ? 'visible' : ''}`}>
          <div className="text-center mb-14">
            <SectionPill label="Our Services" />
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Everything your digital brand needs</h2>
            <p className="text-white/50 text-base max-w-2xl mx-auto">
              From secure tool access to complete digital service delivery — one platform, eight specialisations.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              { icon: Cpu,        title: 'Digital Tools Access',      desc: 'Admin-managed access to AI, SEO, design and productivity tools.',           to: '/services/digital-tools',           color: 'teal'   },
              { icon: Instagram,  title: 'Social Media Management',   desc: 'Content calendars, post design, Reels strategy, and growth reporting.',      to: '/services/social-media-management', color: 'pink'   },
              { icon: PenTool,    title: 'Writing Services',          desc: 'Website copy, blog posts, business writing, academic support, proofreading.', to: '/services/writing-services',        color: 'purple' },
              { icon: Globe,      title: 'Web Design & Development',  desc: 'Animated landing pages, business websites, e-commerce, and dashboards.',      to: '/services/web-design-development',  color: 'blue'   },
              { icon: Smartphone, title: 'App Development',           desc: 'Web apps, mobile apps, admin panels, booking systems, automation tools.',     to: '/services/app-development',         color: 'green'  },
              { icon: Palette,    title: 'Branding & Design',         desc: 'Brand identity, logos, flyers, social media creatives, presentations.',       to: '/services/branding-design',         color: 'orange' },
              { icon: TrendingUp, title: 'SEO & Digital Growth',      desc: 'Keyword research, on-page SEO, link building, and growth strategy.',          to: '/services/seo-digital-growth',      color: 'cyan'   },
              { icon: Settings,   title: 'Business Automation & CRM', desc: 'Workflow automation, CRM integration, client portals, productivity systems.', to: '/services',                         color: 'indigo' },
            ].map((s,i) => <ServiceCard key={s.title} {...s} delay={i*50} />)}
          </div>
          <div className="text-center mt-10">
            <Link to="/services" className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-sm font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all">
              View All Services <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* WHY CHOOSE US */}
      <section className="py-24 px-4">
        <div ref={whyRef} className={`max-w-7xl mx-auto reveal ${whyVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div>
              <SectionPill label="Why Choose Us" />
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">A platform built for serious digital work</h2>
              <p className="text-white/50 text-base leading-relaxed mb-8">
                We are not a generic template service. Gen Z Digital Store delivers premium quality,
                secure systems, and reliable digital expertise — all tailored to your goals.
              </p>
              <Link to="/about" className="inline-flex items-center gap-2 text-sm font-semibold text-genz-teal hover:gap-3 transition-all">
                Learn more about us <ArrowRight size={14} />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { icon: Shield,     title: 'Secure Tool Access',           desc: 'Admin-controlled assignment with encrypted extension bridge.',            color: '#00AFC1' },
                { icon: Palette,    title: 'Creative Gen Z Branding',      desc: 'Modern, bold visual styles built for creators and digital-first brands.', color: '#a78bfa' },
                { icon: Award,      title: 'Professional Delivery',        desc: 'Every project delivered at a professional standard, on time.',            color: '#4ade80' },
                { icon: Headphones, title: 'Fast Support',                 desc: 'Quick response for tools, services, and technical questions.',            color: '#60a5fa' },
                { icon: Code,       title: 'Scalable Web & App Solutions', desc: 'From MVPs to full-scale platforms — we build what you actually need.',    color: '#fb923c' },
                { icon: Star,       title: 'Affordable Packages',          desc: 'Flexible pricing that scales with you — from individuals to businesses.',  color: '#f472b6' },
              ].map(f => <FeatureCard key={f.title} {...f} accentColor={f.color} />)}
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* HOW IT WORKS */}
      <section className="py-24 px-4">
        <div ref={howRef} className={`max-w-7xl mx-auto reveal ${howVisible ? 'visible' : ''}`}>
          <div className="text-center mb-14">
            <SectionPill label="How It Works" />
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Simple. Secure. Fast.</h2>
            <p className="text-white/50 text-base max-w-xl mx-auto">Two clear paths — tool access for members, services for your business.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="rounded-3xl p-8" style={{ background: 'rgba(0,175,193,0.06)', border: '1px solid rgba(0,175,193,0.18)' }}>
              <div className="flex items-center gap-3 mb-7">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,175,193,0.2)' }}>
                  <Shield size={17} className="text-genz-teal" />
                </div>
                <h3 className="text-white font-bold text-lg">Tool Access Flow</h3>
              </div>
              <div className="space-y-5">
                <StepBadge n="1" label="Admin assigns tools" sub="Your plan includes specific tools assigned by the admin." />
                <StepBadge n="2" label="Client logs in" sub="Access your secure client dashboard with your credentials." />
                <StepBadge n="3" label="Extension connects" sub="The Chrome extension bridges your session to assigned tools." />
                <StepBadge n="4" label="Open tools securely" sub="One-click access — no exposed passwords or shared accounts." />
              </div>
              <Link to="/chrome-extension" className="inline-flex items-center gap-1.5 mt-7 text-sm font-semibold text-genz-teal hover:gap-2.5 transition-all">
                Get the extension <ChevronRight size={14} />
              </Link>
            </div>
            <div className="rounded-3xl p-8" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.18)' }}>
              <div className="flex items-center gap-3 mb-7">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.2)' }}>
                  <Layers size={17} style={{ color: '#a78bfa' }} />
                </div>
                <h3 className="text-white font-bold text-lg">Services Flow</h3>
              </div>
              <div className="space-y-5">
                <StepBadge n="1" label="Choose your service" sub="Browse our services and select what fits your goals." color="#a78bfa" />
                <StepBadge n="2" label="Share requirements" sub="Contact us via WhatsApp or the contact form with your brief." color="#a78bfa" />
                <StepBadge n="3" label="Receive proposal" sub="We review your needs and send a clear plan and quote." color="#a78bfa" />
                <StepBadge n="4" label="Project delivery" sub="We execute, revise, and deliver your project professionally." color="#a78bfa" />
              </div>
              <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 mt-7 text-sm font-semibold hover:gap-2.5 transition-all" style={{ color: '#a78bfa' }}>
                Contact us now <ChevronRight size={14} />
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* SOCIAL MEDIA */}
      <section className="py-24 px-4">
        <div ref={smRef} className={`max-w-7xl mx-auto reveal ${smVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div className="relative rounded-3xl overflow-hidden h-72 flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg,rgba(225,48,108,0.12),rgba(0,8,32,0.9))', border: '1px solid rgba(225,48,108,0.2)' }}>
              <div className="absolute inset-0 hero-grid opacity-30" />
              <div className="relative z-10 grid grid-cols-3 gap-3 p-6">
                {['Post Design','Captions','Reels','Stories','Calendar','Reports'].map((t,i)=>(
                  <div key={t} className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl text-center"
                    style={{ background: 'rgba(225,48,108,0.12)', border: '1px solid rgba(225,48,108,0.2)' }}>
                    <div className="w-8 h-8 rounded-lg" style={{ background: `rgba(225,48,108,${0.3-i*0.03})` }} />
                    <span className="text-white/70 text-xs">{t}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <SectionPill label="Social Media Management" />
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">Your brand, consistently showing up</h2>
              <p className="text-white/50 text-base leading-relaxed mb-7">
                We handle your entire social media presence — from strategy and content creation to scheduling, engagement, and monthly growth reports.
              </p>
              <ul className="space-y-2.5 mb-8">
                {['Content calendar planning','Post design and graphics','Captions and hashtag strategy','Reels and video strategy','Page optimisation','Monthly growth reporting'].map(l=>(
                  <li key={l} className="flex items-center gap-2 text-white/60 text-sm">
                    <CheckCircle size={13} className="text-genz-teal flex-shrink-0" /> {l}
                  </li>
                ))}
              </ul>
              <Link to="/services/social-media-management"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#e1306c,#c13584)' }}>
                Learn more <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* WRITING */}
      <section className="py-24 px-4">
        <div ref={writeRef} className={`max-w-7xl mx-auto reveal ${writeVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div>
              <SectionPill label="Writing Services" />
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">Words that convert, inform, and build authority</h2>
              <p className="text-white/50 text-base leading-relaxed mb-7">
                Professional writing across every format — website copy, blog articles, business documents, and academic support.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-8">
                {['Website Content','Blog Writing','Business Writing','Academic Support','Copywriting','Proofreading'].map(s=>(
                  <div key={s} className="flex items-center gap-2 text-white/60 text-sm px-3 py-2 rounded-xl"
                    style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
                    <CheckCircle size={12} style={{ color: '#a78bfa', flexShrink: 0 }} /> {s}
                  </div>
                ))}
              </div>
              <Link to="/services/writing-services"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#a78bfa,#7c3aed)' }}>
                View writing services <ArrowRight size={14} />
              </Link>
            </div>
            <div className="relative rounded-3xl overflow-hidden h-72 flex flex-col justify-center p-8"
              style={{ background: 'linear-gradient(135deg,rgba(139,92,246,0.12),rgba(0,8,32,0.9))', border: '1px solid rgba(139,92,246,0.2)' }}>
              <div className="space-y-3">
                {[100,85,95,60,90,70,80].map((w,i)=>(
                  <div key={i} className="h-2.5 rounded-full" style={{ width: `${w}%`, background: i===0?'rgba(167,139,250,0.6)':`rgba(167,139,250,${0.15-i*0.01})` }} />
                ))}
              </div>
              <div className="absolute bottom-5 right-5 px-3 py-1.5 rounded-xl text-xs font-semibold"
                style={{ background: 'rgba(139,92,246,0.3)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.4)' }}>
                SEO Optimised
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* WEB DESIGN */}
      <section className="py-24 px-4">
        <div ref={webRef} className={`max-w-7xl mx-auto reveal ${webVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div className="relative rounded-3xl overflow-hidden" style={{ background: 'rgba(0,10,40,0.8)', border: '1px solid rgba(0,175,193,0.2)' }}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'rgba(0,175,193,0.1)' }}>
                <div className="flex gap-1.5">{['#ff5f57','#ffbd2e','#28c840'].map(c=><div key={c} className="w-2.5 h-2.5 rounded-full" style={{background:c}}/>)}</div>
                <div className="flex-1 h-4 rounded-full mx-2 flex items-center px-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <span className="text-white/25 text-xs">genzdigitalstore.com</span>
                </div>
              </div>
              <div className="p-4 space-y-3">
                <div className="h-28 rounded-2xl" style={{ background: 'linear-gradient(135deg,rgba(0,175,193,0.2),rgba(0,8,32,0.8))' }} />
                <div className="grid grid-cols-3 gap-3">
                  {[1,2,3].map(i=><div key={i} className="h-16 rounded-xl" style={{background:'rgba(0,175,193,0.07)',border:'1px solid rgba(0,175,193,0.12)'}}/>)}
                </div>
                <div className="space-y-2">
                  {[100,75,90].map((w,i)=><div key={i} className="h-2 rounded-full" style={{width:`${w}%`,background:'rgba(255,255,255,0.08)'}}/>)}
                </div>
              </div>
            </div>
            <div>
              <SectionPill label="Web Design & Development" />
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">Websites that look premium and perform</h2>
              <p className="text-white/50 text-base leading-relaxed mb-7">
                Animated, responsive websites that represent your brand at its best — from landing pages to complete business platforms.
              </p>
              <div className="space-y-3 mb-8">
                {['Animated landing pages','Business & portfolio websites','E-commerce stores','Admin dashboards','CRM & client portals'].map(s=>(
                  <div key={s} className="flex items-center gap-2.5 text-white/60 text-sm">
                    <div className="w-1.5 h-1.5 rounded-full bg-genz-teal flex-shrink-0" /> {s}
                  </div>
                ))}
              </div>
              <Link to="/services/web-design-development"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-genz-deep-navy transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
                See web services <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* APP DEV */}
      <section className="py-24 px-4">
        <div ref={appRef} className={`max-w-7xl mx-auto reveal ${appVisible ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div>
              <SectionPill label="App Development" />
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">Custom apps, built to scale</h2>
              <p className="text-white/50 text-base leading-relaxed mb-7">
                Whether you need a web app, mobile app, or complex admin system — we build functional, scalable software tailored to your requirements.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-8">
                {['Web Apps','Mobile Apps','Admin Panels','Client Portals','Booking Systems','Automation Tools'].map(s=>(
                  <div key={s} className="flex items-center gap-2 text-white/60 text-sm px-3 py-2 rounded-xl"
                    style={{background:'rgba(74,222,128,0.08)',border:'1px solid rgba(74,222,128,0.15)'}}>
                    <CheckCircle size={12} style={{color:'#4ade80',flexShrink:0}} /> {s}
                  </div>
                ))}
              </div>
              <Link to="/services/app-development"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-genz-deep-navy transition-all hover:opacity-90"
                style={{background:'linear-gradient(135deg,#4ade80,#16a34a)'}}>
                View app services <ArrowRight size={14} />
              </Link>
            </div>
            <div className="flex justify-center">
              <div className="relative w-52 rounded-3xl overflow-hidden shadow-2xl"
                style={{background:'rgba(0,8,32,0.95)',border:'2px solid rgba(74,222,128,0.25)',boxShadow:'0 0 50px rgba(74,222,128,0.1)'}}>
                <div className="h-6 flex items-center justify-center border-b" style={{borderColor:'rgba(74,222,128,0.1)'}}>
                  <div className="w-14 h-1.5 rounded-full" style={{background:'rgba(255,255,255,0.15)'}} />
                </div>
                <div className="p-4 space-y-3">
                  <div className="h-20 rounded-2xl" style={{background:'linear-gradient(135deg,rgba(74,222,128,0.2),rgba(0,8,32,0.8))'}} />
                  <div className="grid grid-cols-2 gap-2">
                    {[1,2,3,4].map(i=><div key={i} className="h-12 rounded-xl" style={{background:'rgba(74,222,128,0.07)',border:'1px solid rgba(74,222,128,0.12)'}}/>)}
                  </div>
                  <div className="h-8 rounded-xl flex items-center justify-center" style={{background:'rgba(74,222,128,0.2)',border:'1px solid rgba(74,222,128,0.3)'}}>
                    <span className="text-green-400 text-xs font-semibold">Launch App</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* PORTFOLIO */}
      <section className="py-24 px-4">
        <div ref={portfolioRef} className={`max-w-7xl mx-auto reveal ${portfolioVisible ? 'visible' : ''}`}>
          <div className="text-center mb-14">
            <SectionPill label="Portfolio" />
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Concept work &amp; live projects</h2>
            <p className="text-white/50 text-base max-w-xl mx-auto">A snapshot of what we build — from UI concepts to live digital platforms.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { label: 'Social Media Brand Kit Concept',     category: 'Branding',   color: '#e1306c' },
              { label: 'Animated SaaS Landing Page Concept', category: 'Web Design', color: '#00AFC1' },
              { label: 'Client Dashboard UI Concept',        category: 'Web App',    color: '#a78bfa' },
              { label: 'Digital Tools Access Platform',      category: 'Web App',    color: '#4ade80' },
              { label: 'Mobile App UI Concept',              category: 'App Dev',    color: '#60a5fa' },
              { label: 'SEO Growth Strategy Deck Concept',   category: 'SEO',        color: '#fb923c' },
            ].map(({label,category,color})=>(
              <div key={label} className="group rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
                style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)'}}>
                <div className="h-44 relative flex items-center justify-center"
                  style={{background:`linear-gradient(135deg,${color}15 0%,rgba(0,8,32,0.8) 100%)`}}>
                  <div className="absolute inset-0" style={{backgroundImage:`linear-gradient(${color}15 1px,transparent 1px),linear-gradient(90deg,${color}15 1px,transparent 1px)`,backgroundSize:'24px 24px'}} />
                  <div className="relative z-10 flex gap-3">
                    {[1,2,3].map(i=><div key={i} className="rounded-xl" style={{width:i===2?52:36,height:i===2?52:36,background:`${color}${i===2?'28':'15'}`,border:`1px solid ${color}40`}}/>)}
                  </div>
                  <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-xs font-semibold" style={{background:`${color}22`,color,border:`1px solid ${color}40`}}>{category}</span>
                </div>
                <div className="p-5">
                  <h3 className="text-white font-semibold text-sm group-hover:text-genz-teal transition-colors">{label}</h3>
                  <p className="text-white/35 text-xs mt-1">Concept — available as a service</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link to="/portfolio" className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-sm font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all">
              View Full Portfolio <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* PRICING */}
      <section className="py-24 px-4">
        <div ref={pricingRef} className={`max-w-7xl mx-auto reveal ${pricingVisible ? 'visible' : ''}`}>
          <div className="text-center mb-14">
            <SectionPill label="Pricing" />
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Transparent packages</h2>
            <p className="text-white/50 text-base max-w-xl mx-auto">Flexible plans for every stage. Not sure what fits? Contact us for a custom quote.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              { tier:'Starter',      price:'Contact', note:'for quote', pop:false, features:['Tool access (up to 3 tools)','Basic social media management','Content calendar','Email support','Monthly report'] },
              { tier:'Professional', price:'Contact', note:'for quote', pop:true,  features:['Tool access (up to 10 tools)','Full social media management','Blog writing (4 posts/mo)','Website or landing page','Priority support','Weekly reports'] },
              { tier:'Business',     price:'Contact', note:'for quote', pop:false, features:['Unlimited tool access','Social media + ad management','Web app or mobile app','Branding package','SEO strategy','Dedicated manager'] },
              { tier:'Custom',       price:"Let's talk", note:'',       pop:false, features:['Fully tailored plan','Mix of any services','API integrations','CRM & automation','Custom SLA','Executive support'] },
            ].map(p=>(
              <div key={p.tier} className="relative rounded-2xl p-6 flex flex-col transition-all duration-300 hover:-translate-y-1"
                style={p.pop?{background:'linear-gradient(160deg,rgba(0,175,193,0.18),rgba(0,20,50,0.9))',border:'1.5px solid rgba(0,175,193,0.5)',boxShadow:'0 0 40px rgba(0,175,193,0.15)'}:{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)'}}>
                {p.pop && <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-bold text-genz-deep-navy" style={{background:'linear-gradient(135deg,#00AFC1,#008EA3)'}}>Popular</div>}
                <div className="mb-4">
                  <span className={`text-xs font-bold uppercase tracking-widest ${p.pop?'text-genz-teal':'text-white/40'}`}>{p.tier}</span>
                  <div className="mt-2 text-white font-bold text-2xl">{p.price}</div>
                  {p.note && <div className="text-white/35 text-xs mt-0.5">{p.note}</div>}
                </div>
                <ul className="space-y-2.5 flex-1 mb-6">
                  {p.features.map(f=>(
                    <li key={f} className="flex items-start gap-2">
                      <CheckCircle size={13} className="flex-shrink-0 mt-0.5" style={{color:p.pop?'#00AFC1':'#4ade80'}} />
                      <span className="text-white/60 text-xs">{f}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/contact" className={`text-center py-2.5 rounded-xl text-xs font-semibold transition-all ${p.pop?'text-genz-deep-navy hover:opacity-90':'text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10'}`}
                  style={p.pop?{background:'linear-gradient(135deg,#00AFC1,#008EA3)'}:{}}>
                  {p.tier==='Custom'?'Get a Custom Quote':'Get Started'}
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center text-white/30 text-xs mt-8">Prices vary by scope. Contact us to discuss your specific needs.</p>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* FAQ */}
      <section className="py-24 px-4">
        <div ref={faqRef} className={`max-w-3xl mx-auto reveal ${faqVisible ? 'visible' : ''}`}>
          <div className="text-center mb-12">
            <SectionPill label="FAQ" />
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Common questions</h2>
          </div>
          <div className="space-y-3">
            {FAQS.map((f,i)=><FAQItem key={i} question={f.q} answer={f.a} defaultOpen={i===0} />)}
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Home;

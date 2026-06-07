import { Link } from 'react-router-dom';
import {
  Zap, ArrowRight, MessageCircle, LayoutDashboard, Shield, Star,
  Globe, Smartphone, Palette, TrendingUp, PenTool,
  CheckCircle, Check, X, ChevronRight, FileText, Search,
  Instagram, Code, BarChart2, Cpu, Headphones, Award, Sparkles, Rocket, Clock,
} from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import { WHATSAPP_URL, APP_LOGIN_URL } from '../components/public/PublicNavbar';

const Eyebrow = ({ label }) => (
  <div className="gz-eyebrow mb-5"><span className="glow-dot" /> {label}</div>
);

/* ───────────────────────── HERO 3D SERVICE HUB ───────────────────────── */
const HUB_TILES = [
  { icon: Cpu,       label: 'Digital Tools',      color: '#06B6D4' },
  { icon: Globe,     label: 'Website Design',     color: '#2563EB' },
  { icon: BarChart2, label: 'Research Support',   color: '#14B8A6' },
  { icon: Palette,   label: 'Graphic Design',     color: '#4F46E5' },
  { icon: Instagram, label: 'Social Media',       color: '#0891B2' },
  { icon: FileText,  label: 'Business Docs',      color: '#0EA5E9' },
];

const ServiceHub = () => (
  <div className="stage-3d relative w-full">
    {/* curved brand ribbons behind the deck */}
    <svg className="absolute -inset-10 w-[120%] h-[120%] ribbon-glow opacity-90 pointer-events-none" viewBox="0 0 520 460" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="rb1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563EB" /><stop offset="0.5" stopColor="#06B6D4" /><stop offset="1" stopColor="#14B8A6" />
        </linearGradient>
        <linearGradient id="rb2" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#06B6D4" /><stop offset="1" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <path d="M-20 120 C 120 40, 260 220, 540 90" stroke="url(#rb1)" strokeWidth="16" strokeLinecap="round" opacity="0.55" />
      <path d="M-20 360 C 160 300, 300 430, 560 320" stroke="url(#rb2)" strokeWidth="12" strokeLinecap="round" opacity="0.4" />
    </svg>

    <div className="deck-3d relative mx-auto" style={{ maxWidth: 460 }}>
      {/* back panel for depth (desktop) */}
      <div className="glass-tint layer-back rounded-[28px] absolute inset-0 hidden lg:block" style={{ transform: 'translateZ(-70px) translate(34px,-18px)' }} />

      {/* main hub panel */}
      <div className="glass layer-mid relative rounded-[28px] p-6 sm:p-7">
        <div className="flex items-center justify-between border-b border-genz-border/70 pb-4 mb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-genz-blue">Digital Service Hub</p>
            <h2 className="mt-1 text-[19px] font-bold text-genz-navy leading-tight">One platform. Every service.</h2>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold text-emerald-600"
            style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.22)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {HUB_TILES.map(({ icon: Icon, label, color }) => (
            <div key={label} className="sheen rounded-2xl px-3.5 py-3.5 flex items-center gap-3 transition-transform duration-300 hover:-translate-y-1"
              style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}>
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                style={{ background: `${color}16`, color, border: `1px solid ${color}2e` }}>
                <Icon size={16} />
              </span>
              <span className="text-[12.5px] font-bold text-genz-navy leading-tight">{label}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-genz-border/70 pt-4 text-center">
          {[['6', 'Services'], ['90+', 'Tools'], ['24/7', 'Access']].map(([n, l]) => (
            <div key={l}>
              <div className="font-heading text-[22px] font-extrabold brand-gradient-text leading-none">{n}</div>
              <div className="text-genz-muted text-[11px] mt-1">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* floating front chips (desktop only) */}
      <div className="glass pop-3 float-a absolute -left-8 top-16 hidden lg:flex items-center gap-2.5 rounded-2xl px-4 py-3 depth-cyan">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
          <Rocket size={16} />
        </span>
        <div>
          <div className="text-[12px] font-bold text-genz-navy leading-none">Project delivered</div>
          <div className="text-[11px] text-genz-muted mt-0.5">on time, every time</div>
        </div>
      </div>
      <div className="glass pop-2 float-b absolute -right-7 bottom-16 hidden lg:flex items-center gap-2.5 rounded-2xl px-4 py-3 depth">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2' }}>
          <Shield size={16} />
        </span>
        <div>
          <div className="text-[12px] font-bold text-genz-navy leading-none">Secure access</div>
          <div className="text-[11px] text-genz-muted mt-0.5">encrypted bridge</div>
        </div>
      </div>
    </div>
  </div>
);

const StatBadge = ({ n, label }) => (
  <div>
    <div className="font-heading text-[30px] font-extrabold text-genz-navy leading-none">{n}</div>
    <div className="text-genz-muted text-[13px] mt-1.5 leading-tight">{label}</div>
  </div>
);

/* ───────────────────────── DATA ───────────────────────── */
const SERVICES = [
  { icon: Cpu, color: '#06B6D4', title: 'Digital Tools',
    desc: 'Admin-managed access to 90+ premium AI, SEO, design and productivity tools through one secure dashboard.',
    bullets: ['One-click secure access', 'No shared passwords', 'Assigned per membership'], to: '/services/digital-tools' },
  { icon: PenTool, color: '#4F46E5', title: 'Academic & Research Support',
    desc: 'Research help, reports, proofreading and professional academic & business writing done to a high standard.',
    bullets: ['Reports & analysis', 'Proofreading & editing', 'Citations & formatting'], to: '/services/writing-services' },
  { icon: Globe, color: '#2563EB', title: 'Website & App Development',
    desc: 'Animated landing pages, business websites, web apps, dashboards and mobile apps — fast and scalable.',
    bullets: ['Responsive & animated', 'Dashboards & portals', 'SEO-ready builds'], to: '/services/web-design-development' },
  { icon: Palette, color: '#0EA5E9', title: 'Graphic Design & Branding',
    desc: 'Complete brand identity — logos, social creatives, flyers, and presentation decks that look premium.',
    bullets: ['Logo & identity', 'Social creatives', 'Pitch decks'], to: '/services/branding-design' },
  { icon: Instagram, color: '#0891B2', title: 'Social Media Marketing',
    desc: 'Full social media management: content calendars, post design, Reels strategy and monthly growth reports.',
    bullets: ['Content calendars', 'Reels & post design', 'Growth reporting'], to: '/services/social-media-management' },
  { icon: FileText, color: '#14B8A6', title: 'Document & Business Services',
    desc: 'Business documents, decks, automation, CRM setup and client-portal solutions tailored to your workflow.',
    bullets: ['Docs & decks', 'Automation & CRM', 'Client portals'], to: '/services' },
];

const TOOL_CATEGORIES = [
  { label: 'AI Writing', n: '10+', icon: PenTool, color: '#4F46E5' },
  { label: 'SEO & Analytics', n: '8+', icon: TrendingUp, color: '#16A34A' },
  { label: 'Design & Creative', n: '12+', icon: Palette, color: '#0EA5E9' },
  { label: 'Productivity', n: '15+', icon: Zap, color: '#D97706' },
  { label: 'Academic Research', n: '6+', icon: BarChart2, color: '#2563EB' },
  { label: 'Social Media', n: '9+', icon: Instagram, color: '#0891B2' },
  { label: 'Business & CRM', n: '7+', icon: Code, color: '#7C3AED' },
  { label: 'Video & Media', n: '5+', icon: Star, color: '#DB2777' },
];

const COMPARE = [
  ['Transparent, scoped pricing', true],
  ['Dedicated account support', true],
  ['Secure premium tool access', true],
  ['Custom web & app development', true],
  ['Branding, design & content', true],
  ['Fast turnaround & revisions', true],
  ['Encrypted, admin-controlled access', true],
];

const STEPS = [
  { icon: Search,   t: 'Discover',  s: 'We learn your goals, brand and exact requirements.' },
  { icon: FileText, t: 'Proposal',  s: 'You get a clear plan, scope and quote within 24 hours.' },
  { icon: Palette,  t: 'Design',    s: 'We craft premium concepts aligned to your brand.' },
  { icon: Rocket,   t: 'Deliver',   s: 'We build, revise and ship — on time, polished.' },
  { icon: TrendingUp, t: 'Grow',    s: 'Ongoing support, tools and optimisation as you scale.' },
];

const FAQS = [
  { q: 'What is Gen Z Digital Store?', a: 'Gen Z Digital Store is a premium digital platform offering secure access to professional tools, plus creative services including social media management, writing, web design, app development, branding, and SEO.' },
  { q: 'Do you only provide tools?', a: 'No. While we offer admin-managed access to premium digital tools, we also deliver a full range of digital services — from content creation and web design to mobile apps and business automation.' },
  { q: 'How does tool access work?', a: 'An admin assigns specific tools to your account. You log in to your client dashboard, and the Chrome extension securely connects you to your assigned tools in one click — no passwords needed.' },
  { q: 'Is the Chrome extension required?', a: 'The extension is required for secure tool access. It communicates with your session to open assigned tools safely. For our other digital services, no extension is needed.' },
  { q: 'Can you build a website or app?', a: 'Absolutely. We build animated landing pages, business websites, web apps, mobile apps, admin dashboards, CRM systems, client portals, and custom automation tools.' },
  { q: 'How do I order a service?', a: 'Contact us on WhatsApp or fill out our contact form. We will understand your requirements, send a proposal, and get started after confirmation.' },
];

/* ───────────────────────── REALISTIC MOCKUPS ───────────────────────── */
const BrowserMock = ({ accent }) => (
  <div className="w-full h-full p-3">
    <div className="rounded-xl overflow-hidden h-full border border-genz-border bg-white shadow-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-genz-border bg-genz-bg">
        {['#ef4444', '#f59e0b', '#22c55e'].map(c => <span key={c} className="w-2 h-2 rounded-full" style={{ background: c }} />)}
        <span className="ml-2 h-3 flex-1 rounded-full bg-white border border-genz-border" />
      </div>
      <div className="p-3 space-y-2">
        <div className="h-14 rounded-lg" style={{ background: `linear-gradient(135deg, ${accent}26, ${accent}0d)` }} />
        <div className="grid grid-cols-3 gap-2">
          {[0,1,2].map(i => <div key={i} className="h-8 rounded-md bg-genz-bg border border-genz-border" />)}
        </div>
        <div className="h-2 w-3/4 rounded-full bg-genz-border" />
        <div className="h-2 w-1/2 rounded-full bg-genz-border" />
      </div>
    </div>
  </div>
);
const PhoneMock = ({ accent }) => (
  <div className="w-full h-full flex items-center justify-center">
    <div className="w-24 rounded-[18px] border-[3px] border-genz-navy/80 bg-white overflow-hidden shadow-md">
      <div className="h-4 flex items-center justify-center"><span className="w-8 h-1 rounded-full bg-genz-navy/30" /></div>
      <div className="px-2 pb-2 space-y-1.5">
        <div className="h-12 rounded-lg" style={{ background: `linear-gradient(135deg, ${accent}30, ${accent}0d)` }} />
        <div className="grid grid-cols-2 gap-1.5">{[0,1,2,3].map(i => <div key={i} className="h-6 rounded-md bg-genz-bg border border-genz-border" />)}</div>
        <div className="h-5 rounded-md" style={{ background: accent, opacity: 0.85 }} />
      </div>
    </div>
  </div>
);
const DashMock = ({ accent }) => (
  <div className="w-full h-full p-3">
    <div className="flex gap-2 h-full">
      <div className="w-8 rounded-lg bg-genz-navy/90 flex flex-col items-center gap-1.5 py-2">
        {[0,1,2].map(i => <span key={i} className="w-3 h-3 rounded-md" style={{ background: i===0 ? accent : 'rgba(255,255,255,0.25)' }} />)}
      </div>
      <div className="flex-1 space-y-2">
        <div className="grid grid-cols-3 gap-2">{[0,1,2].map(i => <div key={i} className="h-9 rounded-lg bg-white border border-genz-border" />)}</div>
        <div className="h-16 rounded-lg bg-white border border-genz-border p-2 flex items-end gap-1">
          {[5,8,4,9,6,7].map((h,i) => <span key={i} className="flex-1 rounded-sm" style={{ height: `${h*8}%`, background: accent, opacity: 0.7 }} />)}
        </div>
      </div>
    </div>
  </div>
);
const SocialMock = ({ accent }) => (
  <div className="w-full h-full p-3 grid grid-cols-3 grid-rows-2 gap-2">
    {[0,1,2,3,4,5].map(i => (
      <div key={i} className="rounded-lg border border-genz-border" style={{ background: `linear-gradient(135deg, ${accent}${i%2?'22':'12'}, #ffffff)` }} />
    ))}
  </div>
);

const PORTFOLIO = [
  { label: 'Animated SaaS Landing Page', cat: 'Web Design', accent: '#06B6D4', Mock: BrowserMock },
  { label: 'Member Dashboard UI', cat: 'Web App', accent: '#4F46E5', Mock: DashMock },
  { label: 'Mobile App Concept', cat: 'App Dev', accent: '#2563EB', Mock: PhoneMock },
  { label: 'Social Media Brand Kit', cat: 'Branding', accent: '#DB2777', Mock: SocialMock },
  { label: 'Business Website', cat: 'Web Design', accent: '#0EA5E9', Mock: BrowserMock },
  { label: 'Admin Analytics Panel', cat: 'Web App', accent: '#16A34A', Mock: DashMock },
];

/* ───────────────────────── PAGE ───────────────────────── */
const Home = () => {
  const [heroRef, heroV] = useReveal(0.05);
  const [trustRef, trustV] = useReveal();
  const [servRef, servV] = useReveal();
  const [toolsRef, toolsV] = useReveal();
  const [portRef, portV] = useReveal();
  const [cmpRef, cmpV] = useReveal();
  const [stepRef, stepV] = useReveal();
  const [faqRef, faqV] = useReveal();

  return (
    <div className="text-genz-navy overflow-x-hidden" style={{ background: 'var(--brand-soft)' }}>

      {/* ── HERO ── */}
      <section className="relative pt-28 pb-20 lg:pt-32 lg:pb-28">
        <div className="aurora" />
        <div className="dot-grid" />
        <div className="gz-container relative w-full">
          <div className="grid lg:grid-cols-[1.02fr_0.98fr] gap-12 xl:gap-20 items-center">
            <div ref={heroRef} className={`reveal ${heroV ? 'visible' : ''}`}>
              <Eyebrow label="Premium Digital Platform" />
              <h1 className="type-display text-genz-navy mb-5">
                Grow Smarter with{' '}<span className="brand-gradient-text">Gen Z Digital Store</span>
              </h1>
              <p className="type-body-large text-genz-muted mb-9 max-w-xl">
                Premium digital tools, websites, research support, branding, social media designs,
                documents and presentations — everything you need from one trusted digital platform.
              </p>
              <div className="flex flex-wrap gap-3 mb-12">
                <Link to="/services" className="btn-grad flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
                  <Zap size={16} /> Explore Services
                </Link>
                <a href={APP_LOGIN_URL} className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-navy bg-white border border-genz-border hover:border-genz-blue/40 hover:text-genz-blue transition-all depth">
                  <LayoutDashboard size={16} /> Member Dashboard
                </a>
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-emerald-600 bg-white border border-emerald-200 hover:bg-emerald-50 transition-all">
                  <MessageCircle size={16} /> WhatsApp
                </a>
              </div>
              <div className="flex flex-wrap gap-x-10 gap-y-5 pt-8 border-t border-genz-border">
                <StatBadge n="6" label="Core Service Lines" />
                <StatBadge n="90+" label="Premium Tools" />
                <StatBadge n="24/7" label="Member Access" />
              </div>
            </div>

            <div className={`reveal delay-150 ${heroV ? 'visible' : ''}`}>
              <ServiceHub />
            </div>
          </div>
        </div>
      </section>

      {/* ── TRUST BAR ── */}
      <section className="border-y border-genz-border bg-white/70 backdrop-blur">
        <div ref={trustRef} className={`gz-container py-6 reveal ${trustV ? 'visible' : ''}`}>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-genz-muted">
            <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-genz-navy/70">Built for serious digital work</span>
            {[[Shield, 'Secure by design'], [Award, 'Professional delivery'], [Headphones, 'Fast support'], [Sparkles, 'Premium quality'], [Clock, 'On-time, always']].map(([Icon, t]) => (
              <span key={t} className="inline-flex items-center gap-2 text-[13.5px] font-semibold">
                <Icon size={15} className="text-genz-blue" /> {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── SERVICES (rich, with bullets) ── */}
      <section className="gz-section px-5">
        <div ref={servRef} className={`gz-container reveal ${servV ? 'visible' : ''}`}>
          <div className="text-center max-w-2xl mx-auto mb-14">
            <Eyebrow label="Our Services" />
            <h2 className="type-section-title text-genz-navy mb-4">Everything your digital brand needs</h2>
            <p className="text-genz-muted text-[16px]">Six core service lines — delivered to a premium standard from one trusted platform.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {SERVICES.map(({ icon: Icon, color, title, desc, bullets, to }, i) => (
              <Link key={title} to={to} className="gz-card sheen group flex flex-col p-7" style={{ transitionDelay: `${i * 50}ms` }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-105"
                  style={{ background: `${color}14`, border: `1px solid ${color}26`, color }}>
                  <Icon size={22} />
                </div>
                <h3 className="text-genz-navy font-bold text-[20px] leading-tight mb-2 group-hover:text-genz-blue transition-colors">{title}</h3>
                <p className="text-genz-muted text-[14.5px] leading-relaxed mb-4">{desc}</p>
                <ul className="space-y-2 mb-5 flex-1">
                  {bullets.map(b => (
                    <li key={b} className="flex items-center gap-2 text-[13.5px] text-genz-navy/80">
                      <CheckCircle size={14} style={{ color }} className="flex-shrink-0" /> {b}
                    </li>
                  ))}
                </ul>
                <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold group-hover:gap-2.5 transition-all" style={{ color }}>
                  Learn more <ArrowRight size={14} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── TOOLS MARKETPLACE ── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={toolsRef} className={`gz-container reveal ${toolsV ? 'visible' : ''}`}>
          <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-12 items-center">
            <div>
              <Eyebrow label="Tools Marketplace" />
              <h2 className="type-section-title text-genz-navy mb-4 leading-tight">90+ premium tools, one secure dashboard</h2>
              <p className="text-genz-muted text-[16px] leading-relaxed mb-7">
                Members get admin-assigned access to professional tools across every category — opened securely
                through our Chrome extension with no shared passwords.
              </p>
              <div className="flex flex-wrap gap-3">
                <a href={APP_LOGIN_URL} className="btn-grad flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
                  <LayoutDashboard size={16} /> Open Member Dashboard
                </a>
                <Link to="/services/digital-tools" className="flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
                  How it works <ArrowRight size={15} />
                </Link>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {TOOL_CATEGORIES.map(({ label, n, icon: Icon, color }) => (
                <div key={label} className="gz-card sheen p-4 text-center">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl mb-2.5" style={{ background: `${color}14`, color, border: `1px solid ${color}26` }}>
                    <Icon size={18} />
                  </span>
                  <div className="font-heading text-[18px] font-extrabold text-genz-navy leading-none">{n}</div>
                  <div className="text-genz-muted text-[12px] mt-1 leading-tight">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── PORTFOLIO (realistic mockups) ── */}
      <section className="gz-section px-5">
        <div ref={portRef} className={`gz-container reveal ${portV ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="Portfolio" />
            <h2 className="type-section-title text-genz-navy mb-4">Work that looks the part</h2>
            <p className="text-genz-muted text-[16px]">A snapshot of what we design and build — from websites to dashboards and brand kits.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {PORTFOLIO.map(({ label, cat, accent, Mock }) => (
              <div key={label} className="gz-card group overflow-hidden">
                <div className="relative h-44" style={{ background: `linear-gradient(135deg, ${accent}10, #ffffff)` }}>
                  <Mock accent={accent} />
                  <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[11px] font-semibold" style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}38` }}>{cat}</span>
                </div>
                <div className="p-6 border-t border-genz-border">
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

      {/* ── COMPARISON ── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={cmpRef} className={`gz-container reveal ${cmpV ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-12">
            <Eyebrow label="Why Gen Z Digital Store" />
            <h2 className="type-section-title text-genz-navy mb-4">A clear step above generic providers</h2>
          </div>
          <div className="gz-card max-w-3xl mx-auto overflow-hidden p-0">
            <div className="grid grid-cols-[1fr_auto_auto]">
              <div className="px-5 py-4 text-[13px] font-bold uppercase tracking-wider text-genz-muted">What you get</div>
              <div className="px-5 py-4 text-center text-[13px] font-bold text-genz-muted w-28">Generic</div>
              <div className="px-5 py-4 text-center text-[13px] font-bold text-genz-blue w-32 bg-genz-blue/[0.05]">Gen Z</div>
              {COMPARE.map(([row], i) => (
                <div key={row} className="contents">
                  <div className={`px-5 py-3.5 text-[14px] text-genz-navy/85 border-t border-genz-border ${i % 2 ? 'bg-genz-bg/40' : ''}`}>{row}</div>
                  <div className={`px-5 py-3.5 flex justify-center border-t border-genz-border ${i % 2 ? 'bg-genz-bg/40' : ''}`}>
                    <X size={17} className="text-genz-muted/50" />
                  </div>
                  <div className="px-5 py-3.5 flex justify-center border-t border-genz-border bg-genz-blue/[0.05]">
                    <Check size={17} className="text-genz-blue" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── PROCESS TIMELINE ── */}
      <section className="gz-section px-5">
        <div ref={stepRef} className={`gz-container reveal ${stepV ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="How It Works" />
            <h2 className="type-section-title text-genz-navy mb-4">From idea to launch in five steps</h2>
          </div>
          <div className="relative grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="hidden lg:block absolute top-7 left-[10%] right-[10%] h-0.5 tl-line rounded-full" />
            {STEPS.map(({ icon: Icon, t, s }, i) => (
              <div key={t} className="relative text-center">
                <div className="mx-auto mb-4 w-14 h-14 rounded-2xl flex items-center justify-center text-white relative z-10 depth" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  <Icon size={22} />
                  <span className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white border border-genz-border text-[11px] font-bold text-genz-blue flex items-center justify-center">{i + 1}</span>
                </div>
                <h3 className="text-genz-navy font-bold text-[16px] mb-1">{t}</h3>
                <p className="text-genz-muted text-[13px] leading-relaxed">{s}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={faqRef} className={`mx-auto max-w-3xl reveal ${faqV ? 'visible' : ''}`}>
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

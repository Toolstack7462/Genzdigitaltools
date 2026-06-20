import { Link } from 'react-router-dom';
import { motion, MotionConfig } from 'framer-motion';
import {
  Zap, ArrowRight, MessageCircle, LayoutDashboard, Shield, Star,
  Globe, Smartphone, Palette, TrendingUp, PenTool,
  CheckCircle, Check, X, FileText, Search,
  Instagram, Code, BarChart2, Cpu, Headphones, Award, Sparkles, Rocket, Clock,
} from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import ShowcaseCard from '../components/public/showcase/ShowcaseCard';
import SHOWCASE_ITEMS from '../components/public/showcase/showcaseItems';
import { WHATSAPP_URL, APP_LOGIN_URL, APP_SIGNUP_URL } from '../components/public/PublicNavbar';

const Eyebrow = ({ label, light }) => (
  <div className={`gz-eyebrow mb-5 ${light ? 'gz-eyebrow-light' : ''}`}><span className="glow-dot" /> {label}</div>
);

/* shared motion — exponential ease-out, no bounce; reduced-motion handled by
   <MotionConfig reducedMotion="user"> at the call site (transforms collapse,
   opacity remains). Lightweight: transform + opacity only. */
const EASE_OUT = [0.16, 1, 0.3, 1];
const mStagger = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } } };
const mFadeUp = { hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT } } };
const mRowIn = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } } };

/* curved logo-inspired brand ribbons (reused) */
const Ribbons = ({ className = '' }) => (
  <svg className={className} viewBox="0 0 560 480" fill="none" aria-hidden="true" preserveAspectRatio="none">
    <defs>
      <linearGradient id="rbA" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2563EB" /><stop offset="0.5" stopColor="#06B6D4" /><stop offset="1" stopColor="#14B8A6" />
      </linearGradient>
      <linearGradient id="rbB" x1="1" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#06B6D4" /><stop offset="1" stopColor="#2563EB" />
      </linearGradient>
    </defs>
    <path d="M-40 130 C 130 30, 300 230, 600 80" stroke="url(#rbA)" strokeWidth="26" strokeLinecap="round" opacity="0.7" />
    <path d="M-40 250 C 160 180, 320 330, 600 220" stroke="url(#rbB)" strokeWidth="16" strokeLinecap="round" opacity="0.5" />
    <path d="M-40 380 C 150 330, 340 450, 600 360" stroke="url(#rbA)" strokeWidth="12" strokeLinecap="round" opacity="0.35" />
  </svg>
);

/* ───────────────────────── HERO 3D SERVICE HUB ───────────────────────── */
const HUB_TILES = [
  { icon: Cpu,       label: 'Digital Tools',  color: '#06B6D4' },
  { icon: Globe,     label: 'Website Design', color: '#2563EB' },
  { icon: BarChart2, label: 'Research',       color: '#14B8A6' },
  { icon: Palette,   label: 'Graphic Design', color: '#4F46E5' },
  { icon: Instagram, label: 'Social Media',   color: '#0891B2' },
  { icon: FileText,  label: 'Business Docs',  color: '#0EA5E9' },
];

const ServiceHub = () => (
  <div className="stage-3d relative w-full">
    <Ribbons className="absolute -inset-x-16 -inset-y-10 w-[135%] h-[130%] ribbon-bold opacity-95 pointer-events-none" />

    <div className="deck-3d relative mx-auto" style={{ maxWidth: 470 }}>
      {/* stacked back panels for depth (desktop) */}
      <div className="glass-tint rounded-[26px] absolute inset-0 hidden lg:block" style={{ transform: 'translateZ(-110px) translate(54px,-30px)', opacity: 0.65 }} />
      <div className="glass-tint rounded-[26px] absolute inset-0 hidden lg:block" style={{ transform: 'translateZ(-60px) translate(28px,-15px)' }} />

      {/* main hub panel — product-style */}
      <div className="glass relative rounded-[26px] overflow-hidden">
        {/* window bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-genz-border/70">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-3 text-[11px] font-semibold text-genz-muted">app.genzdigitalstore.com</span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold text-emerald-600"
            style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.22)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
          </span>
        </div>

        <div className="p-5 sm:p-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-genz-blue">Digital Service Hub</p>
          <h2 className="mt-1 mb-4 text-[19px] font-bold text-genz-navy leading-tight">One platform. Every service.</h2>

          <div className="grid grid-cols-2 gap-3">
            {HUB_TILES.map(({ icon: Icon, label, color }) => (
              <div key={label} className="sheen rounded-2xl px-3.5 py-3 flex items-center gap-3 transition-transform duration-300 hover:-translate-y-1"
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
      </div>

      {/* floating front chips (desktop only) — positioned outside hub header area to avoid clipping */}
      <div className="glass pop-3 float-a absolute -left-12 top-44 hidden lg:flex items-center gap-2.5 rounded-2xl px-4 py-3 depth-cyan">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: 'var(--gradient-cta)' }}>
          <Rocket size={16} />
        </span>
        <div>
          <div className="text-[12px] font-bold text-genz-navy leading-none">Project delivered</div>
          <div className="text-[11px] text-genz-muted mt-0.5">on time, every time</div>
        </div>
      </div>
      <div className="glass pop-2 float-b absolute -right-8 bottom-12 hidden lg:flex items-center gap-2.5 rounded-2xl px-4 py-3 depth">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2' }}>
          <Shield size={16} />
        </span>
        <div>
          <div className="text-[12px] font-bold text-genz-navy leading-none">Secure access</div>
          <div className="text-[11px] text-genz-muted mt-0.5">private &amp; protected</div>
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
const FEATURED = {
  icon: Cpu, color: '#06B6D4', title: 'Premium Digital Tools', badge: 'Most Popular',
  desc: 'Members-only access to 90+ professional AI, SEO, design and productivity tools — all opened securely from one premium dashboard with a single click.',
  bullets: ['One-click secure access', 'Assigned per membership', 'Members-only premium tools', '90+ tools across 8 categories'],
  to: '/services/digital-tools',
};

const SERVICES = [
  { icon: Globe, color: '#2563EB', title: 'Website & App Development', badge: 'Popular',
    desc: 'Animated landing pages, business sites, web apps, dashboards and mobile apps.',
    bullets: ['Responsive & animated', 'Dashboards & portals', 'SEO-ready builds'], to: '/services/web-design-development' },
  { icon: Palette, color: '#4F46E5', title: 'Graphic Design & Branding',
    desc: 'Complete brand identity — logos, social creatives, flyers and pitch decks.',
    bullets: ['Logo & identity', 'Social creatives', 'Presentation decks'], to: '/services/branding-design' },
  { icon: Instagram, color: '#0891B2', title: 'Social Media Marketing', badge: 'New',
    desc: 'Content calendars, post design, Reels strategy and monthly growth reports.',
    bullets: ['Content calendars', 'Reels & post design', 'Growth reporting'], to: '/services/social-media-management' },
  { icon: PenTool, color: '#7C3AED', title: 'Academic & Research Support',
    desc: 'Research help, reports, proofreading and professional business writing.',
    bullets: ['Reports & analysis', 'Proofreading', 'Citations & formatting'], to: '/services/writing-services' },
  { icon: FileText, color: '#14B8A6', title: 'Document & Business Services',
    desc: 'Documents, decks, automation, CRM setup and client-portal solutions.',
    bullets: ['Docs & decks', 'Automation & CRM', 'Client portals'], to: '/services' },
];

const TOOL_CATEGORIES = [
  { label: 'AI Writing', n: '10+', icon: PenTool, color: '#67E8F9' },
  { label: 'SEO & Analytics', n: '8+', icon: TrendingUp, color: '#86EFAC' },
  { label: 'Design & Creative', n: '12+', icon: Palette, color: '#7DD3FC' },
  { label: 'Productivity', n: '15+', icon: Zap, color: '#FCD34D' },
  { label: 'Academic Research', n: '6+', icon: BarChart2, color: '#93C5FD' },
  { label: 'Social Media', n: '9+', icon: Instagram, color: '#67E8F9' },
  { label: 'Business & CRM', n: '7+', icon: Code, color: '#C4B5FD' },
  { label: 'Video & Media', n: '5+', icon: Star, color: '#F9A8D4' },
];

const COMPARE = [
  'Transparent, scoped pricing',
  'Dedicated account support',
  'Secure premium tool access',
  'Custom web & app development',
  'Branding, design & content',
  'Fast turnaround & revisions',
  'Secure, members-only access',
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
  { q: 'How does tool access work?', a: 'Your assigned tools are added to your account by our team. You simply log in to your member dashboard and open any assigned tool in one click — securely, with nothing to set up.' },
  { q: 'Is my access secure?', a: 'Yes. Access is members-only and fully managed by our team, so your premium tools open safely every time. Our other digital services are delivered directly by our team.' },
  { q: 'Can you build a website or app?', a: 'Absolutely. We build animated landing pages, business websites, web apps, mobile apps, admin dashboards, CRM systems, client portals, and custom automation tools.' },
  { q: 'How do I order a service?', a: 'Contact us on WhatsApp or fill out our contact form. We will understand your requirements, send a proposal, and get started after confirmation.' },
];

/* small reusable service-card (bento grid) */
const ServiceCard = ({ icon: Icon, color, title, desc, bullets, to, badge, delay }) => (
  <Link to={to} className="gz-card gz-card-accent sheen group flex flex-col p-6" style={{ transitionDelay: `${delay}ms` }}>
    <div className="flex items-start justify-between mb-4">
      <span className="w-12 h-12 rounded-2xl flex items-center justify-center transition-transform duration-300 group-hover:scale-105"
        style={{ background: `${color}14`, border: `1px solid ${color}26`, color }}>
        <Icon size={22} />
      </span>
      {badge && <span className="ds-badge ds-badge-info">{badge}</span>}
    </div>
    <h3 className="text-genz-navy font-bold text-[18px] leading-tight mb-2 group-hover:text-genz-blue transition-colors">{title}</h3>
    <p className="text-genz-muted text-[14px] leading-relaxed mb-4">{desc}</p>
    <ul className="space-y-1.5 mb-5 flex-1">
      {bullets.map(b => (
        <li key={b} className="flex items-center gap-2 text-[13px] text-genz-navy/80">
          <CheckCircle size={13} style={{ color }} className="flex-shrink-0" /> {b}
        </li>
      ))}
    </ul>
    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold group-hover:gap-2.5 transition-all" style={{ color }}>
      Learn more <ArrowRight size={14} />
    </span>
  </Link>
);

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
      <section className="hero-wash relative pt-28 pb-20 lg:pt-32 lg:pb-28 overflow-hidden">
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
              {/* Primary actions — one clear CTA (Get Started → signup), one subordinate */}
              <div className="flex flex-col sm:flex-row flex-wrap gap-3">
                <a
                  href={APP_SIGNUP_URL}
                  data-testid="hero-get-started"
                  className="btn-grad flex items-center justify-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-blue/50 focus-visible:ring-offset-2"
                >
                  Get Started Free <ArrowRight size={16} />
                </a>
                <Link
                  to="/services"
                  className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-navy bg-white border border-genz-border hover:border-genz-blue/40 hover:text-genz-blue hover:-translate-y-0.5 transition-all duration-200 depth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-blue/40"
                >
                  <Zap size={16} /> Explore Services
                </Link>
              </div>
              {/* Trust microcopy */}
              <p className="mt-4 flex items-center gap-2 text-[13px] text-genz-muted">
                <CheckCircle size={15} className="text-genz-teal flex-shrink-0" />
                No setup fees · Instant member access · Cancel anytime
              </p>
              {/* Subordinate actions */}
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 mb-12 text-[14px] font-semibold">
                <a href={APP_LOGIN_URL} className="inline-flex items-center gap-1.5 text-genz-navy/80 hover:text-genz-blue transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-blue/40 rounded-md">
                  <LayoutDashboard size={15} /> Member Login
                </a>
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-emerald-600 hover:text-emerald-700 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 rounded-md">
                  <MessageCircle size={15} /> Chat on WhatsApp
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

      {/* ── SERVICES (featured + bento) ── */}
      <section id="services" className="gz-section px-5 scroll-mt-24">
        <div ref={servRef} className={`gz-container reveal ${servV ? 'visible' : ''}`}>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <Eyebrow label="Our Services" />
            <h2 className="type-section-title text-genz-navy mb-4">Everything your digital brand needs</h2>
            <p className="text-genz-muted text-[16px]">Six core service lines — delivered to a premium standard from one trusted platform.</p>
          </div>

          {/* Featured spotlight */}
          <div className="grad-border rounded-[24px] mb-6 overflow-hidden">
            <div className="grid md:grid-cols-[1.1fr_0.9fr] gap-0 rounded-[24px] overflow-hidden" style={{ background: 'var(--gradient-card), #ffffff' }}>
              <div className="p-7 sm:p-9">
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-white" style={{ background: 'var(--gradient-cta)' }}>
                    <FEATURED.icon size={22} />
                  </span>
                  <span className="ds-badge ds-badge-teal"><Star size={11} /> {FEATURED.badge}</span>
                </div>
                <h3 className="font-heading text-[24px] sm:text-[26px] font-extrabold text-genz-navy mb-2.5">{FEATURED.title}</h3>
                <p className="text-genz-muted text-[15px] leading-relaxed mb-5 max-w-md">{FEATURED.desc}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-7">
                  {FEATURED.bullets.map(b => (
                    <div key={b} className="flex items-center gap-2 text-[13.5px] text-genz-navy/85">
                      <CheckCircle size={14} className="text-genz-blue flex-shrink-0" /> {b}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Link to={FEATURED.to} className="btn-grad inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-bold">
                    Explore Digital Tools <ArrowRight size={15} />
                  </Link>
                  <a href={APP_LOGIN_URL} className="inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
                    <LayoutDashboard size={15} /> Member Dashboard
                  </a>
                </div>
              </div>
              {/* mini hub visual */}
              <div className="relative hidden md:block p-7" style={{ background: 'linear-gradient(160deg, rgba(37,99,235,0.06), rgba(6,182,212,0.05))' }}>
                <Ribbons className="absolute inset-0 w-full h-full opacity-30 pointer-events-none" />
                <div className="relative grid grid-cols-2 gap-3 h-full content-center">
                  {HUB_TILES.slice(0, 6).map(({ icon: Icon, label, color }) => (
                    <div key={label} className="glass rounded-2xl px-3 py-3 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${color}16`, color, border: `1px solid ${color}2e` }}>
                        <Icon size={15} />
                      </span>
                      <span className="text-[12px] font-bold text-genz-navy leading-tight">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* bento grid of the other 5 services */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {SERVICES.map((s, i) => <ServiceCard key={s.title} {...s} delay={i * 50} />)}
            {/* CTA tile to fill the grid */}
            <Link to="/services" className="gz-card group flex flex-col items-start justify-center p-6 text-left"
              style={{ background: 'var(--gradient-navy)' }}>
              <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-white mb-4" style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.16)' }}>
                <ArrowRight size={22} />
              </span>
              <h3 className="text-white font-bold text-[18px] mb-2">See all services</h3>
              <p className="text-white/65 text-[14px] leading-relaxed mb-4">Explore the full range and find the right fit for your brand.</p>
              <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-genz-cyan group-hover:gap-2.5 transition-all">
                View all <ArrowRight size={14} />
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── TOOLS MARKETPLACE (dark band) ── */}
      <section className="gz-section px-5">
        <div ref={toolsRef} className={`gz-container reveal ${toolsV ? 'visible' : ''}`}>
          <div className="gz-panel-dark relative overflow-hidden p-7 sm:p-10 rounded-[28px]">
            <Ribbons className="absolute -inset-x-10 -top-10 w-[120%] h-[80%] opacity-25 pointer-events-none" />
            <div className="relative grid lg:grid-cols-[0.95fr_1.05fr] gap-10 items-center">
              <div>
                <Eyebrow label="Tools Marketplace" light />
                <h2 className="type-section-title text-white mb-4 leading-tight">90+ premium tools, one secure dashboard</h2>
                <p className="text-white/70 text-[16px] leading-relaxed mb-7">
                  Members get access to professional tools across every category — opened
                  securely from your dashboard in one click.
                </p>
                <div className="flex flex-wrap gap-3">
                  <a href={APP_LOGIN_URL} className="btn-grad inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
                    <LayoutDashboard size={16} /> Open Member Dashboard
                  </a>
                  <Link to="/services/digital-tools" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-white border border-white/25 hover:bg-white/10 transition-all">
                    How it works <ArrowRight size={15} />
                  </Link>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {TOOL_CATEGORIES.map(({ label, n, icon: Icon, color }) => (
                  <div key={label} className="glass-on-dark rounded-2xl p-4 text-center transition-transform duration-300 hover:-translate-y-1">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl mb-2.5" style={{ background: `${color}1f`, color, border: `1px solid ${color}3a` }}>
                      <Icon size={18} />
                    </span>
                    <div className="font-heading text-[18px] font-extrabold text-white leading-none">{n}</div>
                    <div className="text-white/60 text-[11.5px] mt-1 leading-tight">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURED WORK SHOWCASE ── */}
      <section id="portfolio" className="gz-section px-5 scroll-mt-24" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={portRef} className={`gz-container reveal ${portV ? 'visible' : ''}`}>
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-12">
            <div className="max-w-xl">
              <Eyebrow label="Featured Work" />
              <h2 className="type-section-title text-genz-navy mb-4">Premium digital case studies</h2>
              <p className="text-genz-muted text-[16px]">
                A look at the dashboards, platforms, brand kits and SaaS experiences we build —
                each piece crafted with the same attention you&apos;d expect from a world-class product team.
              </p>
            </div>
            <Link to="/portfolio" className="inline-flex items-center gap-2 text-[14px] font-semibold text-genz-blue hover:gap-3 transition-all whitespace-nowrap">
              View full showcase <ArrowRight size={15} />
            </Link>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-2 gap-7">
            {SHOWCASE_ITEMS.slice(0, 4).map((item) => (
              <ShowcaseCard key={item.id} {...item} ctaTo="/portfolio" />
            ))}
          </div>
          <div className="text-center mt-12">
            <Link to="/portfolio" className="btn-grad inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-bold">
              Explore Full Portfolio <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── COMPARISON — premium "versus" (generic vs. Gen Z) ── */}
      <section className="gz-section px-5">
        <div ref={cmpRef} className="gz-container">
          <div className="text-center max-w-xl mx-auto mb-12">
            <Eyebrow label="Why Gen Z Digital Store" />
            <h2 className="type-section-title text-genz-navy mb-4" style={{ textWrap: 'balance' }}>A clear step above generic providers</h2>
            <p className="text-genz-muted text-[15px] leading-relaxed">The same goals — handled with premium care, security and real support, not pieced together from disconnected tools.</p>
          </div>

          <MotionConfig reducedMotion="user">
            <motion.div
              className="grid gap-5 md:grid-cols-2 max-w-4xl mx-auto items-stretch"
              variants={mStagger} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.25 }}
            >
              {/* Generic providers — deliberately understated */}
              <motion.div variants={mFadeUp}
                className="rounded-3xl border border-genz-border bg-white/70 p-7 sm:p-8 backdrop-blur-[2px]">
                <div className="flex items-center gap-2.5 mb-6">
                  <span className="w-9 h-9 rounded-xl grid place-items-center bg-genz-bg text-genz-muted"><X size={17} /></span>
                  <h3 className="text-[15px] font-bold text-genz-muted">Generic providers</h3>
                </div>
                <ul className="space-y-3.5">
                  {COMPARE.map((row) => (
                    <li key={row} className="flex items-start gap-3 text-[14.5px] text-genz-navy/55 leading-snug">
                      <X size={16} className="mt-0.5 flex-shrink-0 text-genz-muted/50" />
                      <span>{row}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>

              {/* Gen Z Digital Store — elevated, on-brand, gently lifts on hover */}
              <motion.div
                variants={mFadeUp}
                whileHover={{ y: -4 }}
                transition={{ type: 'spring', stiffness: 240, damping: 22 }}
                className="relative rounded-3xl p-7 sm:p-8 overflow-hidden depth-cyan"
                style={{ background: 'linear-gradient(160deg,#001A3D 0%,#001030 58%,#000820 100%)', border: '1px solid rgba(6,182,212,0.34)' }}
              >
                <div className="absolute -top-20 -right-16 w-56 h-56 rounded-full pointer-events-none"
                     style={{ background: 'radial-gradient(circle, rgba(6,182,212,0.30), transparent 70%)' }} />
                <div className="relative">
                  <div className="flex items-center justify-between gap-3 mb-6">
                    <div className="flex items-center gap-2.5">
                      <span className="w-9 h-9 rounded-xl grid place-items-center text-white" style={{ background: 'var(--gradient-cta)' }}><Sparkles size={16} /></span>
                      <h3 className="text-[15px] font-extrabold text-white">Gen Z Digital Store</h3>
                    </div>
                    <span className="text-[10.5px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full text-genz-cyan whitespace-nowrap"
                          style={{ background: 'rgba(6,182,212,0.14)', border: '1px solid rgba(6,182,212,0.32)' }}>Recommended</span>
                  </div>
                  <motion.ul className="space-y-3.5" variants={mStagger}>
                    {COMPARE.map((row) => (
                      <motion.li key={row} variants={mRowIn} className="flex items-start gap-3 text-[14.5px] text-white/90 leading-snug">
                        <span className="mt-0.5 w-5 h-5 rounded-full grid place-items-center flex-shrink-0" style={{ background: 'rgba(6,182,212,0.18)' }}>
                          <Check size={13} className="text-genz-cyan" />
                        </span>
                        <span>{row}</span>
                      </motion.li>
                    ))}
                  </motion.ul>
                </div>
              </motion.div>
            </motion.div>
          </MotionConfig>
        </div>
      </section>

      {/* ── PROCESS TIMELINE ── */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={stepRef} className={`gz-container reveal ${stepV ? 'visible' : ''}`}>
          <div className="text-center max-w-xl mx-auto mb-14">
            <Eyebrow label="How It Works" />
            <h2 className="type-section-title text-genz-navy mb-4">From idea to launch in five steps</h2>
          </div>
          <div className="relative grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="hidden lg:block absolute top-7 left-[10%] right-[10%] h-0.5 tl-line rounded-full" />
            {STEPS.map(({ icon: Icon, t, s }, i) => (
              <div key={t} className="relative text-center">
                <div className="mx-auto mb-4 w-14 h-14 rounded-2xl flex items-center justify-center text-white relative z-10 depth" style={{ background: 'var(--gradient-cta)' }}>
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
      <section className="gz-section px-5">
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

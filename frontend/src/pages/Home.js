import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap, Shield, Clock, HeadphonesIcon, CheckCircle2, Users, Layers, TrendingUp,
  Star, ChevronRight, Play, ArrowRight, Bot, Search, Palette, Video,
  Code2, BarChart3, BookOpen, Briefcase, Cpu, Globe, Sparkles, Lock,
  ChevronDown
} from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";

/* ─── Animated Orb 3D Background ─────────────────────────────────── */
const AnimatedBackground = () => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none">
    {/* Primary teal glow */}
    <div className="absolute top-20 right-1/4 w-96 h-96 rounded-full"
         style={{
           background: 'radial-gradient(circle, rgba(0,175,193,0.18) 0%, transparent 70%)',
           animation: 'float 6s ease-in-out infinite',
           filter: 'blur(40px)'
         }} />
    {/* Secondary navy glow */}
    <div className="absolute bottom-40 left-1/4 w-80 h-80 rounded-full"
         style={{
           background: 'radial-gradient(circle, rgba(0,142,163,0.12) 0%, transparent 70%)',
           animation: 'float 8s ease-in-out infinite reverse',
           filter: 'blur(60px)'
         }} />
    {/* Grid overlay */}
    <div className="absolute inset-0 opacity-5"
         style={{
           backgroundImage: 'linear-gradient(rgba(0,175,193,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(0,175,193,0.3) 1px, transparent 1px)',
           backgroundSize: '60px 60px'
         }} />
    {/* Floating particles */}
    {[...Array(8)].map((_, i) => (
      <div key={i}
           className="absolute rounded-full"
           style={{
             width: `${4 + (i % 3) * 3}px`,
             height: `${4 + (i % 3) * 3}px`,
             background: i % 2 === 0 ? 'rgba(0,175,193,0.4)' : 'rgba(0,142,163,0.3)',
             top: `${10 + i * 11}%`,
             left: `${5 + i * 12}%`,
             animation: `float ${4 + i}s ease-in-out infinite`,
             animationDelay: `${i * 0.5}s`,
             filter: 'blur(1px)'
           }} />
    ))}
  </div>
);

/* ─── Tool Category Cards ─────────────────────────────────────────── */
const toolCategories = [
  { icon: Bot,      label: 'AI Writing',       count: 12, color: '#00AFC1' },
  { icon: Search,   label: 'AI SEO Tools',      count: 8,  color: '#00AFC1' },
  { icon: Palette,  label: 'AI Design Tools',   count: 10, color: '#008EA3' },
  { icon: Video,    label: 'AI Video Tools',    count: 6,  color: '#008EA3' },
  { icon: Code2,    label: 'AI Coding Tools',   count: 9,  color: '#00AFC1' },
  { icon: BookOpen, label: 'Academic Tools',    count: 15, color: '#008EA3' },
  { icon: BarChart3,label: 'Business Tools',    count: 11, color: '#00AFC1' },
  { icon: Globe,    label: 'Marketing Tools',   count: 13, color: '#008EA3' },
];

/* ─── Featured Tools ────────────────────────────────────────────── */
const featuredTools = [
  { name: 'ChatGPT Premium',     category: 'AI Writing',  badge: 'Popular', desc: 'Advanced AI writing, coding, and analysis assistant.'   },
  { name: 'Grammarly Business',  category: 'AI Writing',  badge: 'AI',      desc: 'Professional grammar, tone, and style enhancement.'     },
  { name: 'Midjourney',          category: 'AI Design',   badge: 'Featured',desc: 'Generate stunning AI art and images from text prompts.' },
  { name: 'Semrush Pro',         category: 'SEO Tools',   badge: 'New',     desc: 'Complete SEO suite for keyword research and tracking.'  },
  { name: 'Notion AI',           category: 'Productivity',badge: 'Popular', desc: 'AI-powered workspace for notes, docs, and projects.'    },
  { name: 'Canva Pro',           category: 'AI Design',   badge: 'AI',      desc: 'Professional design platform with AI-powered features.' },
];

/* ─── FAQ Data ──────────────────────────────────────────────────── */
const faqs = [
  {
    q: 'What is Gen Z Digital Store?',
    a: 'Gen Z Digital Store is a premium all-in-one membership platform that gives you secure access to 90+ AI, academic, SEO, design, productivity, marketing, and business tools — all from a single dashboard.'
  },
  {
    q: 'How do I access the tools?',
    a: 'After purchasing a membership, you receive login credentials and access to your personal member portal. Each tool is accessible directly from your dashboard with one click, often using our Chrome extension for seamless auto-login.'
  },
  {
    q: 'Is my account secure?',
    a: 'Absolutely. We use device-binding technology, httpOnly cookies, short-lived access tokens, and rotating refresh tokens. Your account is locked to your registered device for maximum security.'
  },
  {
    q: 'What tools are included?',
    a: 'We offer 50+ premium tools across AI writing, SEO, design, video creation, coding assistants, academic research, business analytics, and marketing — with new tools added regularly.'
  },
  {
    q: 'Can I cancel my membership?',
    a: 'Yes. You can cancel anytime. Access continues until the end of your current billing period. We offer a satisfaction guarantee on all memberships.'
  },
  {
    q: 'Do I need to install anything?',
    a: 'Our Chrome extension makes accessing tools seamless with auto-login. However, all tools are also accessible directly from your web dashboard without any installation required.'
  },
];

/* ─── Testimonials ─────────────────────────────────────────────── */
const testimonials = [
  { name: 'Ahmed Al-Rashidi',  role: 'Digital Marketer',    text: 'Gen Z Digital Store saved me thousands of dollars in subscriptions. I get everything I need in one place!',         rating: 5 },
  { name: 'Fatima Hassan',     role: 'Content Creator',     text: 'The AI writing tools alone are worth it. I\'ve 3x\'d my content output since joining. Absolutely fantastic!',        rating: 5 },
  { name: 'Mohammed Karimi',   role: 'SEO Specialist',      text: 'Having Semrush, Ahrefs, and other SEO tools under one subscription is a game changer for my agency work.',          rating: 5 },
  { name: 'Sarah Al-Ameri',    role: 'University Student',  text: 'The academic tools helped me ace my research papers. Grammarly + research databases in one dashboard is amazing!',  rating: 5 },
  { name: 'Khalid Ibrahim',    role: 'Web Developer',       text: 'GitHub Copilot, coding assistants, and productivity tools — all in one place. My workflow has never been smoother.', rating: 5 },
  { name: 'Nadia Mahmoud',     role: 'Business Owner',      text: 'The ROI on this membership is incredible. My whole team uses it and we\'ve cut our software costs by 70%.',          rating: 5 },
];

/* ─── HOW IT WORKS ─────────────────────────────────────────────── */
const howItWorks = [
  { step: '01', title: 'Choose Your Plan',       desc: 'Select the membership that fits your needs — personal, team, or enterprise.'    },
  { step: '02', title: 'Get Instant Access',     desc: 'Receive your credentials and access your personal member dashboard immediately.' },
  { step: '03', title: 'Install Chrome Extension', desc: 'Install our free Chrome extension for seamless one-click tool access.'       },
  { step: '04', title: 'Unlock All Tools',       desc: 'Browse 50+ premium tools and start using them instantly from your dashboard.'   },
];

/* ─── MAIN HOME COMPONENT ──────────────────────────────────────── */
const Home = () => {
  const [activeCategory, setActiveCategory] = useState('AI Writing');
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  const [visibleSections, setVisibleSections] = useState(new Set());

  // Simple scroll-based fade-in
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setVisibleSections(prev => new Set([...prev, entry.target.dataset.section]));
          }
        });
      },
      { threshold: 0.1 }
    );
    document.querySelectorAll('[data-section]').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const sectionClass = (id) =>
    `transition-all duration-700 ${visibleSections.has(id) ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`;

  const statsCards = [
    { icon: Layers,          value: '50+',      label: 'Premium Tools',    delay: '0ms'   },
    { icon: Zap,             value: 'All-in-One', label: 'Subscription',   delay: '100ms' },
    { icon: HeadphonesIcon,  value: '24/7',     label: 'Support',          delay: '200ms' },
    { icon: TrendingUp,      value: 'Fast',     label: 'Easy Access',      delay: '300ms' },
  ];

  const pricingPlans = [
    {
      name: 'Starter',
      price: billingPeriod === 'monthly' ? '29' : '249',
      desc: 'Perfect for individuals getting started',
      features: ['15 Premium Tools', 'Basic AI Tools', 'Chrome Extension', 'Email Support', '1 Device'],
      cta: 'Get Starter',
      featured: false,
    },
    {
      name: 'Pro',
      price: billingPeriod === 'monthly' ? '59' : '499',
      desc: 'Everything you need for professional work',
      features: ['50+ Premium Tools', 'Full AI Suite', 'Chrome Extension', 'Priority Support', '2 Devices', 'Academic Tools'],
      cta: 'Get Pro — Most Popular',
      featured: true,
    },
    {
      name: 'Business',
      price: billingPeriod === 'monthly' ? '99' : '849',
      desc: 'Complete suite for teams and agencies',
      features: ['50+ Premium Tools', 'Full AI Suite', 'Team Dashboard', 'Dedicated Support', 'Unlimited Devices', 'Business Analytics', 'Custom Onboarding'],
      cta: 'Get Business',
      featured: false,
    },
  ];

  return (
    <div className="text-white overflow-x-hidden" style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 50%, #000820 100%)' }}>

      {/* ─── HERO SECTION ──────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center pt-24 pb-20 px-4 overflow-hidden">
        <AnimatedBackground />
        <div className="max-w-7xl mx-auto relative z-10 w-full">
          <div className="text-center max-w-5xl mx-auto">

            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-8"
                 style={{ background: 'rgba(0,175,193,0.1)', borderColor: 'rgba(0,175,193,0.3)' }}>
              <Sparkles size={14} className="text-genz-teal" />
              <span className="text-genz-teal text-sm font-medium">90+ Premium Digital Tools in One Place</span>
            </div>

            {/* Headline */}
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-black mb-6 leading-tight tracking-tight"
                data-testid="hero-heading">
              All Your Premium
              <br />
              <span style={{ background: 'linear-gradient(135deg, #00AFC1, #FFFFFF)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Digital Tools
              </span>
              <br />
              in One Smart Dashboard
            </h1>

            {/* Subheadline */}
            <p className="text-xl text-genz-muted mb-10 max-w-3xl mx-auto leading-relaxed"
               data-testid="hero-subheading">
              Access AI, academic, SEO, design, productivity, marketing, and business tools
              from one secure <span className="text-genz-teal font-semibold">Gen Z Digital Store</span> membership.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
              <Link to="/tools"
                className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-genz-deep-navy rounded-2xl transition-all hover:opacity-90 hover:scale-105 transform shadow-lg"
                style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)', boxShadow: '0 8px 32px rgba(0,175,193,0.3)' }}
                data-testid="hero-explore-tools-btn">
                <Zap size={20} />
                Explore Tools
              </Link>
              <Link to="/join"
                className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold rounded-2xl border transition-all hover:bg-genz-teal/10"
                style={{ borderColor: 'rgba(0,175,193,0.4)', color: '#00AFC1' }}
                data-testid="hero-start-membership-btn">
                Start Membership
                <ArrowRight size={20} />
              </Link>
              <Link to="/client/login"
                className="inline-flex items-center gap-2 px-8 py-4 text-base font-medium rounded-2xl border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-all"
                data-testid="hero-client-login-btn">
                Client Login
                <Lock size={16} />
              </Link>
            </div>

            <p className="text-sm text-genz-muted">
              Instant access • Cancel anytime • 24/7 support • Device-secured
            </p>

            {/* Dashboard Preview Mock */}
            <div className="mt-16 relative max-w-4xl mx-auto">
              <div className="rounded-2xl p-1 shadow-2xl"
                   style={{ background: 'linear-gradient(135deg, rgba(0,175,193,0.3), rgba(0,16,48,0.8))', boxShadow: '0 24px 80px rgba(0,175,193,0.2)' }}>
                <div className="rounded-xl overflow-hidden"
                     style={{ background: 'linear-gradient(180deg, #001a40 0%, #000c20 100%)' }}>
                  {/* Browser bar */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-genz-teal/10">
                    {['#ff5f57','#ffbd2e','#28c840'].map((c,i) => (
                      <div key={i} className="w-3 h-3 rounded-full" style={{ background: c }} />
                    ))}
                    <div className="flex-1 mx-4 h-6 rounded-full bg-white/5 flex items-center px-3">
                      <span className="text-xs text-genz-muted">app.genzdigitalstore.com/dashboard</span>
                    </div>
                  </div>
                  {/* Dashboard content */}
                  <div className="p-6 grid grid-cols-3 md:grid-cols-6 gap-3">
                    {['ChatGPT','Grammarly','Midjourney','Semrush','Canva','Notion','Ahrefs','Loom','Jasper','Surfer','Figma','Claude'].map((tool, i) => (
                      <div key={tool}
                           className="p-3 rounded-xl text-center transition-all hover:scale-105"
                           style={{ background: 'rgba(0,175,193,0.08)', border: '1px solid rgba(0,175,193,0.12)' }}>
                        <div className="w-8 h-8 rounded-lg mx-auto mb-1.5 flex items-center justify-center text-xs font-bold"
                             style={{ background: `hsl(${i * 30}, 70%, 50%)` }}>
                          {tool.charAt(0)}
                        </div>
                        <span className="text-genz-muted" style={{ fontSize: '9px' }}>{tool}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {/* Glow effect */}
              <div className="absolute inset-0 -z-10 rounded-2xl"
                   style={{ background: 'radial-gradient(circle at 50% 100%, rgba(0,175,193,0.15), transparent 60%)', filter: 'blur(30px)' }} />
            </div>
          </div>
        </div>
      </section>

      {/* ─── STATS SECTION ─────────────────────────────────────── */}
      <section className="py-16 px-4" data-section="stats">
        <div className={`max-w-7xl mx-auto ${sectionClass('stats')}`}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            {statsCards.map((stat, i) => {
              const Icon = stat.icon;
              return (
                <div key={i}
                     className="p-8 text-center rounded-2xl border transition-all hover:-translate-y-1 hover:shadow-lg group"
                     style={{
                       background: 'rgba(0,175,193,0.05)',
                       borderColor: 'rgba(0,175,193,0.12)',
                       transitionDelay: stat.delay,
                       boxShadow: '0 4px 24px rgba(0,0,0,0.2)'
                     }}>
                  <div className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
                       style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                    <Icon size={22} className="text-genz-deep-navy" />
                  </div>
                  <div className="text-4xl font-black text-genz-teal mb-1">{stat.value}</div>
                  <div className="text-genz-muted text-sm">{stat.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ─── TOOL CATEGORIES ───────────────────────────────────── */}
      <section className="py-20 px-4" data-section="categories">
        <div className={`max-w-7xl mx-auto ${sectionClass('categories')}`}>
          <div className="text-center mb-12">
            <h2 className="text-4xl font-black mb-4">
              Explore Our <span className="text-genz-teal">Tool Categories</span>
            </h2>
            <p className="text-genz-muted text-lg max-w-2xl mx-auto">
              From AI to business, we have everything you need to dominate your work
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {toolCategories.map(({ icon: Icon, label, count }) => (
              <button key={label}
                      onClick={() => setActiveCategory(label)}
                      className={`p-5 rounded-2xl border text-left transition-all hover:-translate-y-0.5 ${
                        activeCategory === label
                          ? 'border-genz-teal bg-genz-teal/10 shadow-lg'
                          : 'border-genz-border/30 hover:border-genz-teal/40'
                      }`}
                      style={{ background: activeCategory === label ? 'rgba(0,175,193,0.1)' : 'rgba(0,175,193,0.03)' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
                     style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                  <Icon size={18} className="text-genz-deep-navy" />
                </div>
                <p className="font-semibold text-sm text-white">{label}</p>
                <p className="text-xs text-genz-muted mt-1">{count} tools</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FEATURED AI TOOLS ────────────────────────────────── */}
      <section className="py-20 px-4" data-section="featured-tools">
        <div className={`max-w-7xl mx-auto ${sectionClass('featured-tools')}`}>
          <div className="text-center mb-12">
            <h2 className="text-4xl font-black mb-4">
              Featured <span className="text-genz-teal">AI Tools</span>
            </h2>
            <p className="text-genz-muted text-lg">The most powerful tools at your fingertips</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {featuredTools.map((tool) => (
              <div key={tool.name}
                   className="p-6 rounded-2xl border transition-all hover:-translate-y-1 hover:shadow-xl group"
                   style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.12)' }}>
                <div className="flex items-start justify-between mb-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-black text-white"
                       style={{ background: 'linear-gradient(135deg, #001030, #00AFC1)' }}>
                    {tool.name.charAt(0)}
                  </div>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                    tool.badge === 'Popular' ? 'bg-genz-teal/20 text-genz-teal' :
                    tool.badge === 'New'     ? 'bg-green-500/20 text-green-400' :
                    tool.badge === 'AI'      ? 'bg-purple-500/20 text-purple-400' :
                                               'bg-yellow-500/20 text-yellow-400'
                  }`}>{tool.badge}</span>
                </div>
                <h3 className="font-bold text-white mb-1">{tool.name}</h3>
                <p className="text-xs text-genz-teal mb-2">{tool.category}</p>
                <p className="text-genz-muted text-sm mb-4 leading-relaxed">{tool.desc}</p>
                <Link to="/join"
                      className="inline-flex items-center gap-1 text-sm font-medium text-genz-teal hover:underline group-hover:gap-2 transition-all">
                  Access Tool <ChevronRight size={14} />
                </Link>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link to="/tools"
                  className="inline-flex items-center gap-2 px-8 py-3.5 rounded-2xl font-semibold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
                  style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              View All 90+ Tools <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─────────────────────────────────────── */}
      <section className="py-20 px-4" data-section="how-it-works"
               style={{ background: 'rgba(0,175,193,0.03)' }}>
        <div className={`max-w-7xl mx-auto ${sectionClass('how-it-works')}`}>
          <div className="text-center mb-14">
            <h2 className="text-4xl font-black mb-4">
              How <span className="text-genz-teal">Gen Z Digital Store</span> Works
            </h2>
            <p className="text-genz-muted text-lg">Get started in minutes, not hours</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {howItWorks.map((step, i) => (
              <div key={i} className="text-center relative">
                {i < howItWorks.length - 1 && (
                  <div className="hidden md:block absolute top-8 right-0 w-1/2 h-0.5 translate-x-1/2"
                       style={{ background: 'linear-gradient(90deg, rgba(0,175,193,0.5), transparent)' }} />
                )}
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 font-black text-xl text-genz-deep-navy"
                     style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                  {step.step}
                </div>
                <h3 className="font-bold text-white mb-2">{step.title}</h3>
                <p className="text-genz-muted text-sm leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── WHY CHOOSE US ────────────────────────────────────── */}
      <section className="py-20 px-4" data-section="why-us">
        <div className={`max-w-7xl mx-auto ${sectionClass('why-us')}`}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-4xl font-black mb-6">
                Why Choose
                <br /><span className="text-genz-teal">Gen Z Digital Store</span>?
              </h2>
              <div className="space-y-4">
                {[
                  { icon: Shield,    title: 'Bank-Grade Security',    desc: 'Device-bound accounts, encrypted tokens, and zero token leakage ensure your data is always protected.'  },
                  { icon: Zap,       title: 'Instant Tool Access',    desc: 'One-click Chrome extension gives you seamless access to any tool without remembering passwords.'          },
                  { icon: Cpu,       title: '50+ Premium Tools',      desc: 'From ChatGPT to Semrush, we keep all your favourite premium subscriptions under one affordable plan.'     },
                  { icon: Users,     title: 'Expert Support',         desc: '24/7 dedicated support via WhatsApp and email. Our team ensures you get maximum value from every tool.'   },
                  { icon: TrendingUp,title: 'Always Up-to-Date',      desc: 'We constantly add new tools and keep existing ones updated so you always have access to the latest tech.'},
                ].map(({ icon: Icon, title, desc }) => (
                  <div key={title}
                       className="flex gap-4 p-4 rounded-xl border transition-all hover:bg-genz-teal/5"
                       style={{ borderColor: 'rgba(0,175,193,0.1)' }}>
                    <div className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center"
                         style={{ background: 'rgba(0,175,193,0.15)' }}>
                      <Icon size={18} className="text-genz-teal" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-white mb-1">{title}</h4>
                      <p className="text-genz-muted text-sm leading-relaxed">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Stats side */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { value: 'Growing', label: 'Happy Members',    icon: Users   },
                { value: '90+',    label: 'Premium Tools',    icon: Layers  },
                { value: '4.9/5',  label: 'Average Rating',   icon: Star    },
                { value: 'Secure',  label: 'Platform',       icon: Shield  },
              ].map(({ value, label, icon: Icon }) => (
                <div key={label}
                     className="p-6 rounded-2xl border text-center"
                     style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.12)' }}>
                  <Icon size={24} className="text-genz-teal mx-auto mb-3" />
                  <div className="text-3xl font-black text-white mb-1">{value}</div>
                  <div className="text-genz-muted text-sm">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── PRICING ──────────────────────────────────────────── */}
      <section className="py-20 px-4" data-section="pricing"
               style={{ background: 'rgba(0,175,193,0.03)' }}>
        <div className={`max-w-7xl mx-auto ${sectionClass('pricing')}`}>
          <div className="text-center mb-12">
            <h2 className="text-4xl font-black mb-4">
              Simple, <span className="text-genz-teal">Transparent Pricing</span>
            </h2>
            <p className="text-genz-muted text-lg mb-6">No hidden fees. Cancel anytime.</p>
            {/* Billing toggle */}
            <div className="inline-flex items-center p-1 rounded-full border"
                 style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
              {['monthly', 'annually'].map(period => (
                <button key={period}
                        onClick={() => setBillingPeriod(period)}
                        className={`px-6 py-2 rounded-full text-sm font-semibold transition-all ${
                          billingPeriod === period
                            ? 'text-genz-deep-navy'
                            : 'text-genz-muted hover:text-white'
                        }`}
                        style={billingPeriod === period
                          ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }
                          : {}}>
                  {period === 'annually' ? 'Annually (Save 30%)' : 'Monthly'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {pricingPlans.map((plan) => (
              <div key={plan.name}
                   className={`relative p-8 rounded-2xl border transition-all hover:-translate-y-1 ${
                     plan.featured ? 'scale-105' : ''
                   }`}
                   style={{
                     background: plan.featured ? 'linear-gradient(135deg, rgba(0,175,193,0.15), rgba(0,16,48,0.8))' : 'rgba(0,175,193,0.04)',
                     borderColor: plan.featured ? 'rgba(0,175,193,0.5)' : 'rgba(0,175,193,0.12)',
                     boxShadow: plan.featured ? '0 16px 48px rgba(0,175,193,0.2)' : 'none'
                   }}>
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-bold text-genz-deep-navy"
                       style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                    MOST POPULAR
                  </div>
                )}
                <h3 className="text-xl font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-genz-muted text-sm mb-4">{plan.desc}</p>
                <div className="mb-6">
                  <span className="text-5xl font-black text-white">${plan.price}</span>
                  <span className="text-genz-muted text-sm ml-1">/{billingPeriod === 'monthly' ? 'mo' : 'yr'}</span>
                </div>
                <ul className="space-y-3 mb-8">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-center gap-2.5 text-sm">
                      <CheckCircle2 size={16} className="text-genz-teal flex-shrink-0" />
                      <span className="text-white/80">{f}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/join"
                      className={`w-full py-3 rounded-xl font-semibold text-sm text-center block transition-all hover:opacity-90 hover:scale-105 ${
                        plan.featured ? 'text-genz-deep-navy' : 'text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10'
                      }`}
                      style={plan.featured ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── TESTIMONIALS ─────────────────────────────────────── */}
      <section className="py-20 px-4" data-section="testimonials">
        <div className={`max-w-7xl mx-auto ${sectionClass('testimonials')}`}>
          <div className="text-center mb-12">
            <h2 className="text-4xl font-black mb-4">
              Loved by <span className="text-genz-teal">Our Members</span>
            </h2>
            <p className="text-genz-muted text-lg">Real stories from real members</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {testimonials.map(({ name, role, text, rating }) => (
              <div key={name}
                   className="p-6 rounded-2xl border transition-all hover:-translate-y-1"
                   style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.12)' }}>
                <div className="flex items-center gap-1 mb-3">
                  {[...Array(rating)].map((_, i) => (
                    <Star key={i} size={14} className="text-yellow-400 fill-yellow-400" />
                  ))}
                </div>
                <p className="text-white/80 text-sm leading-relaxed mb-5">"{text}"</p>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm text-genz-deep-navy"
                       style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                    {name.split(' ').map(n => n[0]).join('')}
                  </div>
                  <div>
                    <p className="text-white text-sm font-semibold">{name}</p>
                    <p className="text-genz-muted text-xs">{role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FAQ ──────────────────────────────────────────────── */}
      <section className="py-20 px-4" data-section="faq"
               style={{ background: 'rgba(0,175,193,0.03)' }}>
        <div className={`max-w-3xl mx-auto ${sectionClass('faq')}`}>
          <div className="text-center mb-12">
            <h2 className="text-4xl font-black mb-4">
              Frequently Asked <span className="text-genz-teal">Questions</span>
            </h2>
            <p className="text-genz-muted text-lg">Everything you need to know</p>
          </div>
          <Accordion type="single" collapsible className="space-y-3">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`item-${i}`}
                className="rounded-xl border overflow-hidden"
                style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.12)' }}>
                <AccordionTrigger className="px-6 py-4 text-white font-medium hover:text-genz-teal hover:no-underline text-left">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4 text-genz-muted leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ─── FINAL CTA ────────────────────────────────────────── */}
      <section className="py-24 px-4" data-section="cta">
        <div className={`max-w-4xl mx-auto text-center ${sectionClass('cta')}`}>
          <div className="p-1 rounded-3xl"
               style={{ background: 'linear-gradient(135deg, rgba(0,175,193,0.4), rgba(0,16,48,0.8), rgba(0,175,193,0.4))' }}>
            <div className="p-12 rounded-3xl"
                 style={{ background: 'linear-gradient(135deg, #001030, #000820)' }}>
              <GenZDigitalStoreLogo className="h-12 justify-center mb-6" textSize="2xl" />
              <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
                Ready to Unlock
                <span className="block text-genz-teal">All Your Digital Tools?</span>
              </h2>
              <p className="text-genz-muted text-lg mb-8 max-w-2xl mx-auto">
                Join thousands of professionals who save time and money with Gen Z Digital Store.
                Start your membership today.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link to="/join"
                      className="inline-flex items-center gap-2 px-10 py-4 text-lg font-bold text-genz-deep-navy rounded-2xl transition-all hover:opacity-90 hover:scale-105"
                      style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)', boxShadow: '0 8px 32px rgba(0,175,193,0.4)' }}>
                  <Zap size={22} /> Start My Membership
                </Link>
                <Link to="/tools"
                      className="inline-flex items-center gap-2 px-10 py-4 text-lg font-medium text-genz-teal rounded-2xl border transition-all hover:bg-genz-teal/10"
                      style={{ borderColor: 'rgba(0,175,193,0.4)' }}>
                  Browse Tools First
                </Link>
              </div>
              <p className="text-genz-muted text-sm mt-6">
                No commitment • Instant access • 24/7 support
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Float animation keyframes */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-12px); }
        }
      `}</style>
    </div>
  );
};

export default Home;

import { Link } from 'react-router-dom';
import { Shield, Cpu, CheckCircle, ArrowRight, LayoutDashboard, Chrome, Key, Zap } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import FAQItem from '../../components/public/FAQItem';

const TOOLS_CATEGORIES = [
  { label: 'AI Writing Tools',        n: '10+' },
  { label: 'SEO & Analytics',         n: '8+'  },
  { label: 'Design & Creative',       n: '12+' },
  { label: 'Productivity Tools',      n: '15+' },
  { label: 'Academic Research',       n: '6+'  },
  { label: 'Social Media Tools',      n: '9+'  },
  { label: 'Business & CRM',          n: '7+'  },
  { label: 'Video & Media',           n: '5+'  },
];

const HOW_STEPS = [
  { icon: Key,             label: 'Admin assigns tools',     sub: 'Your membership plan includes specific tool access assigned by an admin.' },
  { icon: LayoutDashboard, label: 'Log in to dashboard',     sub: 'Sign in to your client dashboard to view all your assigned tools.' },
  { icon: Chrome,          label: 'Extension connects',      sub: 'The Chrome extension securely bridges your session to the assigned tool.' },
  { icon: Zap,             label: 'Open and work instantly', sub: 'One click — the tool opens with secure, pre-authorised access.' },
];

const FAQS = [
  { q: 'What tools are included?', a: 'The tools vary by plan. Categories include AI writing, SEO, design, productivity, academic research, social media, business tools, and more. Your admin confirms which tools are in your package.' },
  { q: 'Do I need the Chrome extension?', a: 'Yes — the Chrome extension is required to securely open assigned tools. It communicates with your active session to authenticate access without exposing credentials.' },
  { q: 'Are the tools shared accounts?', a: 'Tools are accessed through a secure, admin-controlled system. Credentials are never exposed to clients — the extension handles the secure connection.' },
  { q: 'Can I request a specific tool?', a: 'Yes. Contact your admin or reach us via WhatsApp to request tool additions or upgrades to your plan.' },
];

const ServiceDigitalTools = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [stepsRef, stepsVisible] = useReveal();
  const [catsRef, catsVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="page-hero pt-32 pb-20 lg:pt-32 lg:pb-24 px-5">
        <span className="brand-blob brand-blob-a" aria-hidden="true" />
        <span className="brand-blob brand-blob-b" aria-hidden="true" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(6,182,212,0.13),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(6,182,212,0.3)', background: 'rgba(6,182,212,0.08)' }}>
            <span className="glow-dot" /> Digital Tools Access
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            Premium <span className="text-gradient-teal">Digital Tools</span>, Securely Accessed
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            Get admin-managed access to 50+ professional AI, SEO, design, and productivity tools —
            all through one secure, extension-powered client dashboard.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link to="/client/login"
              className="flex items-center gap-2 px-6 py-3.5 rounded-full text-sm font-bold text-white"
              style={{ background: 'var(--gradient-cta)' }}>
              <LayoutDashboard size={15} /> Access Dashboard
            </Link>
            <Link to="/chrome-extension"
              className="flex items-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10 transition-all">
              <Chrome size={15} /> Get Extension
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-4">
        <div ref={stepsRef} className={`max-w-5xl mx-auto reveal ${stepsVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-12">How tool access works</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {HOW_STEPS.map(({ icon: Icon, label, sub }, i) => (
              <div key={label} className="relative flex flex-col items-center text-center p-6 rounded-2xl"
                style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                  style={{ background: 'var(--gradient-cta)' }}>
                  {i + 1}
                </div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mt-4 mb-4"
                  style={{ background: 'rgba(6,182,212,0.15)' }}>
                  <Icon size={20} className="text-genz-teal" />
                </div>
                <h3 className="text-genz-navy font-semibold text-sm mb-2">{label}</h3>
                <p className="text-genz-muted text-xs leading-relaxed">{sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tool categories */}
      <section className="py-20 px-4">
        <div ref={catsRef} className={`max-w-5xl mx-auto reveal ${catsVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-4">Tool categories</h2>
          <p className="text-genz-muted text-center text-sm mb-12">Categories available across plans — specific tools assigned per membership.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {TOOLS_CATEGORIES.map(({ label, n }) => (
              <div key={label} className="flex flex-col items-center text-center p-5 rounded-2xl"
                style={{ background: '#ffffff', border: '1px solid var(--brand-border)' }}>
                <span className="text-2xl font-extrabold text-genz-teal mb-1">{n}</span>
                <span className="text-genz-muted text-xs leading-tight">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security callout */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto rounded-3xl p-8 text-center"
          style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)' }}>
          <Shield size={28} className="text-genz-teal mx-auto mb-4" />
          <h3 className="text-genz-navy font-bold text-xl mb-3">Enterprise-grade security</h3>
          <p className="text-genz-muted text-sm leading-relaxed mb-6">
            No credentials are ever exposed to clients. Tool access is handled entirely through the
            extension bridge — admin-controlled, session-bound, and always encrypted.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {['Admin-controlled access','Session-bound tokens','Extension-encrypted bridge','Activity logging'].map(f=>(
              <span key={f} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-genz-teal"
                style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)' }}>
                <CheckCircle size={11} /> {f}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-genz-navy text-center mb-8">Questions about tool access</h2>
          <div className="space-y-3">
            {FAQS.map((f,i)=><FAQItem key={i} question={f.q} answer={f.a} />)}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to access premium digital tools?" sub="Log in to your dashboard or contact us to get set up." />
    </div>
  );
};

export default ServiceDigitalTools;

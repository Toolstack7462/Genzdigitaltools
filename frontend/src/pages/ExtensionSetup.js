import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Chrome, ShieldCheck, Download, CheckCircle2, ArrowLeft, Puzzle, MousePointerClick, Plug } from 'lucide-react';
import BrandLogo from '../components/BrandLogo';

const FLOW = [
  [Download, 'Install', 'Load the Chrome extension from the download page (or the Web Store when published).'],
  [Plug, 'Connect', 'Log in to your dashboard — the extension pairs automatically via your secure session.'],
  [MousePointerClick, 'Access', 'Press Access on any assigned tool and it opens, already logged in.'],
];

const ExtensionSetup = () => {
  const reduce = useReducedMotion();
  const ease = [0.16, 1, 0.3, 1];
  const fade = (d = 0) => (reduce ? {} : {
    initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, ease, delay: d },
  });

  return (
    <div className="relative min-h-dvh overflow-hidden" style={{ background: 'var(--gradient-hero)' }}>
      <div className="aurora" />
      <div className="dot-grid" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-12 sm:py-16">
        <Link to="/client/dashboard"
              className="inline-flex items-center gap-2 text-sm text-genz-muted hover:text-genz-teal transition-colors mb-8">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <motion.div {...fade(0.04)} className="glass depth rounded-[26px] p-7 sm:p-9">
          <div className="flex items-center gap-4 mb-7">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 sheen"
                 style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 30px rgba(37,99,235,0.35)' }}>
              <Chrome className="text-white" size={28} />
            </div>
            <div>
              <h1 className="font-heading text-[26px] sm:text-[30px] font-extrabold text-genz-navy tracking-tight leading-tight">
                Set up your extension
              </h1>
              <p className="text-genz-muted text-[14px]">Install the browser helper to open tools from your dashboard.</p>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-4 mb-8">
            {FLOW.map(([Icon, title, desc], i) => (
              <div key={title}
                   className="rounded-2xl p-5 bg-white/60 border border-genz-border transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-[13px] font-black"
                        style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>{i + 1}</span>
                  <Icon size={16} className="text-genz-teal" />
                </div>
                <h3 className="font-bold text-genz-navy text-[15px] mb-1">{title}</h3>
                <p className="text-genz-muted text-[13px] leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl p-5 mb-7 flex items-start gap-3"
               style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)' }}>
            <ShieldCheck className="flex-shrink-0 mt-0.5" size={20} style={{ color: '#06B6D4' }} />
            <div>
              <h3 className="font-semibold text-genz-navy text-[14px] mb-1">Security note</h3>
              <p className="text-genz-muted text-[13px] leading-relaxed">
                The website never receives tool passwords, cookies, or session bundles — and never your browsing
                history or tab contents. The extension applies your authorized session locally and opens the tool.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link to="/chrome-extension"
                  className="btn-grad inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-bold hover:-translate-y-0.5 transition-transform">
              <Download size={17} /> Download / Install Extension
            </Link>
            <Link to="/client/dashboard"
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-semibold border border-genz-border text-genz-navy bg-white/60 hover:border-genz-teal/40 transition-all">
              <CheckCircle2 size={17} /> Open Dashboard
            </Link>
          </div>
        </motion.div>

        <motion.p {...fade(0.12)} className="text-center text-genz-muted text-[12.5px] mt-6 flex items-center justify-center gap-1.5">
          <Puzzle size={13} className="text-genz-teal" /> Works in any Chromium browser on your approved device.
        </motion.p>
      </main>
    </div>
  );
};

export default ExtensionSetup;

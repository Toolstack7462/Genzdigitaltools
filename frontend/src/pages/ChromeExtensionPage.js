import {
  Download, Chrome, ShieldCheck, CheckCircle2, ArrowLeft,
  Zap, Lock, Puzzle, Sparkles, MousePointerClick,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import BrandLogo from '../components/BrandLogo';
import { getLatestExtension, EXT_ZIP_PATH, versionedZipName } from '../lib/extension';

// Version is read live from the backend (admin uploads the latest ZIP; the
// backend extracts the version from the ZIP manifest). The download path is the
// EXISTING /downloads link — only the cache-bust version is dynamic.

const STEPS = [
  ['Download the ZIP', 'Grab the latest signed extension package below.'],
  ['Extract it', 'Unzip to a permanent folder you won’t delete.'],
  ['Open chrome://extensions', 'Paste that into Chrome’s address bar.'],
  ['Enable Developer mode', 'Toggle it on — top-right of the page.'],
  ['Load unpacked', 'Select the extracted extension folder.'],
  ['Open your dashboard', 'Pairing happens automatically from your session.'],
];

const FEATURES = [
  [Zap, 'One-click access', 'Open assigned tools instantly — already signed in.'],
  [Lock, 'Zero secret exposure', 'Passwords, cookies & sessions never touch the website.'],
  [ShieldCheck, 'Device-bound security', 'Access is tied to your approved device only.'],
];

const ChromeExtensionPage = () => {
  const reduce = useReducedMotion();
  const [ext, setExt] = useState({ latest: null, downloadUrl: EXT_ZIP_PATH });
  useEffect(() => {
    let alive = true;
    getLatestExtension().then(info => { if (alive) setExt(info); });
    return () => { alive = false; };
  }, []);
  const ease = [0.16, 1, 0.3, 1];
  const fade = (d = 0) => (reduce ? {} : {
    initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, ease, delay: d },
  });

  return (
    <div className="relative min-h-dvh overflow-hidden" style={{ background: 'var(--gradient-hero)' }}>
      <div className="aurora" />
      <div className="dot-grid" />

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-10 sm:py-14">
        <Link to="/client/dashboard"
              className="inline-flex items-center gap-2 text-sm text-genz-muted hover:text-genz-teal transition-colors mb-8">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        {/* ── Hero ── */}
        <motion.div {...fade(0.04)} className="text-center mb-10">
          <div className="flex justify-center mb-5"><BrandLogo size="2xl" glow /></div>
          <span className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.16em] text-genz-blue mb-3">
            <Sparkles size={13} /> Browser Extension
          </span>
          <h1 className="font-heading text-[34px] sm:text-[44px] font-extrabold text-genz-navy tracking-tight leading-[1.05] mb-3">
            Your tools, one secure click away
          </h1>
          <p className="text-genz-muted text-[15px] sm:text-[16px] max-w-2xl mx-auto leading-relaxed">
            Install the Gen Z Digital Store helper to open every assigned tool — already logged in —
            straight from your member dashboard. No passwords, ever.
          </p>
        </motion.div>

        {/* ── Download card (3D glass) ── */}
        <motion.div {...fade(0.1)} className="stage-3d mb-10">
          <div className="glass depth rounded-[26px] p-7 sm:p-9 relative overflow-hidden">
            <svg className="absolute -right-10 -top-10 w-64 h-64 opacity-30 pointer-events-none" viewBox="0 0 200 200" fill="none" aria-hidden="true">
              <defs><linearGradient id="ext-glow" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#2563EB" /><stop offset="1" stopColor="#06B6D4" />
              </linearGradient></defs>
              <circle cx="100" cy="100" r="80" stroke="url(#ext-glow)" strokeWidth="2" opacity="0.5" />
              <circle cx="100" cy="100" r="55" stroke="url(#ext-glow)" strokeWidth="1.5" opacity="0.35" />
            </svg>

            <div className="relative flex flex-col sm:flex-row sm:items-center gap-6">
              <div className="flex items-center gap-4 flex-1">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0 sheen"
                     style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 30px rgba(37,99,235,0.35)' }}>
                  <Chrome className="text-white" size={32} />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-[22px] font-bold text-genz-navy">Download Extension</h2>
                    {ext.latest && (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full text-genz-teal"
                            style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.28)' }}>
                        v{ext.latest}
                      </span>
                    )}
                  </div>
                  <p className="text-genz-muted text-[14px]">Latest signed build for manual Chrome install.</p>
                </div>
              </div>

              <a href={ext.downloadUrl} download={versionedZipName(ext.latest)}
                 className="btn-grad inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold whitespace-nowrap hover:-translate-y-0.5 transition-transform">
                <Download size={18} /> Download ZIP
              </a>
            </div>
          </div>
        </motion.div>

        {/* ── Feature highlights ── */}
        <motion.div {...fade(0.16)} className="grid sm:grid-cols-3 gap-4 mb-10">
          {FEATURES.map(([Icon, title, desc]) => (
            <div key={title}
                 className="glass rounded-2xl p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl mb-3"
                    style={{ background: 'rgba(6,182,212,0.12)', color: '#06B6D4', border: '1px solid rgba(6,182,212,0.25)' }}>
                <Icon size={18} />
              </span>
              <h3 className="font-bold text-genz-navy text-[15px] mb-1">{title}</h3>
              <p className="text-genz-muted text-[13px] leading-relaxed">{desc}</p>
            </div>
          ))}
        </motion.div>

        {/* ── Installation steps ── */}
        <motion.div {...fade(0.22)} className="glass depth rounded-[26px] p-7 sm:p-9 mb-10">
          <div className="flex items-center gap-2 mb-6">
            <MousePointerClick size={18} className="text-genz-teal" />
            <h2 className="text-[20px] font-bold text-genz-navy">Install in 6 quick steps</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5">
            {STEPS.map(([title, desc], i) => (
              <div key={title} className="flex gap-4 group">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-[14px] font-black text-white transition-transform group-hover:scale-110"
                     style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 6px 14px rgba(37,99,235,0.28)' }}>
                  {i + 1}
                </div>
                <div className="pt-0.5">
                  <h3 className="font-bold text-genz-navy text-[14.5px] mb-0.5">{title}</h3>
                  <p className="text-genz-muted text-[13px] leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* ── Security note ── */}
        <motion.div {...fade(0.28)}
          className="rounded-2xl p-5 mb-10 flex items-start gap-3"
          style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)' }}>
          <ShieldCheck className="flex-shrink-0 mt-0.5" size={20} style={{ color: '#06B6D4' }} />
          <div>
            <h3 className="font-semibold text-genz-navy text-[14px] mb-1">Privacy by design</h3>
            <p className="text-genz-muted text-[13px] leading-relaxed">
              The website never receives tool passwords, cookies, or session data. The extension applies your
              authorized session locally and opens the tool — we never collect your browsing history or tab contents.
            </p>
          </div>
        </motion.div>

        {/* ── Footer CTAs ── */}
        <motion.div {...fade(0.32)} className="flex flex-wrap items-center justify-center gap-3">
          <Link to="/client/dashboard"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-semibold border border-genz-border text-genz-navy bg-white/60 hover:border-genz-teal/40 hover:-translate-y-0.5 transition-all">
            <CheckCircle2 size={16} /> Open Dashboard
          </Link>
          <Link to="/extension"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-[14px] text-[14px] font-semibold text-genz-muted hover:text-genz-teal transition-colors">
            <Puzzle size={16} /> How it works
          </Link>
        </motion.div>
      </div>
    </div>
  );
};

export default ChromeExtensionPage;

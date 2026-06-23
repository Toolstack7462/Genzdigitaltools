import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, MotionConfig, useReducedMotion } from 'framer-motion';
import {
  Mail, Lock, User, Eye, EyeOff, CheckCircle2, Loader2, ArrowRight,
  ShieldCheck, Zap, MessageCircle, Cpu, Sparkles,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import api from '../services/api';
import { classifyTransport, authDiag } from '../services/authDiagnostics';

const EASE_OUT = [0.16, 1, 0.3, 1];
const BRAND_CTA = 'linear-gradient(135deg,#2563EB 0%,#06B6D4 100%)';
const WHATSAPP_URL = 'https://wa.me/923027467462';

// Module-scope so it is a STABLE component type — defining it inside Join would
// remount the whole subtree each render and make inputs lose focus per keystroke.
const PageShell = ({ children }) => (
  <div className="relative overflow-hidden min-h-screen" style={{ background: 'var(--gradient-hero)' }}>
    <div className="aurora" aria-hidden="true" />
    <div className="dot-grid" aria-hidden="true" />
    <div className="relative z-10 mx-auto w-full max-w-6xl px-5 sm:px-6 lg:px-8 pt-24 sm:pt-28 pb-16 sm:pb-20 lg:pt-32">
      {children}
    </div>
  </div>
);

// Light glass feature tiles (Admin-console style) — SVG icons only, no emoji.
const FEATURE_TILES = [
  { Icon: Cpu,           label: 'Premium tools',   color: '#06B6D4' },
  { Icon: ShieldCheck,   label: 'Secure account',  color: '#2563EB' },
  { Icon: Zap,           label: 'Fast setup',      color: '#4F46E5' },
  { Icon: MessageCircle, label: 'WhatsApp support',color: '#0891B2' },
];
const TRUST_LINES = [
  '90+ premium tools in one membership',
  'Secure & private by design',
  'Trusted by creators & businesses',
];

const Join = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const reduce = useReducedMotion();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [verifyStep, setVerifyStep] = useState(false);
  const [otp, setOtp] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', password: '' });
  const [agreed, setAgreed] = useState(false);

  // Member signup belongs on the app subdomain. If a public-domain link (or a
  // client-side nav the domain guard can't catch) lands here on the main domain,
  // send the visitor to the real app signup flow.
  useEffect(() => {
    const MAIN_HOSTS = ['genzdigitalstore.com', 'www.genzdigitalstore.com'];
    if (MAIN_HOSTS.includes(window.location.hostname)) {
      window.location.replace('https://app.genzdigitalstore.com/client/signup');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!agreed) {
      showError('Please agree to the Terms of Service and Privacy Policy');
      return;
    }
    if (formData.password.length < 6) {
      showError('Password must be at least 6 characters');
      return;
    }
    try {
      setLoading(true);
      // The backend recycles periodically (shared hosting); during that ~1-2s window a
      // request can get NO response or a 502/503/504, which previously surfaced as
      // "Failed to create account". Retry such TRANSIENT failures. Registration is a
      // POST, so if a retry returns 409 "already exists" it means the FIRST attempt
      // actually succeeded (its response was just lost) — treat that as success and send
      // the user to login rather than showing an error.
      const payload = { fullName: formData.name, email: formData.email, password: formData.password };
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await api.post('/public/register', payload);
          break;
        } catch (err) {
          // A retry that now hits 409 means the FIRST attempt actually created the account
          // (its response was lost) — treat as success.
          if (attempt > 0 && err.response?.status === 409) {
            setSuccess(true);
            showSuccess('Your account is ready. Please log in.');
            setTimeout(() => navigate('/client/login'), 1800);
            return;
          }
          // Do NOT retry on a client-side timeout (ECONNABORTED): the server may have
          // already created the account, and re-sending could duplicate work. Only retry
          // when the request did not execute (connection failure / gateway error).
          const isTimeout = err.code === 'ECONNABORTED';
          const connFailed = err.request && !err.response && !isTimeout;
          const gateway = err.response && [502, 503, 504].includes(err.response.status);
          if (attempt < 2 && (connFailed || gateway)) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          throw err;
        }
      }
      if (response.data.success) {
        if (response.data.emailVerificationRequired) {
          setVerifyStep(true);
          showSuccess('Account created. Enter the code we emailed you.');
        } else {
          setSuccess(true);
          showSuccess('Account created successfully! You can now login.');
          setTimeout(() => navigate('/client/login'), 2000);
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const serverMsg = error.response?.data?.error;

      // Transport classification (no HTTP response): offline / timeout / API unreachable
      // -or-blocked. This is the device-specific path — signup sends no deviceId and uses
      // no storage, so when it fails on one device but works on another the cause is the
      // request never reaching the API (connectivity, device clock/cert, VPN/firewall/
      // extension block). Returns null when the server actually answered.
      const transport = classifyTransport(error);

      // Secret-free diagnostic (mirrors the login screen) so a member reporting a
      // signup failure can be told exactly which branch fired.
      console.error('[client-signup] failed:', authDiag(error));

      // Specific reason + [CODE] instead of a blanket "Server is busy".
      if (transport) {
        showError(transport.message);
      } else if (status === 409) {
        showError('An account with this email already exists. Please log in instead. [ACCOUNT_EXISTS]');
      } else if (status === 429) {
        showError('Too many attempts from your network. Please wait a few minutes, then try again. [TOO_MANY_ATTEMPTS]');
      } else if (status === 400) {
        showError((serverMsg || 'Please check your details and try again.') + ' [INVALID_DETAILS]');
      } else if (status >= 500) {
        showError('Something went wrong on our end while creating your account. Please try again in a moment. [SERVER_ERROR]');
      } else {
        showError((serverMsg || 'Server is busy right now. Please try again in a moment.') + ' [UNKNOWN]');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    const code = otp.trim();
    if (code.length !== 6) {
      showError('Enter the 6-digit code from your email');
      return;
    }
    try {
      setVerifying(true);
      await api.post('/auth/verify-email', { email: formData.email, code });
      setSuccess(true);
      showSuccess('Email verified! Redirecting to login…');
      setTimeout(() => navigate('/client/login'), 2000);
    } catch (error) {
      showError(error.response?.data?.error || 'Invalid or expired code');
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    try {
      setResending(true);
      await api.post('/auth/resend-verification', { email: formData.email });
      showSuccess('A new verification code is on its way.');
    } catch (error) {
      showError(error.response?.data?.error || 'Could not resend code');
    } finally {
      setResending(false);
    }
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const inputBase =
    'w-full pl-12 pr-4 py-3 bg-white border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted ' +
    'transition-all duration-200 focus:outline-none focus:border-genz-blue focus:ring-2 focus:ring-genz-blue/20';

  // ── SUCCESS ─────────────────────────────────────────────────────────────────
  if (success) {
    return (
      <PageShell>
        <div className="max-w-md w-full mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT }}
            className="glass rounded-[24px] p-8 text-center depth"
          >
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
                 style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.28)' }}>
              <CheckCircle2 size={40} className="text-emerald-500" />
            </div>
            <h2 className="text-2xl font-bold mb-3 text-genz-navy">Account created!</h2>
            <p className="text-genz-muted mb-7">Your account is ready. Redirecting you to login…</p>
            <Link to="/client/login"
              className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-[14px] font-bold text-white transition-all hover:-translate-y-0.5"
              style={{ background: BRAND_CTA, boxShadow: '0 10px 24px rgba(37,99,235,0.28)' }}>
              Go to Login <ArrowRight size={16} />
            </Link>
          </motion.div>
        </div>
      </PageShell>
    );
  }

  // ── EMAIL VERIFY ──────────────────────────────────────────────────────────
  if (verifyStep) {
    return (
      <PageShell>
        <div className="max-w-md w-full mx-auto">
          <div className="text-center mb-7">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-genz-navy mb-2 tracking-tight">Verify your email</h1>
            <p className="text-genz-muted">
              We sent a 6-digit code to <span className="font-semibold text-genz-navy">{formData.email}</span>
            </p>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT }}
            className="glass rounded-[24px] p-8 depth"
          >
            <form onSubmit={handleVerify} className="space-y-6">
              <div>
                <label htmlFor="otp" className="block text-sm font-semibold text-genz-navy mb-2">Verification code</label>
                <input
                  type="text" id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] font-bold bg-white border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-blue focus:ring-2 focus:ring-genz-blue/20 transition-all"
                  placeholder="000000" data-testid="join-otp-input" autoFocus
                />
                <p className="text-xs text-genz-muted mt-1.5">The code expires in 10 minutes.</p>
              </div>
              <button
                type="submit" disabled={verifying} data-testid="join-verify-btn"
                className="w-full flex items-center justify-center gap-2 py-3 rounded-[14px] font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:translate-y-0"
                style={{ background: BRAND_CTA, boxShadow: '0 10px 24px rgba(37,99,235,0.28)' }}>
                {verifying ? <><Loader2 size={17} className="animate-spin" /> Verifying…</> : <>Verify email <ArrowRight size={16} /></>}
              </button>
            </form>
            <div className="mt-6 text-center space-y-2">
              <button type="button" onClick={handleResend} disabled={resending} data-testid="join-resend-btn"
                className="text-genz-blue hover:text-genz-cyan font-semibold text-sm disabled:opacity-50 transition-colors">
                {resending ? 'Sending…' : "Didn't get it? Resend code"}
              </button>
              <p className="text-genz-muted text-sm">
                <Link to="/client/login" className="text-genz-muted hover:text-genz-blue transition-colors">Skip for now and log in</Link>
              </p>
            </div>
          </motion.div>
        </div>
      </PageShell>
    );
  }

  // ── SIGNUP (premium split layout) ────────────────────────────────────────
  const floatT = (delay = 0) => (reduce ? {} : {
    animate: { y: [0, -10, 0] },
    transition: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay },
  });

  return (
    <MotionConfig reducedMotion="user">
      <PageShell>
        <div className="grid lg:grid-cols-2 gap-10 xl:gap-16 items-center">

          {/* ── LEFT: light glass brand deck (Admin-console style, desktop) ── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_OUT }}
            className="relative hidden lg:flex items-center justify-center"
          >
            <div className="stage-3d w-full max-w-md">
              <svg className="absolute -inset-8 w-[118%] h-[118%] ribbon-glow opacity-90 pointer-events-none" viewBox="0 0 520 460" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="joinRb" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#2563EB" /><stop offset="0.5" stopColor="#06B6D4" /><stop offset="1" stopColor="#14B8A6" />
                  </linearGradient>
                </defs>
                <path d="M-20 130 C 120 50, 260 230, 540 100" stroke="url(#joinRb)" strokeWidth="16" strokeLinecap="round" opacity="0.5" />
                <path d="M-20 350 C 160 300, 300 430, 560 320" stroke="url(#joinRb)" strokeWidth="11" strokeLinecap="round" opacity="0.35" />
              </svg>

              <div className="deck-3d relative">
                <div className="glass-tint layer-back rounded-[28px] absolute inset-0" style={{ transform: 'translateZ(-70px) translate(30px,-16px)' }} />
                <div className="glass layer-mid relative rounded-[28px] p-7">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-genz-blue mb-1.5">Premium Digital Platform</p>
                  <h2 className="text-[22px] font-extrabold text-genz-navy leading-tight tracking-tight mb-5">Join Gen Z Digital Store</h2>

                  <div className="grid grid-cols-2 gap-3 mb-5">
                    {FEATURE_TILES.map(({ Icon, label, color }) => (
                      <div key={label} className="sheen rounded-2xl px-3.5 py-3 flex items-center gap-2.5"
                        style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}>
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                          style={{ background: `${color}16`, color, border: `1px solid ${color}2e` }}><Icon size={15} /></span>
                        <span className="text-[12.5px] font-bold text-genz-navy leading-tight">{label}</span>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2.5">
                    {TRUST_LINES.map(t => (
                      <div key={t} className="flex items-center gap-2 text-[13.5px] text-genz-navy/80">
                        <ShieldCheck size={15} className="text-genz-blue flex-shrink-0" /> {t}
                      </div>
                    ))}
                  </div>
                </div>

                {/* floating light glass chips */}
                <motion.div {...floatT(0)}
                  className="glass pop-3 absolute -right-7 top-10 flex items-center gap-2.5 rounded-2xl px-4 py-3 depth-cyan">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: BRAND_CTA }}>
                    <Sparkles size={16} />
                  </span>
                  <div>
                    <div className="text-[12px] font-bold text-genz-navy leading-none">90+ tools</div>
                    <div className="text-[11px] text-genz-muted mt-0.5">one membership</div>
                  </div>
                </motion.div>
                <motion.div {...floatT(1.2)}
                  className="glass pop-2 absolute -left-6 bottom-10 flex items-center gap-2.5 rounded-2xl px-4 py-3 depth">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2' }}>
                    <ShieldCheck size={16} />
                  </span>
                  <div>
                    <div className="text-[12px] font-bold text-genz-navy leading-none">Secure account</div>
                    <div className="text-[11px] text-genz-muted mt-0.5">private &amp; protected</div>
                  </div>
                </motion.div>
              </div>
            </div>
          </motion.div>

          {/* ── RIGHT: signup form card ── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_OUT, delay: 0.08 }}
            className="w-full max-w-md mx-auto lg:mx-0"
          >
            {/* Brand header — the navbar already shows the logo, so the form leads
                straight with the heading (no redundant small logo). */}
            <div className="text-center lg:text-left mb-6">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-genz-navy tracking-tight mb-1.5" data-testid="join-page-heading">
                Create your account
              </h1>
              <p className="text-genz-muted text-[15px]">Start your journey with unlimited tools.</p>
            </div>

            <div className="glass rounded-[24px] p-7 sm:p-8 depth">
              <motion.form
                onSubmit={handleSubmit}
                className="space-y-5"
                initial="hidden" animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.12 } } }}
              >
                {/* Full name */}
                <motion.div variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}>
                  <label htmlFor="name" className="block text-sm font-semibold text-genz-navy mb-2">Full name</label>
                  <div className="relative">
                    <User className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={19} />
                    <input type="text" id="name" name="name" required autoComplete="name"
                      value={formData.name} onChange={handleChange} className={inputBase}
                      placeholder="John Doe" data-testid="join-name-input" />
                  </div>
                </motion.div>

                {/* Email */}
                <motion.div variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}>
                  <label htmlFor="email" className="block text-sm font-semibold text-genz-navy mb-2">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={19} />
                    <input type="email" id="email" name="email" required autoComplete="email"
                      value={formData.email} onChange={handleChange} className={inputBase}
                      placeholder="you@example.com" data-testid="join-email-input" />
                  </div>
                </motion.div>

                {/* Password */}
                <motion.div variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}>
                  <label htmlFor="password" className="block text-sm font-semibold text-genz-navy mb-2">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={19} />
                    <input type={showPassword ? 'text' : 'password'} id="password" name="password" required minLength={6}
                      autoComplete="new-password" value={formData.password} onChange={handleChange}
                      className={inputBase.replace('pr-4', 'pr-12')} placeholder="••••••••" data-testid="join-password-input" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-blue transition-colors p-1">
                      {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                    </button>
                  </div>
                  <p className="text-xs text-genz-muted mt-1.5">Minimum 6 characters.</p>
                </motion.div>

                {/* Agree */}
                <motion.label variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}
                  className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded accent-genz-blue" data-testid="join-agree-checkbox" />
                  <span className="text-[13px] text-genz-muted leading-relaxed">
                    I agree to the{' '}
                    <a href="https://genzdigitalstore.com/contact" target="_blank" rel="noopener noreferrer" className="text-genz-blue hover:underline font-medium">Terms of Service</a>{' '}and{' '}
                    <a href="https://genzdigitalstore.com/contact" target="_blank" rel="noopener noreferrer" className="text-genz-blue hover:underline font-medium">Privacy Policy</a>
                  </span>
                </motion.label>

                {/* Submit */}
                <motion.button
                  variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}
                  type="submit" disabled={loading} data-testid="join-submit-btn"
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[14px] font-bold text-white text-[15px] transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-blue/50 focus-visible:ring-offset-2"
                  style={{ background: BRAND_CTA, boxShadow: '0 12px 28px rgba(37,99,235,0.30)' }}>
                  {loading ? <><Loader2 size={18} className="animate-spin" /> Creating account…</> : <>Create account <ArrowRight size={16} /></>}
                </motion.button>
              </motion.form>

              <div className="mt-6 text-center">
                <p className="text-genz-muted text-sm">
                  Already have an account?{' '}
                  <Link to="/client/login" className="text-genz-blue hover:text-genz-cyan font-semibold transition-colors">Log in</Link>
                </p>
              </div>
            </div>

            {/* Trust microcopy — SVG icons, no emoji */}
            <div className="mt-6 flex flex-wrap items-center justify-center lg:justify-start gap-x-5 gap-y-2 text-[12.5px] text-genz-muted">
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-genz-teal" /> Instant access</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-genz-teal" /> No credit card</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-genz-teal" /> Cancel anytime</span>
              <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-emerald-600 hover:text-emerald-700 font-semibold transition-colors">
                <MessageCircle size={14} /> WhatsApp support
              </a>
            </div>
          </motion.div>
        </div>
      </PageShell>
    </MotionConfig>
  );
};

export default Join;

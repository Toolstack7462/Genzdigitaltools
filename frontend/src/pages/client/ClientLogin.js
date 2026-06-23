import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Lock, Mail, Eye, EyeOff, Shield, ArrowRight, Sparkles,
  Cpu, Globe, Palette, Instagram, Rocket, CheckCircle2,
} from 'lucide-react';
import { authService } from '../../services/authService';
import { classifyTransport, authDiag } from '../../services/authDiagnostics';
import { useToast } from '../../components/Toast';
import BrandLogo from '../../components/BrandLogo';

const HUB = [
  { icon: Cpu, label: 'Digital Tools', color: '#06B6D4' },
  { icon: Globe, label: 'Websites', color: '#2563EB' },
  { icon: Palette, label: 'Branding', color: '#4F46E5' },
  { icon: Instagram, label: 'Social Media', color: '#0891B2' },
];

const ClientLogin = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const reduce = useReducedMotion();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Hard guard against duplicate submits: the disabled button covers most cases, but a
  // ref blocks a second submit fired in the same tick (double-click / Enter+click) before
  // React re-renders the disabled state — so only ONE login request is ever in flight.
  const submittingRef = useRef(false);

  // ── Auth logic unchanged ───────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return; // ignore repeat clicks while a request is in flight
    submittingRef.current = true;
    setLoading(true); // show the spinner instantly, before any async work
    try {
      const deviceId = authService.getOrCreateDeviceId();
      // Defensive: getOrCreateDeviceId always returns an id (it falls back to an
      // in-memory one when storage is blocked), but if it ever comes back empty the
      // backend would reject the login with a vague 400 — surface the precise reason.
      if (!deviceId) {
        console.error('[client-login] aborted:', authDiag({}, { reason: 'device_id_missing' }));
        showError('Your browser could not create a secure device ID for sign-in. Please enable cookies/site data (or leave private mode) and try again. [DEVICE_ID_MISSING]');
        return;
      }
      const { os, browser } = authService.getDeviceInfo();
      await authService.clientLogin(formData.email, formData.password, deviceId, {
        deviceFingerprint: authService.getDeviceFingerprint(),
        os,
        browser,
      });
      showSuccess('Welcome back to Gen Z Digital Store!');
      navigate('/client/dashboard');
    } catch (error) {
      const status = error.response?.status;
      const code = error.response?.data?.code;
      const serverMsg = error.response?.data?.error;

      // Whether this browser can persist site data at all. When it CANNOT,
      // getOrCreateDeviceId() falls back to an in-memory id and may even fail before a
      // request is sent — that path has no status/response, so without this check it
      // would masquerade as a generic failure.
      const storageOk = authService.isStorageAvailable();

      // Transport-level classification (no HTTP response): offline / timeout / API
      // unreachable-or-blocked. Returns null when the server actually answered, so the
      // status-based branches below still own those cases. This is the device-specific
      // path — it is what makes a one-device "Login failed" identifiable.
      const transport = classifyTransport(error);

      // Console diagnostic (no secrets) so a member reporting "Login failed" can be
      // told exactly which branch fired. `hadResponse=false` means the request never
      // got a reply (network / CORS / cert / timeout); `status` present means the
      // server answered and the message reflects its actual reason.
      console.error('[client-login] failed:', authDiag(error, { storageAvailable: storageOk }));

      // Each branch shows a CLEAR reason plus a short [CODE] so the exact problem is
      // identifiable at a glance (by the member and by support) instead of a vague
      // "Login failed". The bracketed code mirrors the backend reason.
      if (transport) {
        // Network / connection / timeout failure — the request never reached the API.
        // Surface this BEFORE the storage hint: when the server was never contacted,
        // a "cookies blocked" message would be misleading (the real fix is connectivity,
        // device clock, or an extension/VPN/firewall block). [API_CONNECTION_FAILED]/[TIMEOUT]
        showError(transport.message);
      } else if (!storageOk) {
        // The browser is blocking cookies/site data, so device binding can't be stored.
        // Reached only when the server DID answer but persistence is impossible.
        showError('This browser is blocking cookies & site data, which secure sign-in and device binding require. Please allow cookies/site data for this site (or leave private/incognito mode), then try again. [DEVICE_STORAGE_BLOCKED]');
      } else if (status === 429) {
        showError('Too many login attempts from your network. Please wait a few minutes, then try again. [TOO_MANY_ATTEMPTS]');
      } else if (code === 'DEVICE_PENDING') {
        showError('New device detected. Your account is locked to one device — ask the admin to approve THIS device, then sign in again. [NEW_DEVICE_PENDING]');
      } else if (code === 'DEVICE_BLOCKED' || code === 'DEVICE_MISMATCH') {
        showError('This device is not approved for your account. Ask the admin to approve or reset your device. [DEVICE_BLOCKED]');
      } else if (status === 401) {
        // The server received the request and rejected it → genuinely wrong credentials.
        showError('Incorrect email or password. Please check them and try again. [WRONG_CREDENTIALS]');
      } else if (status === 403) {
        showError((serverMsg || 'Your account cannot sign in right now. Please contact support.') + ' [ACCESS_DENIED]');
      } else if (status === 400) {
        // Validation rejected the request (e.g. missing/invalid device payload).
        showError((serverMsg || 'Your login could not be processed. Please refresh the page and try again.') + ' [DEVICE_PAYLOAD_INVALID]');
      } else if (status >= 500) {
        // Server was reached but errored — this is NOT a wrong-password situation.
        showError('Something went wrong on our end while signing you in. Please try again in a moment. [SERVER_ERROR]');
      } else {
        showError((serverMsg || 'Login failed. Please try again.') + ' [UNKNOWN]');
      }
    } finally {
      // Always reset so the user can retry after a failure.
      setLoading(false);
      submittingRef.current = false;
    }
  };
  // ───────────────────────────────────────────────────────────────────────

  const ease = [0.16, 1, 0.3, 1];
  const fade = (d = 0) => (reduce ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, ease, delay: d } });

  const inputClass =
    'w-full rounded-[14px] border border-genz-border bg-white py-3 text-[15px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all duration-200 focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12';

  return (
    <div className="relative min-h-dvh overflow-hidden" style={{ background: 'var(--gradient-hero)' }}>
      <div className="aurora" />
      <div className="dot-grid" />

      <div className="relative z-10 min-h-dvh grid lg:grid-cols-2">
        {/* ── LEFT: 3D glass service visual (desktop) ── */}
        <div className="hidden lg:flex items-center justify-center p-12">
          <motion.div {...fade(0.05)} className="stage-3d w-full max-w-md">
            <svg className="absolute -inset-8 w-[118%] h-[118%] ribbon-glow opacity-90 pointer-events-none" viewBox="0 0 520 460" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="lrb1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2563EB" /><stop offset="0.5" stopColor="#06B6D4" /><stop offset="1" stopColor="#14B8A6" /></linearGradient>
              </defs>
              <path d="M-20 130 C 120 50, 260 230, 540 100" stroke="url(#lrb1)" strokeWidth="16" strokeLinecap="round" opacity="0.5" />
              <path d="M-20 350 C 160 300, 300 430, 560 320" stroke="url(#lrb1)" strokeWidth="11" strokeLinecap="round" opacity="0.35" />
            </svg>

            <div className="deck-3d relative">
              <div className="glass-tint layer-back rounded-[28px] absolute inset-0" style={{ transform: 'translateZ(-70px) translate(30px,-16px)' }} />
              <div className="glass layer-mid relative rounded-[28px] p-7">
                <div className="flex items-center gap-3 mb-6">
                  <BrandLogo size="lg" glow />
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-genz-blue">Member Portal</p>
                    <h2 className="text-[17px] font-bold text-genz-navy leading-tight">Your premium workspace</h2>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-5">
                  {HUB.map(({ icon: Icon, label, color }) => (
                    <div key={label} className="sheen rounded-2xl px-3.5 py-3 flex items-center gap-2.5" style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${color}16`, color, border: `1px solid ${color}2e` }}><Icon size={15} /></span>
                      <span className="text-[12.5px] font-bold text-genz-navy">{label}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2.5">
                  {['Secure one-click tool access', 'Track services & orders', 'Manage your membership'].map(t => (
                    <div key={t} className="flex items-center gap-2 text-[13.5px] text-genz-navy/80">
                      <CheckCircle2 size={15} className="text-genz-blue flex-shrink-0" /> {t}
                    </div>
                  ))}
                </div>
              </div>
              <div className="glass pop-3 float-a absolute -right-7 top-12 flex items-center gap-2.5 rounded-2xl px-4 py-3 depth-cyan">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}><Rocket size={16} /></span>
                <div><div className="text-[12px] font-bold text-genz-navy leading-none">90+ tools</div><div className="text-[11px] text-genz-muted mt-0.5">ready to use</div></div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* ── RIGHT: login card ── */}
        <div className="flex items-center justify-center p-5 sm:p-8">
          <motion.div {...fade(0.12)} className="w-full max-w-md">
            <div className="text-center mb-7">
              <Link to="/" className="lg:hidden inline-block mb-5" aria-label="Gen Z Digital Store home"><BrandLogo size="2xl" glow /></Link>
              <h1 className="font-heading text-[32px] sm:text-[36px] font-extrabold text-genz-navy mb-2 tracking-tight">Member Portal</h1>
              <p className="text-genz-muted text-[15px] max-w-sm mx-auto leading-relaxed">Securely access your premium tools, services, and client dashboard.</p>
            </div>

            <div className="glass rounded-[24px] p-7 sm:p-8 depth">
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label htmlFor="client-email" className="block text-[14px] font-semibold text-genz-navy mb-2">Email Address</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                    <input id="client-email" type="email" required autoComplete="email" value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className={`${inputClass} pl-11 pr-4`} placeholder="your@email.com" data-testid="email-input" />
                  </div>
                </div>

                <div>
                  <label htmlFor="client-password" className="block text-[14px] font-semibold text-genz-navy mb-2">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                    <input id="client-password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className={`${inputClass} pl-11 pr-12`} placeholder="Enter your password" data-testid="password-input" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-blue transition-colors p-1 rounded-md">
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 p-3 rounded-xl" style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)' }}>
                  <Shield size={15} className="flex-shrink-0" style={{ color: '#06B6D4' }} />
                  <p className="text-[12.5px] text-genz-navy/70">Secure sign-in — your device is safely linked to your account.</p>
                </div>

                <button type="submit" disabled={loading} data-testid="login-button"
                  className="btn-grad w-full py-3.5 text-[15px] font-bold rounded-[14px] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
                  {loading ? (<><span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Signing In…</>) : (<>Sign In to Dashboard <ArrowRight size={16} /></>)}
                </button>
              </form>

              <div className="mt-6 pt-5 border-t border-genz-border text-center space-y-2.5">
                <Link to="/forgot-password" className="block text-[14px] text-genz-blue hover:underline font-semibold">Forgot your password?</Link>
                <Link to="/join" className="block text-[14px] text-genz-blue hover:underline font-semibold">Don't have an account? Get Membership</Link>
                <Link to="/" className="block text-[14px] text-genz-muted hover:text-genz-blue transition-colors">← Back to Gen Z Digital Store</Link>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              {[[Shield, 'Encrypted tokens'], [Sparkles, 'Premium tools'], [CheckCircle2, 'Device binding']].map(([Icon, label]) => (
                <div key={label} className="flex items-center gap-1.5 text-genz-muted text-[12.5px]"><Icon size={13} style={{ color: '#06B6D4' }} /> {label}</div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default ClientLogin;

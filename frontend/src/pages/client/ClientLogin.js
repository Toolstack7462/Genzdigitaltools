import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Lock, Mail, Eye, EyeOff, Smartphone, Shield, ArrowRight, Sparkles } from 'lucide-react';
import { authService } from '../../services/authService';
import { useToast } from '../../components/Toast';
import BrandLogo from '../../components/BrandLogo';

const TRUST = [
  { icon: Shield, label: 'Encrypted tokens' },
  { icon: Smartphone, label: 'Device binding' },
  { icon: Sparkles, label: 'Premium tools' },
];

const ClientLogin = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const reduce = useReducedMotion();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── Auth logic unchanged ───────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const deviceId = authService.getOrCreateDeviceId();
      await authService.clientLogin(formData.email, formData.password, deviceId);
      showSuccess('Welcome back to Gen Z Digital Store!');
      navigate('/client/dashboard');
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Login failed';
      if (error.response?.data?.code === 'DEVICE_MISMATCH') {
        showError('This account is locked to another device. Contact admin to reset.');
      } else {
        showError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };
  // ───────────────────────────────────────────────────────────────────────

  const ease = [0.16, 1, 0.3, 1];
  const fade = (delay = 0) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.55, ease, delay },
        };

  const inputClass =
    'w-full rounded-[14px] border border-genz-border bg-white py-3 text-[15px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all duration-200 focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12';

  return (
    <div
      className="relative min-h-dvh flex items-center justify-center p-5 overflow-hidden"
      style={{ background: 'var(--gradient-hero)' }}
    >
      {/* Soft brand glows */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(40rem 40rem at 15% 10%, rgba(37,99,235,0.10), transparent 60%),' +
            'radial-gradient(36rem 36rem at 85% 90%, rgba(6,182,212,0.12), transparent 60%)',
        }}
      />

      <motion.div {...fade(0)} className="w-full max-w-md relative z-10">
        {/* Logo & Title */}
        <div className="text-center mb-7">
          <Link to="/" className="inline-block mb-5" aria-label="Gen Z Digital Store home">
            <BrandLogo size="xl" />
          </Link>
          <motion.h1
            {...fade(0.08)}
            className="font-heading text-[32px] sm:text-[36px] font-extrabold text-genz-navy mb-2 tracking-tight"
          >
            Member Portal
          </motion.h1>
          <motion.p {...fade(0.14)} className="text-genz-muted text-[15px] max-w-sm mx-auto leading-relaxed">
            Securely access your premium tools, services, and client dashboard.
          </motion.p>
        </div>

        {/* Login Card */}
        <motion.div
          {...fade(0.2)}
          className="bg-white rounded-[24px] p-7 sm:p-8"
          style={{ border: '1px solid var(--brand-border)', boxShadow: '0 24px 60px rgba(7,27,51,0.10)' }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label htmlFor="client-email" className="block text-[14px] font-semibold text-genz-navy mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                <input
                  id="client-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={`${inputClass} pl-11 pr-4`}
                  placeholder="your@email.com"
                  data-testid="email-input"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="client-password" className="block text-[14px] font-semibold text-genz-navy mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                <input
                  id="client-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className={`${inputClass} pl-11 pr-12`}
                  placeholder="Enter your password"
                  data-testid="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-blue transition-colors p-1 rounded-md"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Secure notice row */}
            <div
              className="flex items-center gap-2.5 p-3 rounded-xl"
              style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)' }}
            >
              <Shield size={15} className="flex-shrink-0" style={{ color: '#06B6D4' }} />
              <p className="text-[12.5px] text-genz-navy/70">Secure sign-in — your device is safely linked to your account.</p>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 text-[15px] font-bold text-white rounded-[14px] flex items-center justify-center gap-2 transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:translate-y-0"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 28px rgba(37,99,235,0.28)' }}
              data-testid="login-button"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  Signing In…
                </>
              ) : (
                <>
                  Sign In to Dashboard
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Footer Links */}
          <div className="mt-6 pt-5 border-t border-genz-border text-center space-y-2.5">
            <Link to="/join" className="block text-[14px] text-genz-blue hover:underline font-semibold">
              Don't have an account? Get Membership
            </Link>
            <Link to="/" className="block text-[14px] text-genz-muted hover:text-genz-blue transition-colors">
              ← Back to Gen Z Digital Store
            </Link>
          </div>
        </motion.div>

        {/* Trust row */}
        <motion.div {...fade(0.28)} className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {TRUST.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-genz-muted text-[12.5px]">
              <Icon size={13} style={{ color: '#06B6D4' }} />
              {label}
            </div>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
};

export default ClientLogin;

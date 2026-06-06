import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Lock, Mail, Eye, EyeOff, Smartphone, Shield, ArrowRight, Sparkles } from 'lucide-react';
import { authService } from '../../services/authService';
import { useToast } from '../../components/Toast';
import GenZDigitalStoreLogo from '../../components/GenZDigitalStoreLogo';

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
          initial: { opacity: 0, y: 20 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, ease, delay },
        };

  return (
    <div
      className="relative min-h-dvh flex items-center justify-center p-4 overflow-hidden"
      style={{ background: 'linear-gradient(160deg,#000820 0%,#001030 55%,#000820 100%)' }}
    >
      {/* Layered premium background */}
      <div className="mesh-bg" aria-hidden="true" />
      <div className="hero-grid absolute inset-0 opacity-40 pointer-events-none" aria-hidden="true" />
      <div className="noise-overlay" aria-hidden="true" />

      <motion.div {...fade(0)} className="w-full max-w-md relative z-10">
        {/* Logo & Title */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-7" aria-label="Gen Z Digital Store home">
            <GenZDigitalStoreLogo className="h-11 justify-center" textSize="2xl" />
          </Link>
          <motion.h1
            {...fade(0.08)}
            className="text-3xl sm:text-4xl font-extrabold text-white mb-2.5 tracking-tight"
            style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
          >
            Member Portal
          </motion.h1>
          <motion.p {...fade(0.14)} className="text-white/55 text-sm sm:text-base max-w-sm mx-auto leading-relaxed">
            Securely access your premium tools, services, and client dashboard.
          </motion.p>
        </div>

        {/* Login Card */}
        <motion.div
          {...fade(0.2)}
          className="card-premium p-7 sm:p-8"
          style={{ background: 'rgba(0,175,193,0.06)', borderColor: 'rgba(0,175,193,0.18)' }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label htmlFor="client-email" className="block text-sm font-medium text-white/90 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/55 pointer-events-none" size={18} />
                <input
                  id="client-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="input-premium w-full pl-11 pr-4 py-3"
                  placeholder="your@email.com"
                  data-testid="email-input"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="client-password" className="block text-sm font-medium text-white/90 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/55 pointer-events-none" size={18} />
                <input
                  id="client-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="input-premium w-full pl-11 pr-12 py-3"
                  placeholder="Enter your password"
                  data-testid="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/55 hover:text-genz-teal transition-colors p-1 rounded-md"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Device Notice */}
            <div
              className="flex items-center gap-2.5 p-3 rounded-xl"
              style={{ background: 'rgba(0,175,193,0.08)', border: '1px solid rgba(0,175,193,0.2)' }}
            >
              <Smartphone size={15} className="text-genz-teal flex-shrink-0" />
              <p className="text-xs text-genz-teal/90">Your device is securely linked to your account.</p>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3.5 font-bold rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="login-button"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-genz-deep-navy/40 border-t-genz-deep-navy animate-spin" />
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
          <div className="mt-6 pt-5 border-t text-center space-y-2.5" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            <Link to="/join" className="block text-sm text-genz-teal hover:underline font-medium">
              Don't have an account? Get Membership
            </Link>
            <Link to="/" className="block text-sm text-white/55 hover:text-genz-teal transition-colors">
              ← Back to Gen Z Digital Store
            </Link>
          </div>
        </motion.div>

        {/* Trust row */}
        <motion.div {...fade(0.28)} className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {TRUST.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-white/55 text-xs">
              <Icon size={13} className="text-genz-teal/70" />
              {label}
            </div>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
};

export default ClientLogin;

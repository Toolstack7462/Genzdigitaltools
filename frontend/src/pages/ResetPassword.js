import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../components/Toast';
import BrandLogo from '../components/BrandLogo';
import PasswordInput from '../components/PasswordInput';

const ResetPassword = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 8) {
      showError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      showError('Passwords do not match');
      return;
    }
    try {
      setLoading(true);
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => navigate('/client/login'), 2500);
    } catch (error) {
      showError(error.response?.data?.error || 'Could not reset password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full rounded-[14px] border border-genz-border bg-white py-3 pl-11 pr-12 text-[15px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all duration-200 focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12';

  return (
    <div className="relative min-h-dvh overflow-hidden flex items-center justify-center p-5" style={{ background: 'var(--gradient-hero)' }}>
      <div className="aurora" />
      <div className="dot-grid" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-7">
          <Link to="/" className="inline-block mb-5" aria-label="Gen Z Digital Store home"><BrandLogo size="2xl" glow /></Link>
          <h1 className="font-heading text-[30px] sm:text-[34px] font-extrabold text-genz-navy mb-2 tracking-tight">Reset password</h1>
          <p className="text-genz-muted text-[15px] max-w-sm mx-auto leading-relaxed">Choose a new password for your account.</p>
        </div>

        <div className="glass rounded-[24px] p-7 sm:p-8 depth">
          {!token ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-amber-500/15 rounded-full flex items-center justify-center mx-auto mb-5">
                <AlertTriangle size={32} className="text-amber-500" />
              </div>
              <h2 className="text-[18px] font-bold text-genz-navy mb-2">Invalid reset link</h2>
              <p className="text-genz-muted text-[14px] mb-6">This link is missing its token. Please request a new password reset.</p>
              <Link to="/forgot-password" className="btn-grad inline-flex items-center justify-center gap-2 px-6 py-3 rounded-[14px] text-[15px] font-bold">
                Request new link <ArrowRight size={16} />
              </Link>
            </div>
          ) : done ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-green-500/15 rounded-full flex items-center justify-center mx-auto mb-5">
                <CheckCircle2 size={34} className="text-green-500" />
              </div>
              <h2 className="text-[18px] font-bold text-genz-navy mb-2">Password updated</h2>
              <p className="text-genz-muted text-[14px] mb-6">Your password has been reset. Redirecting you to login…</p>
              <Link to="/client/login" className="btn-grad inline-flex items-center justify-center gap-2 px-6 py-3 rounded-[14px] text-[15px] font-bold">
                Go to login <ArrowRight size={16} />
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="rp-pass" className="block text-[14px] font-semibold text-genz-navy mb-2">New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none z-10" size={18} />
                  <PasswordInput id="rp-pass" required autoComplete="new-password" value={password}
                    onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="At least 8 characters" data-testid="reset-password-input" />
                </div>
              </div>
              <div>
                <label htmlFor="rp-confirm" className="block text-[14px] font-semibold text-genz-navy mb-2">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none z-10" size={18} />
                  <PasswordInput id="rp-confirm" required autoComplete="new-password" value={confirm}
                    onChange={(e) => setConfirm(e.target.value)} className={inputClass} placeholder="Re-enter your new password" data-testid="reset-confirm-input" />
                </div>
              </div>
              <button type="submit" disabled={loading} data-testid="reset-submit"
                className="btn-grad w-full py-3.5 text-[15px] font-bold rounded-[14px] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
                {loading ? (<><span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Updating…</>) : (<>Reset password <ArrowRight size={16} /></>)}
              </button>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-genz-border text-center">
            <Link to="/client/login" className="text-[14px] text-genz-muted hover:text-genz-blue transition-colors">← Back to login</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResetPassword;

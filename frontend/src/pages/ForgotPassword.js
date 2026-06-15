import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowRight, CheckCircle2, ArrowLeft } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../components/Toast';
import BrandLogo from '../components/BrandLogo';

const ForgotPassword = () => {
  const { showError } = useToast();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) {
      showError('Please enter your email address');
      return;
    }
    try {
      setLoading(true);
      await api.post('/auth/forgot-password', { email: email.trim() });
      // Always show the same confirmation — we never reveal whether an account exists.
      setSent(true);
    } catch (error) {
      showError(error.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full rounded-[14px] border border-genz-border bg-white py-3 pl-11 pr-4 text-[15px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all duration-200 focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12';

  return (
    <div className="relative min-h-dvh overflow-hidden flex items-center justify-center p-5" style={{ background: 'var(--gradient-hero)' }}>
      <div className="aurora" />
      <div className="dot-grid" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-7">
          <Link to="/" className="inline-block mb-5" aria-label="Gen Z Digital Store home"><BrandLogo size="2xl" glow /></Link>
          <h1 className="font-heading text-[30px] sm:text-[34px] font-extrabold text-genz-navy mb-2 tracking-tight">Forgot password?</h1>
          <p className="text-genz-muted text-[15px] max-w-sm mx-auto leading-relaxed">
            Enter your account email and we'll send you a link to reset your password.
          </p>
        </div>

        <div className="glass rounded-[24px] p-7 sm:p-8 depth">
          {sent ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-green-500/15 rounded-full flex items-center justify-center mx-auto mb-5">
                <CheckCircle2 size={34} className="text-green-500" />
              </div>
              <h2 className="text-[18px] font-bold text-genz-navy mb-2">Check your inbox</h2>
              <p className="text-genz-muted text-[14px] mb-6">
                If an account exists for <span className="font-semibold text-genz-navy">{email.trim()}</span>, a password
                reset link is on its way. The link expires in 30 minutes.
              </p>
              <Link to="/client/login" className="btn-grad inline-flex items-center justify-center gap-2 px-6 py-3 rounded-[14px] text-[15px] font-bold">
                Back to login <ArrowRight size={16} />
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="fp-email" className="block text-[14px] font-semibold text-genz-navy mb-2">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                  <input id="fp-email" type="email" required autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="your@email.com" data-testid="forgot-email-input" />
                </div>
              </div>
              <button type="submit" disabled={loading} data-testid="forgot-submit"
                className="btn-grad w-full py-3.5 text-[15px] font-bold rounded-[14px] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
                {loading ? (<><span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Sending…</>) : (<>Send reset link <ArrowRight size={16} /></>)}
              </button>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-genz-border text-center">
            <Link to="/client/login" className="inline-flex items-center gap-1.5 text-[14px] text-genz-muted hover:text-genz-blue transition-colors">
              <ArrowLeft size={15} /> Back to login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;

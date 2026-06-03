import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, Smartphone, Shield } from 'lucide-react';
import { authService } from '../../services/authService';
import { useToast } from '../../components/Toast';
import GenZDigitalStoreLogo from '../../components/GenZDigitalStoreLogo';

const ClientLogin = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: 'linear-gradient(135deg, #000820 0%, #001030 50%, #000820 100%)' }}>
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/3 right-1/3 w-96 h-96 rounded-full"
             style={{ background: 'radial-gradient(circle, rgba(0,175,193,0.12) 0%, transparent 70%)', filter: 'blur(60px)' }} />
      </div>

      <div className="max-w-md w-full relative z-10">
        {/* Logo & Title */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-6">
            <GenZDigitalStoreLogo className="h-12 justify-center" textSize="2xl" />
          </Link>
          <h1 className="text-3xl font-black text-white mb-2">Member Portal</h1>
          <p className="text-genz-muted">Access your premium digital tools</p>
        </div>

        {/* Login Card */}
        <div className="p-8 rounded-2xl border shadow-2xl"
             style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-white placeholder-genz-muted focus:outline-none transition-all"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }}
                  placeholder="your@email.com"
                  data-testid="email-input"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full pl-10 pr-12 py-3 rounded-xl text-white placeholder-genz-muted focus:outline-none transition-all"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }}
                  placeholder="Enter your password"
                  data-testid="password-input"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-white transition-colors">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Device Notice */}
            <div className="flex items-center gap-2 p-3 rounded-lg"
                 style={{ background: 'rgba(0,175,193,0.08)', border: '1px solid rgba(0,175,193,0.2)' }}>
              <Smartphone size={14} className="text-genz-teal flex-shrink-0" />
              <p className="text-xs text-genz-teal">This device will be securely linked to your account</p>
            </div>

            {/* Submit */}
            <button type="submit" disabled={loading}
                    className="w-full py-3.5 font-bold text-genz-deep-navy rounded-xl transition-all hover:opacity-90 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}
                    data-testid="login-button">
              {loading ? 'Signing In...' : 'Sign In to Dashboard'}
            </button>
          </form>

          {/* Footer Links */}
          <div className="mt-6 space-y-2 text-center">
            <Link to="/join" className="block text-sm text-genz-teal hover:underline">
              Don't have an account? Get Membership
            </Link>
            <Link to="/" className="block text-sm text-genz-muted hover:text-genz-teal transition-colors">
              ← Back to Gen Z Digital Store
            </Link>
          </div>
        </div>

        {/* Security Badge */}
        <div className="mt-5 p-3 rounded-xl text-center flex items-center justify-center gap-2"
             style={{ background: 'rgba(0,175,193,0.05)', border: '1px solid rgba(0,175,193,0.1)' }}>
          <Shield size={14} className="text-genz-teal" />
          <p className="text-xs text-genz-muted">
            Protected with device binding & encrypted tokens
          </p>
        </div>
      </div>
    </div>
  );
};

export default ClientLogin;

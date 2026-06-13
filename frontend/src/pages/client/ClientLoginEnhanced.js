import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, User, Smartphone } from 'lucide-react';
import { authService } from '../../services/authService';
import { useToast } from '../../components/Toast';

const ClientLoginEnhanced = () => {
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
      showSuccess('Welcome back!');
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
    <div className="min-h-screen bg-gradient-to-br from-[#1E1F24] to-[#24252B] flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Logo & Title */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-gradient-orange rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-xl">
            <User size={40} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Client Portal</h1>
          <p className="text-genz-muted">Access your assigned tools</p>
        </div>

        {/* Login Card */}
        <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="your@email.com"
                  data-testid="email-input"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full pl-11 pr-12 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="Enter your password"
                  data-testid="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-white transition-colors"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            {/* Device Info */}
            <div className="flex items-center gap-2 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <Smartphone size={16} className="text-blue-400" />
              <p className="text-xs text-blue-400">
                This device will be securely linked to your account
              </p>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-orange text-white rounded-lg font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 transform"
              data-testid="login-button"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Footer Links */}
          <div className="mt-6 space-y-2 text-center">
            <Link to="/join" className="block text-sm text-genz-teal hover:underline">
              Don't have an account? Register
            </Link>
            <a href="/" className="block text-sm text-genz-muted hover:text-genz-teal transition-colors">
              ← Back to Website
            </a>
          </div>
        </div>

        {/* Security Notice */}
        <div className="mt-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
          <p className="text-xs text-yellow-400 text-center">
            🔒 Your account is protected with device binding for enhanced security
          </p>
        </div>
      </div>
    </div>
  );
};

export default ClientLoginEnhanced;
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, User, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';
import { useToast } from '../components/Toast';
import api from '../services/api';

const Join = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: ''
  });
  const [agreed, setAgreed] = useState(false);
  
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
      
      // Create client account via CRM API
      const response = await api.post('/public/register', {
        fullName: formData.name,
        email: formData.email,
        password: formData.password
      });
      
      if (response.data.success) {
        setSuccess(true);
        showSuccess('Account created successfully! You can now login.');
        setTimeout(() => {
          navigate('/client/login');
        }, 2000);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to create account. Please try again.';
      showError(errorMsg);
    } finally {
      setLoading(false);
    }
  };
  
  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };
  
  if (success) {
    return (
      <div className="text-genz-navy min-h-screen flex items-center justify-center px-4 py-24">
        <div className="max-w-md w-full text-center">
          <div className="bg-white border border-genz-border rounded-2xl p-8">
            <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 size={40} className="text-green-500" />
            </div>
            <h2 className="text-2xl font-bold mb-4">Account Created!</h2>
            <p className="text-genz-muted mb-6">
              Your account has been created successfully. Redirecting you to login...
            </p>
            <Link 
              to="/client/login"
              className="inline-block px-8 py-3 bg-gradient-orange text-genz-navy rounded-full font-medium hover:opacity-90"
            >
              Go to Login
            </Link>
          </div>
        </div>
      </div>
    );
  }
  
  return (
    <div className="text-genz-navy min-h-screen flex items-center justify-center px-4 py-24">
      <div className="max-w-md w-full">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-4">
            <GenZDigitalStoreLogo className="h-12" />
          </Link>
          <h1 className="text-3xl font-bold mb-2" data-testid="join-page-heading">Join Gen Z Digital Store</h1>
          <p className="text-genz-muted">Start your journey with unlimited tools</p>
        </div>
        
        {/* Signup Form */}
        <div className="bg-white border border-genz-border rounded-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="name" className="block text-sm font-medium mb-2">
                Full Name
              </label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  className="w-full pl-12 pr-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="John Doe"
                  data-testid="join-name-input"
                />
              </div>
            </div>
            
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
                <input
                  type="email"
                  id="email"
                  name="email"
                  required
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full pl-12 pr-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="you@example.com"
                  data-testid="join-email-input"
                />
              </div>
            </div>
            
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  name="password"
                  required
                  minLength={6}
                  value={formData.password}
                  onChange={handleChange}
                  className="w-full pl-12 pr-12 py-3 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="••••••••"
                  data-testid="join-password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-teal transition-colors"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              <p className="text-xs text-genz-muted mt-1">Minimum 6 characters</p>
            </div>
            
            <div>
              <label className="flex items-start cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-1 mr-2 w-4 h-4" 
                  data-testid="join-agree-checkbox"
                />
                <span className="text-sm text-genz-muted">
                  I agree to the <a href="#" className="text-genz-teal hover:underline">Terms of Service</a> and <a href="#" className="text-genz-teal hover:underline">Privacy Policy</a>
                </span>
              </label>
            </div>
            
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-orange text-genz-navy rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="join-submit-btn"
            >
              {loading ? 'Creating Account...' : 'Create Account'}
            </button>
          </form>
          
          <div className="mt-6 text-center">
            <p className="text-genz-muted text-sm">
              Already have an account?{' '}
              <Link to="/client/login" className="text-genz-teal hover:underline">
                Log in
              </Link>
            </p>
          </div>
        </div>
        
        {/* Trust Indicators */}
        <div className="mt-8 text-center">
          <p className="text-genz-muted text-sm mb-4">
            ✓ Instant access • ✓ No credit card required • ✓ Cancel anytime
          </p>
          <Link to="/" className="text-genz-muted hover:text-genz-teal text-sm transition-colors">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Join;

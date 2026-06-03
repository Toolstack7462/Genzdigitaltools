import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, Shield } from 'lucide-react';
import { useToast } from '../../components/Toast';
import GenZDigitalStoreLogo from '../../components/GenZDigitalStoreLogo';

const AdminLogin = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch('/api/crm/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('adminUser', JSON.stringify(data.user));
      showSuccess('Welcome to Admin Panel!');
      navigate('/admin/dashboard');
    } catch (error) {
      showError(error.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: 'linear-gradient(135deg, #000820, #001030)' }}>
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <GenZDigitalStoreLogo className="h-12 justify-center mb-6" textSize="2xl" />
          <h1 className="text-2xl font-black text-white mb-1">Admin Panel</h1>
          <p className="text-genz-muted text-sm">Gen Z Digital Store Management</p>
        </div>

        <div className="p-8 rounded-2xl border"
             style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-white mb-2">Admin Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                <input type="email" required value={formData.email}
                       onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                       className="w-full pl-10 pr-4 py-3 rounded-xl text-white placeholder-genz-muted focus:outline-none"
                       style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }}
                       placeholder="admin@genzdigitalstore.com" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-white mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                <input type={showPassword ? 'text' : 'password'} required value={formData.password}
                       onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                       className="w-full pl-10 pr-12 py-3 rounded-xl text-white placeholder-genz-muted focus:outline-none"
                       style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }}
                       placeholder="Enter admin password" />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-white transition-colors">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
                    className="w-full py-3.5 font-bold text-genz-deep-navy rounded-xl transition-all hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              {loading ? 'Signing In...' : 'Access Admin Panel'}
            </button>
          </form>
        </div>

        <div className="mt-4 p-3 rounded-xl text-center flex items-center justify-center gap-2"
             style={{ background: 'rgba(0,175,193,0.05)', border: '1px solid rgba(0,175,193,0.1)' }}>
          <Shield size={13} className="text-genz-teal" />
          <p className="text-xs text-genz-muted">Restricted access — authorized personnel only</p>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;

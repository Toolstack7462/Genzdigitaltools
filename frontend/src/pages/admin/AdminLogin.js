import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, Shield, ArrowRight } from 'lucide-react';
import { useToast } from '../../components/Toast';
import BrandLogo from '../../components/BrandLogo';
import api from '../../services/api';

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
      const response = await api.post('/auth/admin/login', formData);
      const data = response.data;

      localStorage.setItem('genz_admin_user', JSON.stringify(data.user));
      showSuccess('Welcome to Admin Panel!');

      window.location.href = '/admin/dashboard';
    } catch (error) {
      console.error('Admin login error:', error);
      showError(
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        'Login failed. Please check your email and password.'
      );
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full rounded-[14px] border border-genz-border bg-white py-3 text-[15px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all duration-200 focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12';

  return (
    <div className="relative min-h-dvh flex items-center justify-center p-5 overflow-hidden"
         style={{ background: 'var(--gradient-hero)' }}>
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
        style={{ background: 'radial-gradient(40rem 40rem at 80% 15%, rgba(37,99,235,0.10), transparent 60%),radial-gradient(36rem 36rem at 15% 90%, rgba(6,182,212,0.12), transparent 60%)' }} />

      <div className="max-w-md w-full relative z-10">
        <div className="text-center mb-7">
          <div className="inline-flex flex-col items-center mb-5">
            <BrandLogo size="xl" />
          </div>
          <div className="flex items-center justify-center gap-2 mb-2">
            <h1 className="font-heading text-[30px] font-extrabold text-genz-navy">Admin Panel</h1>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-genz-blue"
                  style={{ background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.2)' }}>
              <Shield size={10} /> Secure
            </span>
          </div>
          <p className="text-genz-muted text-[15px]">Gen Z Digital Store Management</p>
        </div>

        <div className="bg-white rounded-[24px] p-7 sm:p-8"
             style={{ border: '1px solid var(--brand-border)', boxShadow: '0 24px 60px rgba(7,27,51,0.10)' }}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-[14px] font-semibold text-genz-navy mb-2">Admin Email</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                <input type="email" required value={formData.email}
                       onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                       className={`${inputClass} pl-11 pr-4`}
                       placeholder="admin@genzdigitalstore.com" />
              </div>
            </div>
            <div>
              <label className="block text-[14px] font-semibold text-genz-navy mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
                <input type={showPassword ? 'text' : 'password'} required value={formData.password}
                       onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                       className={`${inputClass} pl-11 pr-12`}
                       placeholder="Enter admin password" />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-blue transition-colors p-1 rounded-md">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
                    className="w-full py-3.5 text-[15px] font-bold text-white rounded-[14px] flex items-center justify-center gap-2 transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:translate-y-0"
                    style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 28px rgba(37,99,235,0.28)' }}>
              {loading ? 'Signing In…' : <>Access Admin Panel <ArrowRight size={16} /></>}
            </button>
          </form>
        </div>

        <div className="mt-5 p-3 rounded-xl text-center flex items-center justify-center gap-2"
             style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.2)' }}>
          <Shield size={13} style={{ color: '#06B6D4' }} />
          <p className="text-xs text-genz-navy/70">Restricted access — authorized personnel only</p>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;

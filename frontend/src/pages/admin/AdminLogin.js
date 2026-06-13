import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Lock, Mail, Eye, EyeOff, Shield, ArrowRight,
  LayoutDashboard, Users, Package, Activity, ShieldCheck,
} from 'lucide-react';
import { useToast } from '../../components/Toast';
import BrandLogo from '../../components/BrandLogo';
import api from '../../services/api';

const CONSOLE = [
  { icon: Package,  label: 'Tools',    color: '#06B6D4' },
  { icon: Users,    label: 'Members',  color: '#2563EB' },
  { icon: Activity, label: 'Activity', color: '#4F46E5' },
  { icon: Shield,   label: 'Security', color: '#0891B2' },
];

const AdminLogin = () => {
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
        {/* ── LEFT: 3D glass admin-console visual (desktop) ── */}
        <div className="hidden lg:flex items-center justify-center p-12">
          <motion.div {...fade(0.05)} className="stage-3d w-full max-w-md">
            <svg className="absolute -inset-8 w-[118%] h-[118%] ribbon-glow opacity-90 pointer-events-none" viewBox="0 0 520 460" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="arb1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2563EB" /><stop offset="0.5" stopColor="#06B6D4" /><stop offset="1" stopColor="#14B8A6" /></linearGradient>
              </defs>
              <path d="M-20 130 C 120 50, 260 230, 540 100" stroke="url(#arb1)" strokeWidth="16" strokeLinecap="round" opacity="0.5" />
              <path d="M-20 350 C 160 300, 300 430, 560 320" stroke="url(#arb1)" strokeWidth="11" strokeLinecap="round" opacity="0.35" />
            </svg>

            <div className="deck-3d relative">
              <div className="glass-tint layer-back rounded-[28px] absolute inset-0" style={{ transform: 'translateZ(-70px) translate(30px,-16px)' }} />
              <div className="glass layer-mid relative rounded-[28px] p-7">
                <div className="flex items-center gap-3 mb-6">
                  <BrandLogo size="lg" glow />
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-genz-blue">Admin Console</p>
                    <h2 className="text-[17px] font-bold text-genz-navy leading-tight">Manage your platform</h2>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-5">
                  {CONSOLE.map(({ icon: Icon, label, color }) => (
                    <div key={label} className="sheen rounded-2xl px-3.5 py-3 flex items-center gap-2.5" style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${color}16`, color, border: `1px solid ${color}2e` }}><Icon size={15} /></span>
                      <span className="text-[12.5px] font-bold text-genz-navy">{label}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2.5">
                  {['Assign tools & manage members', 'Monitor activity & security', 'Publish content & track analytics'].map(t => (
                    <div key={t} className="flex items-center gap-2 text-[13.5px] text-genz-navy/80">
                      <ShieldCheck size={15} className="text-genz-blue flex-shrink-0" /> {t}
                    </div>
                  ))}
                </div>
              </div>
              <div className="glass pop-3 float-a absolute -right-7 top-12 flex items-center gap-2.5 rounded-2xl px-4 py-3 depth-cyan">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}><ShieldCheck size={16} /></span>
                <div><div className="text-[12px] font-bold text-genz-navy leading-none">Secure</div><div className="text-[11px] text-genz-muted mt-0.5">role-based access</div></div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* ── RIGHT: login card ── */}
        <div className="flex items-center justify-center p-5 sm:p-8">
          <motion.div {...fade(0.12)} className="w-full max-w-md">
            <div className="text-center mb-7">
              <div className="lg:hidden inline-flex justify-center mb-5"><BrandLogo size="2xl" glow /></div>
              <div className="flex items-center justify-center gap-2 mb-2">
                <h1 className="font-heading text-[32px] sm:text-[34px] font-extrabold text-genz-navy tracking-tight">Admin Panel</h1>
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-genz-blue"
                      style={{ background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.2)' }}>
                  <Shield size={10} /> Secure
                </span>
              </div>
              <p className="text-genz-muted text-[15px]">Gen Z Digital Store Management</p>
            </div>

            <div className="glass rounded-[24px] p-7 sm:p-8 depth">
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

                <div className="flex items-center gap-2.5 p-3 rounded-xl" style={{ background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.18)' }}>
                  <Shield size={15} className="flex-shrink-0" style={{ color: '#2563EB' }} />
                  <p className="text-[12.5px] text-genz-navy/70">Restricted access — authorized personnel only.</p>
                </div>

                <button type="submit" disabled={loading}
                        className="btn-grad w-full py-3.5 text-[15px] font-bold rounded-[14px] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
                  {loading ? (<><span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Signing In…</>) : (<>Access Admin Panel <ArrowRight size={16} /></>)}
                </button>
              </form>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              {[[ShieldCheck, 'Role-based access'], [LayoutDashboard, 'Full control'], [Lock, 'Encrypted session']].map(([Icon, label]) => (
                <div key={label} className="flex items-center gap-1.5 text-genz-muted text-[12.5px]"><Icon size={13} style={{ color: '#2563EB' }} /> {label}</div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;

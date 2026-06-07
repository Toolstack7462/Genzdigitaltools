import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Package, Users, Activity, LogOut, FileText, Mail,
  Menu, X, Shield, Settings, TrendingUp, ShieldAlert, ExternalLink
} from 'lucide-react';
import BrandLogo from './BrandLogo';
import api from '../services/api';

const NAV_ITEMS = [
  { to: '/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard',   group: 'Overview' },
  { to: '/admin/tools',     icon: Package,         label: 'Tools',       group: 'Manage'   },
  { to: '/admin/clients',   icon: Users,           label: 'Members',     group: 'Manage'   },
  { to: '/admin/assign',    icon: Activity,        label: 'Assignments', group: 'Manage'   },
  { to: '/admin/activity',  icon: Activity,        label: 'Activity',    group: 'Insights' },
  { to: '/admin/blog',      icon: FileText,        label: 'Blog',        group: 'Content'  },
  { to: '/admin/contacts',  icon: Mail,            label: 'Contacts',    group: 'Content'  },
  { to: '/admin/analytics', icon: TrendingUp,      label: 'Analytics',   group: 'Insights' },
  { to: '/admin/security',  icon: ShieldAlert,     label: 'Security',    group: 'Insights' },
];

const getAdminTitle = (path) => {
  const item = NAV_ITEMS.find((n) => path.startsWith(n.to));
  return item ? item.label : 'Admin Panel';
};

const AdminLayoutEnhanced = ({ children }) => {
  const navigate  = useNavigate();
  const location  = useLocation();
  const reduce    = useReducedMotion();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminUser, setAdminUser] = useState(null);

  useEffect(() => {
    const stored = localStorage.getItem('genz_admin_user');
    if (stored) {
      try { setAdminUser(JSON.parse(stored)); } catch {}
    } else {
      navigate('/admin/login');
    }
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await api.post('/auth/admin/logout', {});
    } catch {
      // Even if the network call fails, clear local state and redirect
    } finally {
      localStorage.removeItem('genz_admin_user');
      navigate('/admin/login');
    }
  };

  const isActive = (path) => location.pathname.startsWith(path);

  // Render nav grouped by section, preserving order
  const groups = NAV_ITEMS.reduce((acc, item) => {
    (acc[item.group] = acc[item.group] || []).push(item);
    return acc;
  }, {});

  const SidebarContent = () => (
    <div className="flex flex-col h-full"
         style={{ background: 'linear-gradient(180deg, #071B33 0%, #0B2747 100%)', borderRight: '1px solid rgba(6,182,212,0.14)' }}>
      <div className="h-[68px] flex flex-col justify-center px-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <Link to="/admin/dashboard" onClick={() => setSidebarOpen(false)} className="flex items-center gap-2" aria-label="Admin dashboard">
          <BrandLogo size="sm" />
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider text-genz-cyan"
                style={{ background: 'rgba(6,182,212,0.14)', border: '1px solid rgba(6,182,212,0.3)' }}>
            <Shield size={9} /> Admin
          </span>
        </Link>
      </div>

      {adminUser && (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>
              {(adminUser.fullName || 'A').charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-white text-xs font-semibold truncate">{adminUser.fullName}</p>
              <p className="text-white/55 capitalize" style={{ fontSize: '10px' }}>{adminUser.role}</p>
            </div>
          </div>
        </div>
      )}

      <nav className="flex-1 p-3 overflow-y-auto">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="mb-3">
            <p className="px-3 mb-1 text-[10px] font-bold uppercase tracking-widest text-white/30">{group}</p>
            <div className="space-y-0.5">
              {items.map(({ to, icon: Icon, label }) => {
                const active = isActive(to);
                return (
                  <Link key={to} to={to}
                        onClick={() => setSidebarOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={`ds-navitem ${active ? 'active' : ''}`}>
                    <Icon size={17} className="ds-navicon flex-shrink-0" />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t space-y-1" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <Link to="/" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all">
          <Settings size={16} />
          View Website
        </Link>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-red-300 hover:text-red-200 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40 transition-all">
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--brand-soft)' }}>
      {/* Desktop sidebar */}
      <div className="hidden lg:flex w-56 flex-shrink-0">
        <SidebarContent />
      </div>

      {/* Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-genz-navy/50 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            <motion.div className="relative w-64 h-full"
              initial={reduce ? false : { x: -280 }} animate={{ x: 0 }} exit={reduce ? undefined : { x: -280 }}
              transition={{ type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.28 }}>
              <SidebarContent />
              <button className="absolute top-4 right-4 text-white/60 hover:text-white"
                      onClick={() => setSidebarOpen(false)} aria-label="Close menu">
                <X size={18} />
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Desktop topbar */}
        <header className="hidden lg:flex items-center justify-between h-[68px] px-6 border-b flex-shrink-0 bg-white"
                style={{ borderColor: 'var(--brand-border)' }}>
          <h1 className="font-heading text-genz-navy font-bold text-[20px]">
            {getAdminTitle(location.pathname)}
          </h1>
          <Link to="/" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-genz-muted border border-genz-border rounded-xl hover:text-genz-blue hover:border-genz-blue/40 transition-all">
            <ExternalLink size={14} /> View Site
          </Link>
        </header>

        {/* Mobile topbar */}
        <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b flex-shrink-0 bg-white"
             style={{ borderColor: 'var(--brand-border)' }}>
          <button onClick={() => setSidebarOpen(true)} className="text-genz-navy/70 hover:text-genz-blue" aria-label="Open menu">
            <Menu size={20} />
          </button>
          <span className="text-genz-navy font-bold text-sm">{getAdminTitle(location.pathname)}</span>
          <div className="w-6" />
        </div>

        <main className="flex-1 overflow-y-auto p-5 sm:p-6" style={{ background: 'var(--brand-soft)' }}>
          <div className="max-w-[1200px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
};

export default AdminLayoutEnhanced;

// ============================================================================
// EXPORTED ADMIN THEME CONSTANTS (used by admin pages) — light surfaces
// ============================================================================
export const ADMIN_CARD_VARIANTS = {
  default:  'bg-white border border-genz-border shadow-[0_10px_30px_rgba(7,27,51,0.06)]',
  elevated: 'bg-white border border-genz-border shadow-[0_18px_45px_rgba(7,27,51,0.10)]',
  teal:     'bg-cyan-50 border border-cyan-200',
  blue:     'bg-blue-50 border border-blue-200',
  green:    'bg-green-50 border border-green-200',
  yellow:   'bg-amber-50 border border-amber-200',
  purple:   'bg-purple-50 border border-purple-200',
  red:      'bg-red-50 border border-red-200',
  cyan:     'bg-cyan-50 border border-cyan-200',
  orange:   'bg-orange-50 border border-orange-200',
};

export const ADMIN_CATEGORY_COLORS = {
  'AI':            { gradient: 'from-purple-500 to-purple-600', text: 'text-purple-600', bg: 'bg-purple-50' },
  'Academic':      { gradient: 'from-blue-500 to-blue-600',     text: 'text-blue-600',   bg: 'bg-blue-50'   },
  'SEO':           { gradient: 'from-green-500 to-green-600',   text: 'text-green-600',  bg: 'bg-green-50'  },
  'Productivity':  { gradient: 'from-amber-500 to-amber-600',   text: 'text-amber-600',  bg: 'bg-amber-50'  },
  'Design':        { gradient: 'from-pink-500 to-pink-600',     text: 'text-pink-600',   bg: 'bg-pink-50'   },
  'Business':      { gradient: 'from-genz-blue to-genz-cyan',   text: 'text-genz-blue',  bg: 'bg-cyan-50'   },
  'Other':         { gradient: 'from-slate-500 to-slate-600',   text: 'text-slate-600',  bg: 'bg-slate-50'  },
};

export const getAdminCategoryTheme = (category) =>
  ADMIN_CATEGORY_COLORS[category] || ADMIN_CATEGORY_COLORS['Other'];

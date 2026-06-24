import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Package, Users, Activity, LogOut, FileText, Mail,
  Menu, X, Shield, TrendingUp, ShieldAlert, ExternalLink, Sparkles, Zap, Chrome, Megaphone, CalendarClock, Gift
} from 'lucide-react';
import BrandLogo from './BrandLogo';
import RefreshButton from './RefreshButton';
import api from '../services/api';

const NAV_ITEMS = [
  { to: '/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard',   group: 'Overview' },
  { to: '/admin/tools',     icon: Package,         label: 'Tools',       group: 'Manage'   },
  { to: '/admin/clients',   icon: Users,           label: 'Members',     group: 'Manage'   },
  { to: '/admin/assignments', icon: Activity,      label: 'Assignments', group: 'Manage'   },
  { to: '/admin/renewals',  icon: CalendarClock,   label: 'Renewals',    group: 'Manage'   },
  { to: '/admin/stealthwriter', icon: Sparkles,    label: 'StealthWriter', group: 'Manage' },
  { to: '/admin/proxy-tools', icon: Zap,           label: 'Proxy Tools',   group: 'Manage' },
  { to: '/admin/extension', icon: Chrome,          label: 'Extension',     group: 'Manage' },
  { to: '/admin/activity',  icon: Activity,        label: 'Activity',    group: 'Insights' },
  { to: '/admin/blog',      icon: FileText,        label: 'Blog',        group: 'Content'  },
  { to: '/admin/contacts',  icon: Mail,            label: 'Contacts',    group: 'Content'  },
  { to: '/admin/announcements', icon: Megaphone,   label: 'Announcements', group: 'Content' },
  { to: '/admin/marketing', icon: Gift,            label: 'Marketing',     group: 'Content' },
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
         style={{ background: 'var(--gradient-navy)', borderRight: '1px solid rgba(6,182,212,0.16)' }}>
      <div className="h-[84px] flex items-center px-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <Link to="/admin/dashboard" onClick={() => setSidebarOpen(false)} className="flex items-center gap-3 group" aria-label="Admin dashboard">
          <span className="ds-logo-tile">
            <BrandLogo size="lg" glow />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-white font-bold text-[15px] tracking-tight">Gen Z Digital Store</span>
            <span className="flex items-center gap-1 mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-genz-cyan">
              <Shield size={10} /> Admin Console
            </span>
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
        <a href="https://genzdigitalstore.com" target="_blank" rel="noopener noreferrer"
           className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all">
          <ExternalLink size={16} />
          View Website
        </a>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-red-300 hover:text-red-200 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40 transition-all">
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--gradient-app)' }}>
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
        <header className="ds-topbar hidden lg:flex items-center justify-between h-[68px] px-6 border-b flex-shrink-0">
          <h1 className="font-heading text-white font-bold text-[20px]">
            {getAdminTitle(location.pathname)}
          </h1>
          <div className="flex items-center gap-3">
            <RefreshButton variant="dark" />
            <a href="https://genzdigitalstore.com" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-white/70 border border-white/15 rounded-xl hover:text-white hover:border-genz-cyan/50 hover:bg-white/5 transition-all">
              <ExternalLink size={14} /> View Site
            </a>
          </div>
        </header>

        {/* Mobile topbar */}
        <div className="ds-topbar lg:hidden flex items-center justify-between px-4 h-14 border-b flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)} className="text-white/70 hover:text-white" aria-label="Open menu">
            <Menu size={20} />
          </button>
          <span className="text-white font-bold text-sm">{getAdminTitle(location.pathname)}</span>
          <RefreshButton variant="dark" className="!h-8 !w-8" />
        </div>

        <main className="app-main flex-1 overflow-y-auto p-5 sm:p-6" style={{ background: 'var(--gradient-app)' }}>
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
  default:  'ds-card',
  elevated: 'ds-card-elevated',
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

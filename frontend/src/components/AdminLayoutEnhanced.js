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
         style={{ background: 'linear-gradient(180deg, #000820 0%, #000f28 100%)', borderRight: '1px solid rgba(0,175,193,0.1)' }}>
      <div className="h-16 flex flex-col justify-center px-5 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <Link to="/admin/dashboard" onClick={() => setSidebarOpen(false)} className="flex items-center gap-2" aria-label="Admin dashboard">
          <BrandLogo variant="mark" size="sm" />
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider text-genz-teal"
                style={{ background: 'rgba(0,175,193,0.12)', border: '1px solid rgba(0,175,193,0.25)' }}>
            <Shield size={9} /> Admin
          </span>
        </Link>
      </div>

      {adminUser && (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-genz-deep-navy flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
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
            <p className="px-3 mb-1 text-[10px] font-bold uppercase tracking-widest text-white/25">{group}</p>
            <div className="space-y-0.5">
              {items.map(({ to, icon: Icon, label }) => {
                const active = isActive(to);
                return (
                  <Link key={to} to={to}
                        onClick={() => setSidebarOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                          active ? 'text-genz-deep-navy' : 'text-white/55 hover:text-white hover:bg-white/5'
                        }`}
                        style={active ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
                    <Icon size={16} />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t space-y-1" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <Link to="/" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-white/55 hover:text-white hover:bg-white/5 transition-all">
          <Settings size={16} />
          View Website
        </Link>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40 transition-all">
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#000820' }}>
      {/* Desktop sidebar */}
      <div className="hidden lg:flex w-56 flex-shrink-0">
        <SidebarContent />
      </div>

      {/* Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-black/60"
              onClick={() => setSidebarOpen(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            <motion.div className="relative w-64 h-full"
              initial={reduce ? false : { x: -280 }} animate={{ x: 0 }} exit={reduce ? undefined : { x: -280 }}
              transition={{ type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.28 }}>
              <SidebarContent />
              <button className="absolute top-4 right-4 text-white/50 hover:text-white"
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
        <header className="hidden lg:flex items-center justify-between h-16 px-6 border-b flex-shrink-0"
                style={{ background: 'rgba(0,8,32,0.85)', backdropFilter: 'blur(14px)', borderColor: 'rgba(0,175,193,0.1)' }}>
          <h1 className="text-white font-bold text-lg" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>
            {getAdminTitle(location.pathname)}
          </h1>
          <Link to="/" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white/55 border border-white/10 rounded-full hover:text-white hover:border-white/25 transition-all">
            <ExternalLink size={13} /> View Site
          </Link>
        </header>

        {/* Mobile topbar */}
        <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b flex-shrink-0"
             style={{ background: 'rgba(0,12,32,0.92)', backdropFilter: 'blur(12px)', borderColor: 'rgba(0,175,193,0.08)' }}>
          <button onClick={() => setSidebarOpen(true)} className="text-white/60 hover:text-white" aria-label="Open menu">
            <Menu size={20} />
          </button>
          <span className="text-white font-semibold text-sm">{getAdminTitle(location.pathname)}</span>
          <div className="w-6" />
        </div>

        <main className="flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
};

export default AdminLayoutEnhanced;

// ============================================================================
// EXPORTED ADMIN THEME CONSTANTS (used by admin pages)
// ============================================================================
export const ADMIN_CARD_VARIANTS = {
  default:  'bg-white/[0.04] border border-white/10 backdrop-blur-sm',
  elevated: 'bg-white/[0.06] border border-white/15 backdrop-blur-sm shadow-xl',
  teal:     'bg-genz-teal/10 border border-genz-teal/30',
  blue:     'bg-blue-500/10 border border-blue-500/30',
  green:    'bg-green-500/10 border border-green-500/30',
  yellow:   'bg-yellow-500/10 border border-yellow-500/30',
  purple:   'bg-purple-500/10 border border-purple-500/30',
  red:      'bg-red-500/10 border border-red-500/30',
  cyan:     'bg-cyan-500/10 border border-cyan-500/30',
  orange:   'bg-orange-500/10 border border-orange-500/30',
};

export const ADMIN_CATEGORY_COLORS = {
  'AI':            { gradient: 'from-purple-500 to-purple-600', text: 'text-purple-400', bg: 'bg-purple-500/10' },
  'Academic':      { gradient: 'from-blue-500 to-blue-600',     text: 'text-blue-400',   bg: 'bg-blue-500/10'   },
  'SEO':           { gradient: 'from-green-500 to-green-600',   text: 'text-green-400',  bg: 'bg-green-500/10'  },
  'Productivity':  { gradient: 'from-yellow-500 to-yellow-600', text: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  'Design':        { gradient: 'from-pink-500 to-pink-600',     text: 'text-pink-400',   bg: 'bg-pink-500/10'   },
  'Business':      { gradient: 'from-genz-teal to-genz-dark-teal', text: 'text-genz-teal', bg: 'bg-genz-teal/10'},
  'Other':         { gradient: 'from-gray-500 to-gray-600',     text: 'text-gray-400',   bg: 'bg-gray-500/10'   },
};

export const getAdminCategoryTheme = (category) =>
  ADMIN_CATEGORY_COLORS[category] || ADMIN_CATEGORY_COLORS['Other'];

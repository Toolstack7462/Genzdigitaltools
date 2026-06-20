import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Package, User, LogOut, Menu, X,
  HelpCircle, ChevronRight, MessageCircle, ExternalLink, Activity
} from 'lucide-react';
import { authService } from '../services/authService';
import { useToast } from './Toast';
import BrandLogo from './BrandLogo';

// ============================================================================
// SHARED THEME CONSTANTS
// ============================================================================
export const CATEGORY_COLORS = {
  'AI':               { gradient: 'from-purple-500 to-purple-600', bg: 'bg-purple-50',  border: 'border-purple-200', text: 'text-purple-600' },
  'Academic':         { gradient: 'from-blue-500 to-blue-600',     bg: 'bg-blue-50',    border: 'border-blue-200',   text: 'text-blue-600'   },
  'SEO':              { gradient: 'from-green-500 to-green-600',   bg: 'bg-green-50',   border: 'border-green-200',  text: 'text-green-600'  },
  'Productivity':     { gradient: 'from-amber-500 to-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200',  text: 'text-amber-600'  },
  'Graphics & SEO':   { gradient: 'from-pink-500 to-pink-600',     bg: 'bg-pink-50',    border: 'border-pink-200',   text: 'text-pink-600'   },
  'Text Humanizers':  { gradient: 'from-indigo-500 to-indigo-600', bg: 'bg-indigo-50',  border: 'border-indigo-200', text: 'text-indigo-600' },
  'Career-Oriented':  { gradient: 'from-orange-500 to-orange-600', bg: 'bg-orange-50',  border: 'border-orange-200', text: 'text-orange-600' },
  'Miscellaneous':    { gradient: 'from-cyan-500 to-cyan-600',     bg: 'bg-cyan-50',    border: 'border-cyan-200',   text: 'text-cyan-600'   },
  'Other':            { gradient: 'from-slate-500 to-slate-600',   bg: 'bg-slate-50',   border: 'border-slate-200',  text: 'text-slate-600'  },
  'AI Writing':       { gradient: 'from-genz-blue to-genz-cyan',   bg: 'bg-cyan-50',    border: 'border-cyan-200',   text: 'text-genz-blue'  },
};

export const getCategoryTheme = (category) =>
  CATEGORY_COLORS[category] || CATEGORY_COLORS['Other'];

export const getCategoryGradient = (category) =>
  getCategoryTheme(category).gradient;

// Light, consistent dashboard card surfaces.
export const CARD_VARIANTS = {
  default:  'ds-card',
  elevated: 'ds-card-elevated',
  teal:     'bg-cyan-50 border border-cyan-200',
  blue:     'bg-blue-50 border border-blue-200',
  green:    'bg-green-50 border border-green-200',
  yellow:   'bg-amber-50 border border-amber-200',
  purple:   'bg-purple-50 border border-purple-200',
  orange:   'bg-orange-50 border border-orange-200',
  pink:     'bg-pink-50 border border-pink-200',
  cyan:     'bg-cyan-50 border border-cyan-200',
  indigo:   'bg-indigo-50 border border-indigo-200',
};

const WHATSAPP_URL = 'https://wa.me/923027467462';

// Route → human page title for the topbar
const PAGE_TITLES = [
  { match: (p) => p === '/client/dashboard',            title: 'Dashboard',     sub: 'Your tools & account overview' },
  { match: (p) => p.startsWith('/client/tools/'),       title: 'Tool Details',  sub: 'Access and manage this tool' },
  { match: (p) => p === '/client/tools',                title: 'My Tools',      sub: 'All tools assigned to you' },
  { match: (p) => p === '/client/profile',              title: 'Profile',       sub: 'Account & security settings' },
];
const getPageMeta = (path) =>
  PAGE_TITLES.find((r) => r.match(path)) || { title: 'Member Portal', sub: '' };

// ============================================================================
// MAIN LAYOUT COMPONENT
// ============================================================================
const ClientLayoutEnhanced = ({ children }) => {
  const navigate  = useNavigate();
  const location  = useLocation();
  const reduce    = useReducedMotion();
  const { showSuccess, showError } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const u = authService.getCurrentUser();
    if (u) setUser(u);
    else navigate('/client/login');
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await authService.clientLogout();
      showSuccess('Logged out successfully');
      navigate('/client/login');
    } catch {
      showError('Logout failed');
    }
  };

  const navItems = [
    { to: '/client/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/client/tools',     icon: Package,         label: 'My Tools'  },
    { to: '/client/activity',  icon: Activity,        label: 'Activity'  },
    { to: '/client/profile',   icon: User,            label: 'Profile'   },
  ];

  const isActive = (path) => location.pathname === path;
  const pageMeta = getPageMeta(location.pathname);
  const initials = user?.fullName
    ? user.fullName.split(' ').map((n) => n[0]).join('').slice(0, 2)
    : 'M';

  const Sidebar = ({ mobile = false }) => (
    <div className={`flex flex-col h-full ${mobile ? 'w-full' : 'w-64'}`}
         style={{ background: 'var(--gradient-navy)', borderRight: '1px solid rgba(6,182,212,0.16)' }}>
      {/* Logo */}
      <div className="h-[84px] flex items-center px-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <Link to="/client/dashboard" onClick={() => setSidebarOpen(false)} className="flex items-center gap-3 group" aria-label="Gen Z Digital Store dashboard">
          <span className="ds-logo-tile">
            <BrandLogo size="lg" glow />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-white font-bold text-[15px] tracking-tight">Gen Z Digital Store</span>
            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-genz-cyan">Member Portal</span>
          </span>
        </Link>
      </div>

      {/* User Info */}
      {user && (
        <div className="p-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-3 p-3 rounded-2xl"
               style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold truncate">{user.fullName || 'Member'}</p>
              <p className="text-white/55 text-xs truncate">{user.email}</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        <p className="px-3 mb-2 text-[10px] font-bold uppercase tracking-widest text-white/45">Menu</p>
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = isActive(to);
          return (
            <Link key={to} to={to}
                  onClick={() => setSidebarOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`ds-navitem ${active ? 'active' : ''}`}>
              <Icon size={17} className="ds-navicon flex-shrink-0" />
              {label}
              {active && <ChevronRight size={14} className="ml-auto opacity-70" />}
            </Link>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className="p-4 border-t space-y-1" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <a href="https://genzdigitalstore.com" target="_blank" rel="noopener noreferrer"
           className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all">
          <ExternalLink size={17} />
          View Website
        </a>
        <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
           className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all">
          <HelpCircle size={17} />
          Get Support
        </a>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/60 hover:text-red-300 hover:bg-red-500/10 transition-all">
          <LogOut size={17} />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--gradient-app)' }}>
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-genz-navy/50 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            />
            <motion.div
              className="relative w-72 h-full"
              initial={reduce ? false : { x: -300 }}
              animate={{ x: 0 }}
              exit={reduce ? undefined : { x: -300 }}
              transition={{ type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.3 }}
            >
              <Sidebar mobile />
              <button className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors"
                      onClick={() => setSidebarOpen(false)} aria-label="Close menu">
                <X size={20} />
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Desktop Topbar */}
        <header className="ds-topbar hidden lg:flex items-center justify-between h-[68px] px-6 sm:px-8 border-b flex-shrink-0 z-20">
          <div>
            <h1 className="font-heading text-white font-bold text-[20px] leading-tight">{pageMeta.title}</h1>
            {pageMeta.sub && <p className="text-white/55 text-[13px]">{pageMeta.sub}</p>}
          </div>
          <div className="flex items-center gap-3">
            <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-emerald-300 border border-emerald-400/30 rounded-xl hover:bg-emerald-400/10 transition-all">
              <MessageCircle size={14} /> Support
            </a>
            <Link to="/client/profile" className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-white/5 transition-all" title="My profile">
              <span className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white"
                    style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>{initials}</span>
              <span className="text-white text-sm font-semibold max-w-[140px] truncate">{user?.fullName || 'Member'}</span>
            </Link>
          </div>
        </header>

        {/* Mobile Top Bar */}
        <div className="ds-topbar lg:hidden flex items-center justify-between h-14 px-4 border-b flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)} className="text-white/70 hover:text-white transition-colors" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <BrandLogo size="sm" glow />
          <Link to="/client/profile" className="text-white/70 hover:text-white transition-colors" aria-label="Profile">
            <User size={20} />
          </Link>
        </div>

        {/* Page Content */}
        <main className="app-main flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8" style={{ background: 'var(--gradient-app)' }}>
          <div className="max-w-[1200px] mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default ClientLayoutEnhanced;

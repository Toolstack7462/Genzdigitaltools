import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Package, User, LogOut, Menu, X,
  HelpCircle, ChevronRight, MessageCircle
} from 'lucide-react';
import { authService } from '../services/authService';
import { useToast } from './Toast';
import BrandLogo from './BrandLogo';

// ============================================================================
// SHARED THEME CONSTANTS
// ============================================================================
export const CATEGORY_COLORS = {
  'AI':               { gradient: 'from-purple-500 to-purple-600', bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-400'  },
  'Academic':         { gradient: 'from-blue-500 to-blue-600',     bg: 'bg-blue-500/10',   border: 'border-blue-500/30',   text: 'text-blue-400'    },
  'SEO':              { gradient: 'from-green-500 to-green-600',   bg: 'bg-green-500/10',  border: 'border-green-500/30',  text: 'text-green-400'   },
  'Productivity':     { gradient: 'from-yellow-500 to-yellow-600', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-400'  },
  'Graphics & SEO':   { gradient: 'from-pink-500 to-pink-600',     bg: 'bg-pink-500/10',   border: 'border-pink-500/30',   text: 'text-pink-400'    },
  'Text Humanizers':  { gradient: 'from-indigo-500 to-indigo-600', bg: 'bg-indigo-500/10', border: 'border-indigo-500/30', text: 'text-indigo-400'  },
  'Career-Oriented':  { gradient: 'from-orange-500 to-orange-600', bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400'  },
  'Miscellaneous':    { gradient: 'from-cyan-500 to-cyan-600',     bg: 'bg-cyan-500/10',   border: 'border-cyan-500/30',   text: 'text-cyan-400'    },
  'Other':            { gradient: 'from-gray-500 to-gray-600',     bg: 'bg-gray-500/10',   border: 'border-gray-500/30',   text: 'text-gray-400'    },
  'AI Writing':       { gradient: 'from-genz-teal to-genz-dark-teal', bg: 'bg-genz-teal/10', border: 'border-genz-teal/30', text: 'text-genz-teal' },
};

export const getCategoryTheme = (category) =>
  CATEGORY_COLORS[category] || CATEGORY_COLORS['Other'];

export const getCategoryGradient = (category) =>
  getCategoryTheme(category).gradient;

export const CARD_VARIANTS = {
  default:  'bg-white/[0.04] border border-white/10 backdrop-blur-sm',
  elevated: 'bg-white/[0.06] border border-white/15 backdrop-blur-sm shadow-xl',
  teal:     'bg-genz-teal/10 border border-genz-teal/30',
  blue:     'bg-blue-500/10 border border-blue-500/30',
  green:    'bg-green-500/10 border border-green-500/30',
  yellow:   'bg-yellow-500/10 border border-yellow-500/30',
  purple:   'bg-purple-500/10 border border-purple-500/30',
  orange:   'bg-orange-500/10 border border-orange-500/30',
  pink:     'bg-pink-500/10 border border-pink-500/30',
  cyan:     'bg-cyan-500/10 border border-cyan-500/30',
  indigo:   'bg-indigo-500/10 border border-indigo-500/30',
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
    { to: '/client/profile',   icon: User,            label: 'Profile'   },
  ];

  const isActive = (path) => location.pathname === path;
  const pageMeta = getPageMeta(location.pathname);
  const initials = user?.fullName
    ? user.fullName.split(' ').map((n) => n[0]).join('').slice(0, 2)
    : 'M';

  const Sidebar = ({ mobile = false }) => (
    <div className={`flex flex-col h-full ${mobile ? 'w-full' : 'w-64'}`}
         style={{ background: 'linear-gradient(180deg, #000a1f 0%, #001030 100%)', borderRight: '1px solid rgba(0,175,193,0.12)' }}>
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b" style={{ borderColor: 'rgba(0,175,193,0.1)' }}>
        <Link to="/client/dashboard" onClick={() => setSidebarOpen(false)} aria-label="Gen Z Digital Store dashboard">
          <BrandLogo variant="horizontal" size="sm" />
        </Link>
      </div>

      {/* User Info */}
      {user && (
        <div className="p-4 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
          <div className="flex items-center gap-3 p-3 rounded-xl"
               style={{ background: 'rgba(0,175,193,0.07)', border: '1px solid rgba(0,175,193,0.12)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-genz-deep-navy flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
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
        <p className="px-3 mb-2 text-[10px] font-bold uppercase tracking-widest text-white/55">Menu</p>
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = isActive(to);
          return (
            <Link key={to} to={to}
                  onClick={() => setSidebarOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    active ? 'text-genz-deep-navy' : 'text-white/55 hover:text-white hover:bg-white/5'
                  }`}
                  style={active ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)', boxShadow: '0 6px 18px rgba(0,175,193,0.28)' } : {}}>
              <Icon size={17} />
              {label}
              {active && <ChevronRight size={14} className="ml-auto" />}
            </Link>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className="p-4 border-t space-y-1" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
           className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/55 hover:text-white hover:bg-white/5 transition-all">
          <HelpCircle size={17} />
          Get Support
        </a>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/55 hover:text-red-400 hover:bg-red-500/5 transition-all">
          <LogOut size={17} />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#000820' }}>
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
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
              <button className="absolute top-4 right-4 text-white/50 hover:text-white transition-colors"
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
        <header className="hidden lg:flex items-center justify-between h-16 px-6 sm:px-8 border-b flex-shrink-0 z-20"
                style={{ background: 'rgba(0,8,32,0.82)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', borderColor: 'rgba(0,175,193,0.1)' }}>
          <div>
            <h1 className="text-white font-bold text-lg leading-tight" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>{pageMeta.title}</h1>
            {pageMeta.sub && <p className="text-white/55 text-xs">{pageMeta.sub}</p>}
          </div>
          <div className="flex items-center gap-3">
            <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-green-400 border border-green-500/30 rounded-full hover:bg-green-500/10 transition-all">
              <MessageCircle size={13} /> Support
            </a>
            <Link to="/client/profile" className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-white/5 transition-all" title="My profile">
              <span className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-genz-deep-navy"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>{initials}</span>
              <span className="text-white/80 text-sm font-medium max-w-[140px] truncate">{user?.fullName || 'Member'}</span>
            </Link>
          </div>
        </header>

        {/* Mobile Top Bar */}
        <div className="lg:hidden flex items-center justify-between h-14 px-4 border-b flex-shrink-0"
             style={{ background: 'rgba(0,12,32,0.92)', backdropFilter: 'blur(12px)', borderColor: 'rgba(0,175,193,0.08)' }}>
          <button onClick={() => setSidebarOpen(true)} className="text-white/60 hover:text-white transition-colors" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <BrandLogo variant="horizontal" size="sm" />
          <Link to="/client/profile" className="text-white/60 hover:text-genz-teal transition-colors" aria-label="Profile">
            <User size={20} />
          </Link>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8 relative">
          <div className="mesh-bg opacity-60" aria-hidden="true" />
          <div className="relative z-10 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default ClientLayoutEnhanced;

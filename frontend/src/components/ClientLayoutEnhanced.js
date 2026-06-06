import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Package, User, LogOut, Menu, X,
  Bell, HelpCircle, ChevronRight
} from 'lucide-react';
import { authService } from '../services/authService';
import { useToast } from './Toast';
import GenZDigitalStoreLogo from './GenZDigitalStoreLogo';

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

// ============================================================================
// MAIN LAYOUT COMPONENT
// ============================================================================
const ClientLayoutEnhanced = ({ children }) => {
  const navigate  = useNavigate();
  const location  = useLocation();
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

  const Sidebar = ({ mobile = false }) => (
    <div className={`flex flex-col h-full ${mobile ? '' : 'w-64'}`}
         style={{ background: 'linear-gradient(180deg, #000c20 0%, #001030 100%)', borderRight: '1px solid rgba(0,175,193,0.1)' }}>
      {/* Logo */}
      <div className="p-5 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <Link to="/client/dashboard" onClick={() => setSidebarOpen(false)}>
          <GenZDigitalStoreLogo className="h-9" textSize="base" />
        </Link>
      </div>

      {/* User Info */}
      {user && (
        <div className="p-4 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
          <div className="flex items-center gap-3 p-3 rounded-xl"
               style={{ background: 'rgba(0,175,193,0.08)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-genz-deep-navy flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              {user.fullName ? user.fullName.split(' ').map(n => n[0]).join('').slice(0, 2) : 'M'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold truncate">{user.fullName || 'Member'}</p>
              <p className="text-genz-muted text-xs truncate">{user.email}</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <Link key={to} to={to}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all group ${
                  isActive(to)
                    ? 'text-genz-deep-navy'
                    : 'text-genz-muted hover:text-white hover:bg-white/5'
                }`}
                style={isActive(to) ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
            <Icon size={17} />
            {label}
            {isActive(to) && <ChevronRight size={13} className="ml-auto" />}
          </Link>
        ))}
      </nav>

      {/* Bottom actions */}
      <div className="p-4 border-t space-y-1" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <a href="https://wa.me/" target="_blank" rel="noopener noreferrer"
           className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-genz-muted hover:text-white hover:bg-white/5 transition-all">
          <HelpCircle size={17} />
          Get Support
        </a>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-genz-muted hover:text-red-400 hover:bg-red-500/5 transition-all">
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
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative w-72 h-full">
            <Sidebar mobile />
            <button className="absolute top-4 right-4 text-genz-muted hover:text-white transition-colors"
                    onClick={() => setSidebarOpen(false)}>
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile Top Bar */}
        <div className="lg:hidden flex items-center justify-between p-4 border-b"
             style={{ background: '#000c20', borderColor: 'rgba(0,175,193,0.08)' }}>
          <button onClick={() => setSidebarOpen(true)} className="text-genz-muted hover:text-white transition-colors">
            <Menu size={22} />
          </button>
          <GenZDigitalStoreLogo className="h-7" textSize="sm" />
          <Link to="/client/profile" className="text-genz-muted hover:text-genz-teal transition-colors">
            <User size={20} />
          </Link>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
};

export default ClientLayoutEnhanced;

import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Package, Users, Activity, LogOut, FileText, Mail,
  Menu, X, ChevronRight, Shield, Settings, TrendingUp, ShieldAlert
} from 'lucide-react';
import GenZDigitalStoreLogo from './GenZDigitalStoreLogo';

const AdminLayoutEnhanced = ({ children }) => {
  const navigate  = useNavigate();
  const location  = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminUser, setAdminUser] = useState(null);

  useEffect(() => {
    const stored = localStorage.getItem('adminUser');
    if (stored) {
      try { setAdminUser(JSON.parse(stored)); } catch {}
    } else {
      navigate('/admin/login');
    }
  }, [navigate]);

  const handleLogout = async () => {
    try {
      // Call backend logout — this clears httpOnly cookies server-side.
      // document.cookie cannot clear httpOnly cookies from the browser.
      await fetch('/api/crm/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // Even if the network call fails, clear local state and redirect
    } finally {
      localStorage.removeItem('adminUser');
      navigate('/admin/login');
    }
  };

  const navItems = [
    { to: '/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard'  },
    { to: '/admin/tools',     icon: Package,         label: 'Tools'      },
    { to: '/admin/clients',   icon: Users,           label: 'Members'    },
    { to: '/admin/assign',    icon: Activity,        label: 'Assignments'},
    { to: '/admin/activity',  icon: Activity,        label: 'Activity'   },
    { to: '/admin/blog',      icon: FileText,        label: 'Blog'       },
    { to: '/admin/contacts',  icon: Mail,            label: 'Contacts'   },
    { to: '/admin/analytics', icon: TrendingUp,     label: 'Analytics'  },
    { to: '/admin/security',  icon: ShieldAlert,    label: 'Security'   },
  ];

  const isActive = (path) => location.pathname.startsWith(path);

  const SidebarContent = () => (
    <div className="flex flex-col h-full"
         style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)', borderRight: '1px solid rgba(0,175,193,0.1)' }}>
      <div className="p-5 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <Link to="/admin/dashboard" onClick={() => setSidebarOpen(false)}>
          <GenZDigitalStoreLogo className="h-9" textSize="base" />
        </Link>
        <div className="mt-3 flex items-center gap-1.5 px-2 py-1 rounded-lg"
             style={{ background: 'rgba(0,175,193,0.1)' }}>
          <Shield size={11} className="text-genz-teal" />
          <span className="text-xs text-genz-teal font-medium">Admin Panel</span>
        </div>
      </div>

      {adminUser && (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-genz-deep-navy"
                 style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              {(adminUser.fullName || 'A').charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-white text-xs font-semibold truncate">{adminUser.fullName}</p>
              <p className="text-genz-muted" style={{ fontSize: '10px' }}>{adminUser.role}</p>
            </div>
          </div>
        </div>
      )}

      <nav className="flex-1 p-3 space-y-0.5">
        {navItems.map(({ to, icon: Icon, label }) => (
          <Link key={to} to={to}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive(to)
                    ? 'text-genz-deep-navy'
                    : 'text-genz-muted hover:text-white hover:bg-white/5'
                }`}
                style={isActive(to) ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>

      <div className="p-3 border-t" style={{ borderColor: 'rgba(0,175,193,0.08)' }}>
        <Link to="/" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-genz-muted hover:text-white hover:bg-white/5 transition-all">
          <Settings size={16} />
          View Website
        </Link>
        <button onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-genz-muted hover:text-red-400 hover:bg-red-500/5 transition-all">
          <LogOut size={16} />
          Sign Out
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
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <div className="relative w-64 h-full">
            <SidebarContent />
            <button className="absolute top-4 right-4 text-genz-muted hover:text-white"
                    onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b"
             style={{ background: '#000c20', borderColor: 'rgba(0,175,193,0.08)' }}>
          <button onClick={() => setSidebarOpen(true)} className="text-genz-muted hover:text-white">
            <Menu size={20} />
          </button>
          <GenZDigitalStoreLogo className="h-7" textSize="sm" />
          <div className="w-6" />
        </div>
        <main className="flex-1 overflow-y-auto p-6">
          {children}
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

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Package, LogOut, User } from 'lucide-react';
import { authService } from '../services/authService';
import GenZDigitalStoreLogo from './GenZDigitalStoreLogo';

const ClientLayout = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  
  const isActive = (path) => location.pathname.startsWith(path);
  
  const handleLogout = async () => {
    await authService.logout();
    navigate('/client/login');
  };
  
  const navItems = [
    { path: '/client/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/client/tools', icon: Package, label: 'My Tools' },
    { path: '/client/profile', icon: User, label: 'Profile' }
  ];
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E1F24] to-[#24252B]">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[rgba(30,31,36,0.9)] backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/client/dashboard" className="flex items-center">
              <GenZDigitalStoreLogo className="h-10" />
              <span className="ml-3 text-sm text-genz-muted">Client Portal</span>
            </Link>
            
            <div className="flex items-center space-x-6">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                      isActive(item.path)
                        ? 'text-genz-teal'
                        : 'text-white hover:text-genz-teal'
                    }`}
                  >
                    <Icon size={18} />
                    <span className="hidden md:inline">{item.label}</span>
                  </Link>
                );
              })}
              
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-sm font-medium text-white hover:text-genz-teal transition-colors"
              >
                <LogOut size={18} />
                <span className="hidden md:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </nav>
      
      {/* Main Content */}
      <main className="pt-16">
        {children}
      </main>
    </div>
  );
};

export default ClientLayout;

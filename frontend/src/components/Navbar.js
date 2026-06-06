import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, Zap } from 'lucide-react';
import BrandLogo from './BrandLogo';

const Navbar = () => {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (path) => location.pathname === path;

  const navLinks = [
    { to: '/tools',   label: 'Tools'   },
    { to: '/pricing', label: 'Pricing' },
    { to: '/blog',    label: 'Blog'    },
    { to: '/about',   label: 'About'   },
    { to: '/contact', label: 'Contact' },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50"
         style={{ background: 'rgba(0,16,48,0.92)', backdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(0,175,193,0.15)' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <Link to="/" className="flex items-center" data-testid="navbar-logo">
            <BrandLogo variant="horizontal" size="md" />
          </Link>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center space-x-8">
            {navLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`text-sm font-medium transition-all duration-200 relative group ${
                  isActive(to)
                    ? 'text-genz-teal'
                    : 'text-white/80 hover:text-genz-teal'
                }`}
                data-testid={`nav-${label.toLowerCase()}`}
              >
                {label}
                <span className={`absolute -bottom-0.5 left-0 w-full h-0.5 bg-genz-teal transform transition-all duration-200 ${
                  isActive(to) ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                }`} />
              </Link>
            ))}
          </div>

          {/* Desktop CTAs */}
          <div className="hidden sm:flex items-center space-x-3">
            <Link
              to="/client/login"
              className="px-4 py-2 text-sm font-medium text-genz-teal border border-genz-teal/40 rounded-full hover:bg-genz-teal/10 transition-all duration-200"
              data-testid="nav-client-login"
            >
              Client Login
            </Link>
            <Link
              to="/join"
              className="px-5 py-2 text-sm font-semibold text-genz-deep-navy rounded-full transition-all duration-200 hover:opacity-90 hover:scale-105 transform"
              style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}
              data-testid="nav-get-started"
            >
              <Zap size={14} className="inline mr-1" />
              Get Started
            </Link>
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden text-white/80 hover:text-genz-teal transition-colors"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Menu */}
        {mobileOpen && (
          <div className="md:hidden pb-4 border-t border-genz-teal/10 pt-4">
            {navLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setMobileOpen(false)}
                className={`block py-2 px-2 text-sm font-medium rounded-lg mb-1 transition-colors ${
                  isActive(to)
                    ? 'text-genz-teal bg-genz-teal/10'
                    : 'text-white/80 hover:text-genz-teal hover:bg-genz-teal/5'
                }`}
              >
                {label}
              </Link>
            ))}
            <div className="flex space-x-3 mt-4 pt-4 border-t border-genz-teal/10">
              <Link to="/client/login" onClick={() => setMobileOpen(false)}
                className="flex-1 text-center px-4 py-2 text-sm text-genz-teal border border-genz-teal/40 rounded-full hover:bg-genz-teal/10 transition-all">
                Client Login
              </Link>
              <Link to="/join" onClick={() => setMobileOpen(false)}
                className="flex-1 text-center px-4 py-2 text-sm font-semibold text-genz-deep-navy rounded-full"
                style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                Get Started
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navbar;

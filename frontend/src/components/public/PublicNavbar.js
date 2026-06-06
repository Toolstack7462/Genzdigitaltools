import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, ChevronDown, Zap, MessageCircle } from 'lucide-react';
import GenZDigitalStoreLogo from '../GenZDigitalStoreLogo';

const SERVICES = [
  { to: '/services/digital-tools',         label: 'Digital Tools Access' },
  { to: '/services/social-media-management', label: 'Social Media Management' },
  { to: '/services/writing-services',       label: 'Writing Services' },
  { to: '/services/web-design-development', label: 'Web Design & Development' },
  { to: '/services/app-development',        label: 'App Development' },
  { to: '/services/branding-design',        label: 'Branding & Design' },
  { to: '/services/seo-digital-growth',     label: 'SEO & Digital Growth' },
];

const NAV_LINKS = [
  { to: '/services', label: 'Services', hasDropdown: true },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/pricing',  label: 'Pricing'   },
  { to: '/about',    label: 'About'     },
  { to: '/contact',  label: 'Contact'   },
];

const WHATSAPP_URL = 'https://wa.me/923027467462';

const PublicNavbar = () => {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [mobileServicesOpen, setMobileServicesOpen] = useState(false);
  const dropdownRef = useRef(null);

  const isActive = (path) =>
    path === '/services'
      ? location.pathname === '/services' || location.pathname.startsWith('/services/')
      : location.pathname === path;

  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setServicesOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setServicesOpen(false);
    setMobileServicesOpen(false);
  }, [location.pathname]);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50"
      style={{
        background: 'rgba(0,8,32,0.94)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(0,175,193,0.12)',
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <Link to="/" className="flex items-center flex-shrink-0">
            <GenZDigitalStoreLogo className="h-9" textSize="lg" />
          </Link>

          {/* Desktop Nav */}
          <div className="hidden lg:flex items-center space-x-7">
            {NAV_LINKS.map(({ to, label, hasDropdown }) =>
              hasDropdown ? (
                <div key={to} className="relative" ref={dropdownRef}>
                  <button
                    className={`flex items-center gap-1 text-sm font-medium transition-all duration-200 ${
                      isActive(to) ? 'text-genz-teal' : 'text-white/80 hover:text-genz-teal'
                    }`}
                    aria-haspopup="true"
                    aria-expanded={servicesOpen}
                    aria-controls="services-menu"
                    onMouseEnter={() => setServicesOpen(true)}
                    onMouseLeave={() => setServicesOpen(false)}
                    onClick={() => setServicesOpen(!servicesOpen)}
                  >
                    {label}
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${servicesOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {servicesOpen && (
                    <div
                      id="services-menu"
                      role="menu"
                      className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 rounded-2xl overflow-hidden shadow-2xl"
                      style={{
                        background: 'rgba(0,8,32,0.98)',
                        border: '1px solid rgba(0,175,193,0.2)',
                        backdropFilter: 'blur(20px)',
                      }}
                      onMouseEnter={() => setServicesOpen(true)}
                      onMouseLeave={() => setServicesOpen(false)}
                    >
                      <div className="p-2">
                        {SERVICES.map(({ to: sTo, label: sLabel }) => (
                          <Link
                            key={sTo}
                            to={sTo}
                            className="block px-4 py-2.5 text-sm text-white/75 hover:text-genz-teal hover:bg-genz-teal/8 rounded-xl transition-all duration-150"
                          >
                            {sLabel}
                          </Link>
                        ))}
                        <div className="border-t border-genz-teal/10 mt-2 pt-2">
                          <Link
                            to="/services"
                            className="block px-4 py-2.5 text-sm font-semibold text-genz-teal hover:bg-genz-teal/10 rounded-xl transition-all"
                          >
                            View All Services →
                          </Link>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={to}
                  to={to}
                  className={`text-sm font-medium transition-all duration-200 relative group ${
                    isActive(to) ? 'text-genz-teal' : 'text-white/80 hover:text-genz-teal'
                  }`}
                >
                  {label}
                  <span
                    className={`absolute -bottom-0.5 left-0 w-full h-0.5 bg-genz-teal transform transition-all duration-200 ${
                      isActive(to) ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                    }`}
                  />
                </Link>
              )
            )}
          </div>

          {/* Desktop CTAs */}
          <div className="hidden lg:flex items-center gap-3">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-green-400 border border-green-500/30 rounded-full hover:bg-green-500/10 transition-all duration-200"
            >
              <MessageCircle size={13} />
              WhatsApp
            </a>
            <Link
              to="/client/login"
              className="px-4 py-2 text-sm font-medium text-genz-teal border border-genz-teal/40 rounded-full hover:bg-genz-teal/10 transition-all duration-200"
            >
              Member Login
            </Link>
            <Link
              to="/contact"
              className="px-5 py-2 text-sm font-semibold text-genz-deep-navy rounded-full transition-all duration-200 hover:opacity-90 hover:scale-105"
              style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}
            >
              <Zap size={13} className="inline mr-1" />
              Get Started
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            className="lg:hidden text-white/80 hover:text-genz-teal transition-colors p-1"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Menu */}
        {mobileOpen && (
          <div
            id="mobile-menu"
            className="lg:hidden pb-5 pt-3 border-t"
            style={{ borderColor: 'rgba(0,175,193,0.1)' }}
          >
            {NAV_LINKS.map(({ to, label, hasDropdown }) =>
              hasDropdown ? (
                <div key={to}>
                  <button
                    className="w-full flex items-center justify-between py-2.5 px-2 text-sm font-medium text-white/80 hover:text-genz-teal rounded-lg mb-1 transition-colors"
                    onClick={() => setMobileServicesOpen(!mobileServicesOpen)}
                    aria-expanded={mobileServicesOpen}
                  >
                    {label}
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${mobileServicesOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {mobileServicesOpen && (
                    <div className="ml-3 mb-2 space-y-0.5">
                      {SERVICES.map(({ to: sTo, label: sLabel }) => (
                        <Link
                          key={sTo}
                          to={sTo}
                          className="block py-2 px-3 text-sm text-white/60 hover:text-genz-teal hover:bg-genz-teal/5 rounded-lg transition-colors"
                        >
                          {sLabel}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={to}
                  to={to}
                  className={`block py-2.5 px-2 text-sm font-medium rounded-lg mb-1 transition-colors ${
                    isActive(to)
                      ? 'text-genz-teal bg-genz-teal/10'
                      : 'text-white/80 hover:text-genz-teal hover:bg-genz-teal/5'
                  }`}
                >
                  {label}
                </Link>
              )
            )}
            <div className="flex flex-col gap-2.5 mt-4 pt-4 border-t" style={{ borderColor: 'rgba(0,175,193,0.1)' }}>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-green-400 border border-green-500/30 rounded-full hover:bg-green-500/10 transition-all"
              >
                <MessageCircle size={14} />
                Chat on WhatsApp
              </a>
              <Link
                to="/client/login"
                className="text-center py-2.5 text-sm text-genz-teal border border-genz-teal/40 rounded-full hover:bg-genz-teal/10 transition-all"
              >
                Member Login
              </Link>
              <Link
                to="/contact"
                className="text-center py-2.5 text-sm font-semibold text-genz-deep-navy rounded-full"
                style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}
              >
                Get Started
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default PublicNavbar;
export { WHATSAPP_URL };

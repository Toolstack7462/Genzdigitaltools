import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, ChevronDown, ArrowRight, MessageCircle } from 'lucide-react';
import BrandLogo from '../BrandLogo';

const SERVICES = [
  { to: '/services/digital-tools',          label: 'Digital Tools Access' },
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
const APP_LOGIN_URL = 'https://app.genzdigitalstore.com/client/login';

const PublicNavbar = () => {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [mobileServicesOpen, setMobileServicesOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
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
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setServicesOpen(false);
    setMobileServicesOpen(false);
  }, [location.pathname]);

  const linkBase =
    'text-[15px] font-medium transition-colors duration-200 relative';

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-shadow duration-300"
      style={{
        background: 'rgba(255,255,255,0.82)',
        backdropFilter: 'blur(18px) saturate(160%)',
        WebkitBackdropFilter: 'blur(18px) saturate(160%)',
        borderBottom: '1px solid rgba(13,42,71,0.08)',
        boxShadow: scrolled ? '0 6px 24px rgba(7,27,51,0.07)' : 'none',
      }}
    >
      <div className="mx-auto w-full max-w-[1200px] px-5 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-[72px]">

          {/* Logo */}
          <Link to="/" className="flex items-center flex-shrink-0" aria-label="Gen Z Digital Store — home" data-testid="public-nav-brand">
            <BrandLogo size="lg" />
          </Link>

          {/* Desktop Nav */}
          <div className="hidden lg:flex items-center gap-8">
            {NAV_LINKS.map(({ to, label, hasDropdown }) =>
              hasDropdown ? (
                <div key={to} className="relative" ref={dropdownRef}>
                  <button
                    className={`${linkBase} flex items-center gap-1 ${
                      isActive(to) ? 'text-genz-blue' : 'text-genz-navy/75 hover:text-genz-blue'
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
                      className="absolute top-full left-1/2 -translate-x-1/2 mt-3 w-72 rounded-2xl overflow-hidden p-2"
                      style={{
                        background: '#ffffff',
                        border: '1px solid rgba(13,42,71,0.08)',
                        boxShadow: '0 24px 60px rgba(7,27,51,0.16)',
                      }}
                      onMouseEnter={() => setServicesOpen(true)}
                      onMouseLeave={() => setServicesOpen(false)}
                    >
                      {SERVICES.map(({ to: sTo, label: sLabel }) => (
                        <Link
                          key={sTo}
                          to={sTo}
                          className="block px-4 py-2.5 text-[14px] font-medium text-genz-navy/70 hover:text-genz-blue hover:bg-genz-blue/[0.06] rounded-xl transition-colors duration-150"
                        >
                          {sLabel}
                        </Link>
                      ))}
                      <div className="border-t border-genz-border mt-2 pt-2">
                        <Link
                          to="/services"
                          className="flex items-center justify-between px-4 py-2.5 text-[14px] font-semibold text-genz-blue hover:bg-genz-blue/[0.06] rounded-xl transition-colors"
                        >
                          View All Services <ArrowRight size={14} />
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={to}
                  to={to}
                  className={`${linkBase} group ${
                    isActive(to) ? 'text-genz-blue' : 'text-genz-navy/75 hover:text-genz-blue'
                  }`}
                >
                  {label}
                  <span
                    className={`absolute -bottom-1.5 left-0 h-0.5 w-full rounded-full bg-genz-blue origin-left transform transition-transform duration-200 ${
                      isActive(to) ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                    }`}
                  />
                </Link>
              )
            )}
          </div>

          {/* Desktop CTAs */}
          <div className="hidden lg:flex items-center gap-2.5">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3.5 py-2 text-[14px] font-semibold text-emerald-600 rounded-xl hover:bg-emerald-50 transition-colors duration-200"
            >
              <MessageCircle size={15} />
              WhatsApp
            </a>
            <a
              href={APP_LOGIN_URL}
              className="px-4 py-2.5 text-[15px] font-semibold text-genz-navy rounded-[14px] border border-genz-border hover:border-genz-blue/40 hover:text-genz-blue transition-colors duration-200"
            >
              Member Login
            </a>
            <Link
              to="/client/signup"
              data-testid="public-nav-get-started-desktop"
              className="flex items-center gap-1.5 px-5 py-2.5 text-[15px] font-bold text-white rounded-[14px] transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: 'linear-gradient(135deg,#2563EB 0%,#06B6D4 100%)',
                boxShadow: '0 8px 20px rgba(37,99,235,0.25)',
              }}
            >
              Get Started <ArrowRight size={15} />
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            className="lg:hidden text-genz-navy hover:text-genz-blue transition-colors p-1.5 -mr-1.5"
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
            className="lg:hidden pb-5 pt-2 border-t animate-fade-up"
            style={{ borderColor: 'rgba(13,42,71,0.08)' }}
          >
            {NAV_LINKS.map(({ to, label, hasDropdown }) =>
              hasDropdown ? (
                <div key={to}>
                  <button
                    className="w-full flex items-center justify-between py-3 px-2 text-[15px] font-medium text-genz-navy/80 hover:text-genz-blue rounded-xl transition-colors"
                    onClick={() => setMobileServicesOpen(!mobileServicesOpen)}
                    aria-expanded={mobileServicesOpen}
                  >
                    {label}
                    <ChevronDown
                      size={15}
                      className={`transition-transform duration-200 ${mobileServicesOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {mobileServicesOpen && (
                    <div className="ml-3 mb-2 space-y-0.5 border-l border-genz-border pl-3">
                      {SERVICES.map(({ to: sTo, label: sLabel }) => (
                        <Link
                          key={sTo}
                          to={sTo}
                          className="block py-2.5 px-2 text-[14px] text-genz-navy/60 hover:text-genz-blue rounded-lg transition-colors"
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
                  className={`block py-3 px-2 text-[15px] font-medium rounded-xl transition-colors ${
                    isActive(to)
                      ? 'text-genz-blue bg-genz-blue/[0.06]'
                      : 'text-genz-navy/80 hover:text-genz-blue hover:bg-genz-blue/[0.04]'
                  }`}
                >
                  {label}
                </Link>
              )
            )}
            <div className="flex flex-col gap-2.5 mt-4 pt-4 border-t" style={{ borderColor: 'rgba(13,42,71,0.08)' }}>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 py-3 text-[15px] font-semibold text-emerald-600 border border-emerald-200 rounded-[14px] hover:bg-emerald-50 transition-colors"
              >
                <MessageCircle size={16} />
                Chat on WhatsApp
              </a>
              <a
                href={APP_LOGIN_URL}
                className="text-center py-3 text-[15px] font-semibold text-genz-navy border border-genz-border rounded-[14px] hover:border-genz-blue/40 hover:text-genz-blue transition-colors"
              >
                Member Login
              </a>
              <Link
                to="/client/signup"
                data-testid="public-nav-get-started-mobile"
                className="text-center py-3 text-[15px] font-bold text-white rounded-[14px]"
                style={{ background: 'linear-gradient(135deg,#2563EB 0%,#06B6D4 100%)' }}
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
export { WHATSAPP_URL, APP_LOGIN_URL };

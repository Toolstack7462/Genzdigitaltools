import { Link } from 'react-router-dom';
import { Facebook, Instagram, Twitter, Youtube, MessageCircle, ArrowRight } from 'lucide-react';
import BrandLogo from '../BrandLogo';
import { WHATSAPP_URL } from './PublicNavbar';

const SERVICES_LINKS = [
  { to: '/services/digital-tools',           label: 'Digital Tools Access'       },
  { to: '/services/social-media-management', label: 'Social Media Management'    },
  { to: '/services/writing-services',        label: 'Writing Services'           },
  { to: '/services/web-design-development',  label: 'Web Design & Development'   },
  { to: '/services/app-development',         label: 'App Development'            },
  { to: '/services/branding-design',         label: 'Branding & Design'          },
  { to: '/services/seo-digital-growth',      label: 'SEO & Digital Growth'       },
];

const COMPANY_LINKS = [
  { to: '/about',     label: 'About Us'       },
  { to: '/portfolio', label: 'Portfolio'      },
  { to: '/pricing',   label: 'Pricing'        },
  { to: '/blog',      label: 'Blog'           },
  { to: '/contact',   label: 'Contact Us'     },
  { to: '/chrome-extension', label: 'Chrome Extension' },
];

const PublicFooter = () => {
  const year = new Date().getFullYear();

  return (
    <footer style={{ background: 'linear-gradient(180deg,#071B33 0%,#000820 100%)', borderTop: '1px solid rgba(6,182,212,0.15)' }}>
      {/* Top CTA band */}
      <div
        className="border-b"
        style={{ borderColor: 'rgba(6,182,212,0.1)', background: 'rgba(6,182,212,0.04)' }}
      >
        <div className="mx-auto max-w-[1200px] px-5 sm:px-6 lg:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-6">
          <div>
            <h3 className="text-white font-bold text-xl mb-1">
              Ready to grow your digital presence?
            </h3>
            <p className="text-white/50 text-sm">
              Talk to us about tools, services, or a custom solution.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white rounded-[14px] hover:-translate-y-0.5 transition-all"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 8px 20px rgba(37,99,235,0.25)' }}
            >
              <MessageCircle size={15} />
              Chat on WhatsApp
            </a>
            <Link
              to="/services"
              className="flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-genz-cyan border border-genz-cyan/40 rounded-[14px] hover:bg-genz-cyan/10 transition-all"
            >
              View Services <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>

      {/* Main footer */}
      <div className="mx-auto max-w-[1200px] px-5 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">

          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <Link to="/" className="inline-block mb-4">
              <BrandLogo variant="horizontal" size="md" />
            </Link>
            <p className="text-white/55 text-sm leading-relaxed mb-6 max-w-xs">
              Premium digital tools access, creative services, and smart web solutions
              — all from one platform built for creators, businesses, and digital professionals.
            </p>
            <div className="flex gap-3 flex-wrap">
              {[
                { Icon: Facebook, href: '#', label: 'Facebook' },
                { Icon: Instagram, href: '#', label: 'Instagram' },
                { Icon: Twitter, href: '#', label: 'Twitter' },
                { Icon: Youtube, href: '#', label: 'YouTube' },
                { Icon: MessageCircle, href: WHATSAPP_URL, label: 'WhatsApp' },
              ].map(({ Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target={href !== '#' ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-white/55 hover:text-genz-teal hover:bg-genz-teal/10 border border-white/8 hover:border-genz-teal/30 transition-all duration-200"
                >
                  <Icon size={15} />
                </a>
              ))}
            </div>
          </div>

          {/* Services */}
          <div>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-5">Services</h4>
            <ul className="space-y-2.5">
              {SERVICES_LINKS.map(({ to, label }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className="text-white/55 hover:text-genz-teal text-sm transition-colors duration-150"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-5">Company</h4>
            <ul className="space-y-2.5">
              {COMPANY_LINKS.map(({ to, label }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className="text-white/55 hover:text-genz-teal text-sm transition-colors duration-150"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Dashboard & Legal */}
          <div>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-5">Dashboard</h4>
            <ul className="space-y-2.5 mb-8">
              <li>
                <Link to="/client/login" className="text-genz-teal hover:text-genz-dark-teal text-sm font-medium transition-colors">
                  Member Login →
                </Link>
              </li>
              <li>
                <Link to="/client/dashboard" className="text-white/55 hover:text-genz-teal text-sm transition-colors">
                  Client Dashboard
                </Link>
              </li>
              <li>
                <Link to="/admin/login" className="text-white/55 hover:text-white/60 text-xs transition-colors">
                  Admin Panel
                </Link>
              </li>
            </ul>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-4">Legal</h4>
            <ul className="space-y-2.5">
              {['Terms of Service', 'Privacy Policy', 'Refund Policy'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-white/55 hover:text-white/60 text-xs transition-colors">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Disclaimer */}
        <p className="text-white/55 text-xs text-center leading-relaxed mb-6 max-w-3xl mx-auto">
          Services are provided for educational, productivity and professional support purposes.
          All tools accessed under authorized licensing — membership is for authorized use only.
        </p>

        {/* Bottom bar */}
        <div
          className="pt-8 border-t flex flex-col sm:flex-row items-center justify-between gap-4"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
        >
          <p className="text-white/55 text-xs">
            © {year} Gen Z Digital Store. All rights reserved.
          </p>
          <p className="text-white/25 text-xs text-center">
            Built for creators, students &amp; businesses.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default PublicFooter;

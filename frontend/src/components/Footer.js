import { Link } from 'react-router-dom';
import { Facebook, Twitter, Linkedin, Instagram, Youtube, MessageCircle } from 'lucide-react';
import GenZDigitalStoreLogo from './GenZDigitalStoreLogo';

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer style={{ background: '#000820', borderTop: '1px solid rgba(0,175,193,0.15)' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-12">

          {/* Logo & Description */}
          <div className="col-span-1 md:col-span-2">
            <Link to="/" className="inline-block mb-4">
              <GenZDigitalStoreLogo className="h-10" textSize="xl" />
            </Link>
            <p className="text-genz-muted text-sm mb-6 leading-relaxed max-w-sm">
              Your all-in-one digital tools hub. Access AI, academic, SEO, design, productivity,
              marketing, and business tools from one secure membership dashboard.
            </p>
            {/* Social Links */}
            <div className="flex space-x-4">
              {[
                { Icon: Facebook,       href: '#', label: 'Facebook'  },
                { Icon: Instagram,      href: '#', label: 'Instagram' },
                { Icon: Twitter,        href: '#', label: 'Twitter'   },
                { Icon: Youtube,        href: '#', label: 'YouTube'   },
                { Icon: MessageCircle,  href: '#', label: 'WhatsApp'  },
              ].map(({ Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-genz-muted hover:text-genz-teal hover:bg-genz-teal/10 transition-all duration-200 border border-genz-border/30 hover:border-genz-teal/40"
                >
                  <Icon size={16} />
                </a>
              ))}
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="text-white font-semibold text-sm uppercase tracking-wider mb-4">Quick Links</h3>
            <ul className="space-y-2.5">
              {[
                { to: '/tools',   label: 'Browse Tools'   },
                { to: '/pricing', label: 'Pricing'        },
                { to: '/about',   label: 'About Us'       },
                { to: '/blog',    label: 'Blog'           },
                { to: '/contact', label: 'Contact'        },
                { to: '/join',    label: 'Get Membership' },
              ].map(({ to, label }) => (
                <li key={to}>
                  <Link to={to}
                    className="text-genz-muted hover:text-genz-teal text-sm transition-colors duration-200">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="text-white font-semibold text-sm uppercase tracking-wider mb-4">Legal</h3>
            <ul className="space-y-2.5">
              {[
                'Terms of Service',
                'Privacy Policy',
                'Refund Policy',
                'Cookie Policy',
              ].map((item) => (
                <li key={item}>
                  <a href="#" className="text-genz-muted hover:text-genz-teal text-sm transition-colors duration-200">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-6 pt-5 border-t border-genz-border/20">
              <Link to="/client/login"
                className="text-xs text-genz-teal hover:underline font-medium">
                Member Login →
              </Link>
              <br />
              <Link to="/admin/login"
                className="text-xs text-genz-muted hover:text-genz-teal transition-colors">
                Admin Panel
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-genz-border/20 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-genz-muted text-xs">
            © {currentYear} Gen Z Digital Store. All rights reserved.
          </p>
          <p className="text-genz-muted text-xs">
            All tools are accessed under authorized licensing agreements.
            Membership is for personal, authorized use only.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;

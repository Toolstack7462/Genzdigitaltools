import { Link } from 'react-router-dom';
import { MessageCircle, ArrowRight, Mail, ShieldCheck, Clock, Sparkles } from 'lucide-react';
import BrandLogo from '../BrandLogo';
import { WHATSAPP_URL, APP_LOGIN_URL, APP_SIGNUP_URL, MAIN_SITE_URL, isAppSubdomain } from './PublicNavbar';

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
];

const PublicFooter = () => {
  const year = new Date().getFullYear();
  // On the app subdomain, footer marketing links must navigate to the main site
  // (same reason as the navbar). Footer targets are all real pages, so route + host.
  const onApp = isAppSubdomain();
  const FooterLink = ({ to, className, children, ...rest }) =>
    onApp
      ? <a href={`${MAIN_SITE_URL}${to}`} className={className} {...rest}>{children}</a>
      : <Link to={to} className={className} {...rest}>{children}</Link>;

  return (
    <footer
      className="relative overflow-hidden"
      style={{
        // Premium blended navy → blue → teal gradient with soft top glow.
        background:
          'radial-gradient(1100px 460px at 50% -8%, rgba(6,182,212,0.13) 0%, rgba(6,182,212,0) 62%),' +
          'radial-gradient(900px 500px at 100% 100%, rgba(37,99,235,0.12) 0%, rgba(37,99,235,0) 60%),' +
          'linear-gradient(168deg, #071B33 0%, #0B2F52 42%, #06243F 72%, #03101F 100%)',
        borderTop: '1px solid rgba(6,182,212,0.18)',
      }}
    >
      {/* Brand hairline accent */}
      <div className="brand-hairline" />

      {/* Top CTA band — glass panel */}
      <div
        className="border-b"
        style={{ borderColor: 'rgba(6,182,212,0.12)', background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(6px)' }}
      >
        <div className="mx-auto max-w-[1200px] px-5 sm:px-6 lg:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-6">
          <div>
            <h3 className="text-white font-bold text-xl sm:text-2xl mb-1 tracking-tight">
              Ready to grow your digital presence?
            </h3>
            <p className="text-white/55 text-sm">
              Talk to us about tools, services, or a custom solution.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white rounded-[14px] hover:-translate-y-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-cyan/60"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 10px 26px rgba(37,99,235,0.30)' }}
            >
              <MessageCircle size={15} />
              Chat on WhatsApp
            </a>
            <FooterLink
              to="/services"
              className="flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-genz-cyan border border-genz-cyan/40 rounded-[14px] hover:bg-genz-cyan/10 hover:border-genz-cyan/60 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-cyan/40"
            >
              View Services <ArrowRight size={14} />
            </FooterLink>
          </div>
        </div>
        {/* Trust strip */}
        <div className="mx-auto max-w-[1200px] px-5 sm:px-6 lg:px-8 pb-8 -mt-2">
          <div className="flex flex-wrap items-center gap-x-7 gap-y-2 text-white/55 text-[12.5px]">
            <span className="inline-flex items-center gap-2"><ShieldCheck size={15} className="text-genz-teal" /> Secure &amp; authorized access</span>
            <span className="inline-flex items-center gap-2"><Clock size={15} className="text-genz-teal" /> 24/7 support on WhatsApp</span>
            <span className="inline-flex items-center gap-2"><Sparkles size={15} className="text-genz-teal" /> Trusted by creators &amp; businesses</span>
          </div>
        </div>
      </div>

      {/* Main footer */}
      <div className="mx-auto max-w-[1200px] px-5 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">

          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <FooterLink to="/" className="inline-flex items-center gap-3 mb-4" aria-label="Gen Z Digital Store home">
              <BrandLogo size="footer" glow />
              <span className="text-white font-extrabold text-lg leading-tight tracking-tight">
                Gen Z Digital Store
              </span>
            </FooterLink>
            <p className="text-white/55 text-sm leading-relaxed mb-4 max-w-xs">
              Premium digital tools access, creative services, and smart web solutions,
              all from one platform built for creators, businesses, and digital professionals.
            </p>
            <a
              href="mailto:admin@genzdigitalstore.com"
              className="inline-flex items-center gap-2 text-white/60 hover:text-genz-teal text-sm mb-6 transition-colors duration-150"
            >
              <Mail size={15} /> admin@genzdigitalstore.com
            </a>
            {/* Connect — only real destinations (no dead links) */}
            <div className="flex gap-3 flex-wrap">
              {[
                { Icon: MessageCircle, href: WHATSAPP_URL, label: 'WhatsApp', external: true },
                { Icon: Mail, href: 'mailto:admin@genzdigitalstore.com', label: 'Email', external: false },
              ].map(({ Icon, href, label, external }) => (
                <a
                  key={label}
                  href={href}
                  target={external ? '_blank' : undefined}
                  rel={external ? 'noopener noreferrer' : undefined}
                  aria-label={label}
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-white/60 hover:text-genz-teal hover:bg-genz-teal/10 border border-white/10 hover:border-genz-teal/30 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-genz-teal/40"
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
                  <FooterLink
                    to={to}
                    className="text-white/55 hover:text-genz-teal text-sm transition-colors duration-150"
                  >
                    {label}
                  </FooterLink>
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
                  <FooterLink
                    to={to}
                    className="text-white/55 hover:text-genz-teal text-sm transition-colors duration-150"
                  >
                    {label}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </div>

          {/* Members & Legal */}
          <div>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-5">Members</h4>
            <ul className="space-y-2.5 mb-8">
              <li>
                <a href={APP_LOGIN_URL} className="text-genz-teal hover:text-genz-dark-teal text-sm font-medium transition-colors">
                  Member Login →
                </a>
              </li>
              <li>
                <a href={APP_SIGNUP_URL} className="text-white/55 hover:text-genz-teal text-sm transition-colors">
                  Get Started
                </a>
              </li>
            </ul>
            <h4 className="text-white font-semibold text-xs uppercase tracking-widest mb-4">Legal</h4>
            <ul className="space-y-2.5">
              {['Terms of Service', 'Privacy Policy', 'Refund Policy'].map((item) => (
                <li key={item}>
                  <FooterLink to="/contact" className="text-white/55 hover:text-genz-teal text-xs transition-colors duration-150">
                    {item}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Disclaimer */}
        <p className="text-white/55 text-xs text-center leading-relaxed mb-6 max-w-3xl mx-auto">
          Services are provided for educational, productivity and professional support purposes.
          All tools accessed under authorized licensing. Membership is for authorized use only.
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

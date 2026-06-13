import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import PortfolioCard from '../../components/public/PortfolioCard';
import PageHero from '../../components/public/PageHero';

const PORTFOLIO_ITEMS = [
  { title: 'Social Media Brand Kit Concept',      category: 'Branding',    colorAccent: '#DB2777', description: 'Complete brand identity concept including logo, colour palette, social media templates, and content style guide.',     tags: ['Branding','Social Media','Design'] },
  { title: 'Animated SaaS Landing Page Concept',  category: 'Web Design',  colorAccent: '#06B6D4', description: 'High-converting SaaS landing page with smooth CSS animations, glassmorphism cards, and a dark premium theme.',            tags: ['React','Tailwind CSS','Animation'] },
  { title: 'Client Dashboard UI Concept',         category: 'Web App',     colorAccent: '#7C3AED', description: 'Secure client portal UI with tool access cards, session management, and a clean dashboard layout.',                       tags: ['React','Dashboard','UI/UX'] },
  { title: 'Digital Tools Access Platform',       category: 'Web App',     colorAccent: '#14B8A6', description: 'Full-stack tool access platform with admin management, client dashboard, and Chrome extension integration.',              tags: ['Node.js','React','Extension'] },
  { title: 'Mobile App UI Concept',               category: 'App Dev',     colorAccent: '#2563EB', description: 'Polished mobile app UI concept with onboarding flow, dashboard screens, and a modern dark design system.',                tags: ['Mobile','UI/UX','Dark Theme'] },
  { title: 'SEO Growth Strategy Deck Concept',    category: 'SEO',         colorAccent: '#F97316', description: 'Professional presentation deck concept for an SEO growth strategy, with data visualisations and brand-aligned slides.',  tags: ['SEO','Design','Presentation'] },
  { title: 'E-Commerce Store Concept',            category: 'Web Design',  colorAccent: '#EC4899', description: 'Minimal e-commerce UI concept with product listing, cart, and checkout flows built on a clean light/dark design.',        tags: ['E-Commerce','Web Design','UI'] },
  { title: 'Business Automation Workflow Concept',category: 'Automation',  colorAccent: '#4F46E5', description: 'Workflow automation diagram and tool concept for streamlining business operations and client management.',                tags: ['Automation','CRM','System Design'] },
  { title: 'Writing Services Landing Page',       category: 'Web Design',  colorAccent: '#0891B2', description: 'Conversion-optimised landing page for a writing services business, with service cards, testimonials section, and FAQ.',  tags: ['Landing Page','Copywriting','Design'] },
];

const FILTERS = ['All', 'Branding', 'Web Design', 'Web App', 'App Dev', 'SEO', 'Automation'];

const Portfolio = () => {
  const [active, setActive] = useState('All');
  const [gridRef, gridV] = useReveal();

  const filtered = active === 'All' ? PORTFOLIO_ITEMS : PORTFOLIO_ITEMS.filter((p) => p.category === active);

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="Portfolio"
        title={<>Our Work & <span className="text-grad-brand">Concepts</span></>}
        subtitle="A collection of concepts, live platforms, and client work across branding, web, apps, and digital services."
      />

      {/* Filters */}
      <section className="px-5 -mt-6">
        <div className="gz-container">
          <div className="flex flex-wrap justify-center gap-2 mb-12">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setActive(f)}
                className={`px-4 py-2 rounded-full text-[13px] font-semibold transition-all duration-200 ${
                  active === f
                    ? 'text-white shadow-md'
                    : 'text-genz-navy/75 hover:text-genz-blue hover:border-genz-blue/40'
                }`}
                style={
                  active === f
                    ? { background: 'var(--gradient-cta)', boxShadow: '0 8px 22px -8px rgba(6,182,212,0.45)' }
                    : { background: '#ffffff', border: '1px solid var(--brand-border)' }
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Grid */}
      <section className="gz-section px-5 pt-0">
        <div ref={gridRef} className={`gz-container reveal ${gridV ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((item) => <PortfolioCard key={item.title} {...item} />)}
          </div>
          {filtered.length === 0 && (
            <div className="text-center py-20 text-genz-muted">No items in this category yet.</div>
          )}
        </div>
      </section>

      {/* Commission note */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div className="gz-container max-w-3xl">
          <div className="grad-border rounded-[24px] overflow-hidden">
            <div className="text-center rounded-[24px] p-10" style={{ background: 'var(--gradient-card), #ffffff' }}>
              <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> Commission a project</div>
              <h3 className="text-genz-navy font-extrabold font-heading text-2xl sm:text-3xl mb-3">
                Want something like this for <span className="text-grad-brand">your brand?</span>
              </h3>
              <p className="text-genz-muted text-[15px] mb-7 max-w-xl mx-auto leading-relaxed">
                Every concept shown here is available as a commissioned project.
                Contact us to discuss your requirements and get a custom proposal.
              </p>
              <Link to="/contact" className="btn-grad inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
                Commission a Project <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Portfolio;

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import PortfolioCard from '../../components/public/PortfolioCard';

const PORTFOLIO_ITEMS = [
  { title: 'Social Media Brand Kit Concept',     category: 'Branding',    colorAccent: '#e1306c', description: 'Complete brand identity concept including logo, colour palette, social media templates, and content style guide.',     tags: ['Branding','Social Media','Design'] },
  { title: 'Animated SaaS Landing Page Concept', category: 'Web Design',  colorAccent: '#00AFC1', description: 'High-converting SaaS landing page with smooth CSS animations, glassmorphism cards, and a dark premium theme.',            tags: ['React','Tailwind CSS','Animation'] },
  { title: 'Client Dashboard UI Concept',        category: 'Web App',     colorAccent: '#a78bfa', description: 'Secure client portal UI with tool access cards, session management, and a clean dashboard layout.',                       tags: ['React','Dashboard','UI/UX'] },
  { title: 'Digital Tools Access Platform',      category: 'Web App',     colorAccent: '#4ade80', description: 'Full-stack tool access platform with admin management, client dashboard, and Chrome extension integration.',              tags: ['Node.js','React','Extension'] },
  { title: 'Mobile App UI Concept',              category: 'App Dev',     colorAccent: '#60a5fa', description: 'Polished mobile app UI concept with onboarding flow, dashboard screens, and a modern dark design system.',                tags: ['Mobile','UI/UX','Dark Theme'] },
  { title: 'SEO Growth Strategy Deck Concept',   category: 'SEO',         colorAccent: '#fb923c', description: 'Professional presentation deck concept for an SEO growth strategy, with data visualisations and brand-aligned slides.',  tags: ['SEO','Design','Presentation'] },
  { title: 'E-Commerce Store Concept',           category: 'Web Design',  colorAccent: '#f472b6', description: 'Minimal e-commerce UI concept with product listing, cart, and checkout flows built on a clean light/dark design.',        tags: ['E-Commerce','Web Design','UI'] },
  { title: 'Business Automation Workflow Concept',category:'Automation',  colorAccent: '#818cf8', description: 'Workflow automation diagram and tool concept for streamlining business operations and client management.',                tags: ['Automation','CRM','System Design'] },
  { title: 'Writing Services Landing Page',      category: 'Web Design',  colorAccent: '#22d3ee', description: 'Conversion-optimised landing page for a writing services business, with service cards, testimonials section, and FAQ.',  tags: ['Landing Page','Copywriting','Design'] },
];

const FILTERS = ['All', 'Branding', 'Web Design', 'Web App', 'App Dev', 'SEO', 'Automation'];

const Portfolio = () => {
  const [active, setActive] = useState('All');
  const [heroRef, heroVisible] = useReveal(0.05);
  const [gridRef, gridVisible] = useReveal();

  const filtered = active === 'All' ? PORTFOLIO_ITEMS : PORTFOLIO_ITEMS.filter(p => p.category === active);

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(0,175,193,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> Portfolio
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            Our Work & <span className="text-gradient-teal">Concepts</span>
          </h1>
          <p className="text-white/55 text-base sm:text-lg leading-relaxed">
            A collection of concepts, live platforms, and client work across branding, web, apps, and digital services.
          </p>
        </div>
      </section>

      {/* Filters */}
      <section className="py-4 px-4">
        <div className="max-w-6xl mx-auto flex flex-wrap justify-center gap-2 mb-12">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setActive(f)}
              className={`px-4 py-2 rounded-full text-xs font-semibold transition-all ${
                active === f
                  ? 'text-genz-deep-navy'
                  : 'text-white/50 hover:text-white/80'
              }`}
              style={active === f
                ? { background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }
                : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      {/* Grid */}
      <section className="pb-24 px-4">
        <div ref={gridRef} className={`max-w-6xl mx-auto reveal ${gridVisible ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map(item => (
              <PortfolioCard key={item.title} {...item} />
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="text-center py-20 text-white/40">No items in this category yet.</div>
          )}
        </div>
      </section>

      {/* Commission note */}
      <section className="py-12 px-4">
        <div className="max-w-2xl mx-auto text-center rounded-3xl p-8"
          style={{ background: 'rgba(0,175,193,0.06)', border: '1px solid rgba(0,175,193,0.18)' }}>
          <h3 className="text-white font-bold text-lg mb-3">Want something like this for your brand?</h3>
          <p className="text-white/50 text-sm mb-6">
            Every concept shown here is available as a commissioned project.
            Contact us to discuss your requirements and get a custom proposal.
          </p>
          <Link to="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-genz-deep-navy transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
            Commission a project →
          </Link>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Portfolio;

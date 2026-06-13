import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Layers } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import PageHero from '../../components/public/PageHero';
import ShowcaseCard from '../../components/public/showcase/ShowcaseCard';
import SHOWCASE_ITEMS from '../../components/public/showcase/showcaseItems';

/* derive filter list from the showcase items so they stay in sync */
const ALL_TAGS = ['All', ...Array.from(new Set(SHOWCASE_ITEMS.map((s) => s.tag)))];

const Portfolio = () => {
  const [active, setActive] = useState('All');
  const [gridRef, gridV] = useReveal();

  const filtered =
    active === 'All' ? SHOWCASE_ITEMS : SHOWCASE_ITEMS.filter((s) => s.tag === active);

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="Featured Work"
        title={<>Our Work & <span className="text-grad-brand">Concepts</span></>}
        subtitle="Premium digital case studies — dashboards, landing pages, SaaS platforms, brand kits, extensions and client portals — all built with the same craft we bring to every Gen Z Digital Store project."
      />

      {/* Filters */}
      <section className="px-5 -mt-6">
        <div className="gz-container">
          <div className="flex flex-wrap justify-center gap-2 mb-12" data-testid="portfolio-filters">
            {ALL_TAGS.map((f) => (
              <button
                key={f}
                onClick={() => setActive(f)}
                className={`px-4 py-2 rounded-full text-[13px] font-semibold transition-all duration-200 ${
                  active === f
                    ? 'text-white shadow-md'
                    : 'text-genz-navy/75 hover:text-genz-blue'
                }`}
                style={
                  active === f
                    ? { background: 'var(--gradient-cta)', boxShadow: '0 8px 22px -8px rgba(6,182,212,0.45)' }
                    : { background: '#ffffff', border: '1px solid var(--brand-border)' }
                }
                data-testid={`portfolio-filter-${f.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Showcase grid */}
      <section className="gz-section px-5 pt-0">
        <div ref={gridRef} className={`gz-container reveal ${gridV ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-7">
            {filtered.map((item) => (
              <ShowcaseCard key={item.id} {...item} ctaTo="/contact" />
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="text-center py-20 text-genz-muted">No items in this category yet.</div>
          )}
        </div>
      </section>

      {/* Commission CTA */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div className="gz-container max-w-3xl">
          <div className="grad-border rounded-[24px] overflow-hidden">
            <div className="text-center rounded-[24px] p-10" style={{ background: 'var(--gradient-card), #ffffff' }}>
              <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> Commission a project</div>
              <h3 className="text-genz-navy font-extrabold font-heading text-2xl sm:text-3xl mb-3">
                Want something like this for <span className="text-grad-brand">your brand?</span>
              </h3>
              <p className="text-genz-muted text-[15px] mb-7 max-w-xl mx-auto leading-relaxed">
                Every concept shown here is available as a commissioned project. Tell us your goals
                and we&apos;ll send a tailored proposal with timeline and pricing within 24 hours.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Link to="/contact" className="btn-grad inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
                  Commission a Project <ArrowRight size={15} />
                </Link>
                <Link to="/services" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-semibold text-genz-blue border border-genz-blue/30 hover:bg-genz-blue/[0.06] transition-all">
                  <Layers size={15} /> Explore Services
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <CTASection />
    </div>
  );
};

export default Portfolio;

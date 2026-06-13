import { MessageCircle, TrendingUp, Search, Link2, BarChart2, FileText, Globe, CheckCircle } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const SEO_SERVICES = [
  { icon: Search,    color: '#22d3ee', title: 'Keyword Research',      desc: 'In-depth research to identify high-traffic, low-competition keywords for your niche.' },
  { icon: FileText,  color: '#60a5fa', title: 'On-Page SEO',           desc: 'Optimising title tags, meta descriptions, headings, content, and internal linking.' },
  { icon: Link2,     color: '#4ade80', title: 'Link Building',         desc: 'Quality backlink acquisition from relevant, authoritative websites.' },
  { icon: Globe,     color: '#a78bfa', title: 'Technical SEO',         desc: 'Site speed, crawlability, structured data, XML sitemaps, and Core Web Vitals.' },
  { icon: FileText,  color: '#fb923c', title: 'SEO Content Writing',   desc: 'Keyword-optimised blog articles, landing pages, and product descriptions.' },
  { icon: BarChart2, color: '#f472b6', title: 'SEO Reporting',         desc: 'Monthly ranking, traffic, and performance reports with actionable insights.' },
];

const ServiceSEO = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [servRef, servVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <section className="page-hero pt-32 pb-20 lg:pt-32 lg:pb-24 px-5">
        <span className="brand-blob brand-blob-a" aria-hidden="true" />
        <span className="brand-blob brand-blob-b" aria-hidden="true" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(6,182,212,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(6,182,212,0.3)', background: 'rgba(6,182,212,0.08)', color: '#22d3ee' }}>
            <span className="glow-dot" style={{ background: '#22d3ee' }} /> SEO & Digital Growth
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            Rank higher. <span className="text-grad-brand">Grow faster.</span>
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            Data-driven SEO strategies that improve your search rankings, increase organic traffic,
            and turn visitors into customers — with measurable results.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="btn-grad inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-bold">
            <MessageCircle size={16} /> Get an SEO Audit
          </a>
        </div>
      </section>

      <section className="py-20 px-4">
        <div ref={servRef} className={`max-w-6xl mx-auto reveal ${servVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-12">SEO services</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {SEO_SERVICES.map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="p-6 rounded-2xl transition-all hover:-translate-y-0.5"
                style={{ background: `${color}09`, border: `1px solid ${color}20` }}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: `${color}20` }}>
                  <Icon size={20} style={{ color }} />
                </div>
                <h3 className="text-genz-navy font-semibold text-sm mb-2">{title}</h3>
                <p className="text-genz-muted text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto rounded-3xl p-8" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.18)' }}>
          <h3 className="text-genz-navy font-bold text-xl mb-6 text-center">What makes our SEO different</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {['White-hat techniques only','Industry-specific keyword targeting','Competitor gap analysis','Full technical SEO audit','Transparent monthly reporting','Long-term growth focus'].map(f=>(
              <div key={f} className="flex items-start gap-2.5 text-genz-muted text-sm">
                <CheckCircle size={14} style={{ color:'#22d3ee', flexShrink:0 }} className="mt-0.5" /> {f}
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to rank higher on Google?" sub="Contact us for a free SEO audit and growth strategy discussion." />
    </div>
  );
};

export default ServiceSEO;

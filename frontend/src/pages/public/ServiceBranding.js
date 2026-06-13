import { MessageCircle, Palette, Star, Image, Layout, FileImage, CheckCircle } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const BRAND_TYPES = [
  { icon: Star,      color: '#fb923c', title: 'Brand Identity',          desc: 'Logo design, brand guidelines, typography systems, and colour palettes.' },
  { icon: Image,     color: '#f472b6', title: 'Social Media Creatives',  desc: 'Post templates, story designs, highlight covers, and branded content kits.' },
  { icon: FileImage, color: '#a78bfa', title: 'Flyers & Print Design',   desc: 'Event flyers, business cards, posters, and print-ready marketing materials.' },
  { icon: Layout,    color: '#60a5fa', title: 'Presentation Design',     desc: 'Professional pitch decks, company profiles, and presentation templates.' },
  { icon: Palette,   color: '#4ade80', title: 'Brand Refresh',           desc: 'Modernising existing brands with updated visual identity and guidelines.' },
  { icon: Image,     color: '#06B6D4', title: 'Content Creatives',       desc: 'Ad creatives, promotional banners, digital marketing visual assets.' },
];

const ServiceBranding = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [typesRef, typesVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <section className="page-hero pt-32 pb-20 lg:pt-32 lg:pb-24 px-5">
        <span className="brand-blob brand-blob-a" aria-hidden="true" />
        <span className="brand-blob brand-blob-b" aria-hidden="true" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(249,115,22,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(249,115,22,0.3)', background: 'rgba(249,115,22,0.08)', color: '#fb923c' }}>
            <span className="glow-dot" style={{ background: '#fb923c' }} /> Branding & Design
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            A brand identity that <span className="text-grad-brand">stands out</span>
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            From logo design and brand guidelines to social media creatives and print materials —
            we create visual identities that make your brand impossible to ignore.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="btn-grad inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-bold">
            <MessageCircle size={16} /> Start Your Brand Project
          </a>
        </div>
      </section>

      <section className="py-20 px-4">
        <div ref={typesRef} className={`max-w-6xl mx-auto reveal ${typesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-12">Design services</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {BRAND_TYPES.map(({ icon: Icon, color, title, desc }) => (
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
        <div className="max-w-3xl mx-auto rounded-3xl p-8" style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.18)' }}>
          <h3 className="text-genz-navy font-bold text-xl mb-6 text-center">What every design project includes</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {['Original, custom designs (no templates)','Multiple concept options','Unlimited revisions until approved','Source files delivered','Print and digital formats','Brand usage guidelines'].map(f=>(
              <div key={f} className="flex items-start gap-2.5 text-genz-muted text-sm">
                <CheckCircle size={14} style={{ color:'#fb923c', flexShrink:0 }} className="mt-0.5" /> {f}
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to build your brand identity?" sub="Contact us to discuss your vision and get a design proposal." />
    </div>
  );
};

export default ServiceBranding;

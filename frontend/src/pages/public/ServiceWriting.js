import { MessageCircle, CheckCircle, PenTool, FileText, BookOpen, Briefcase, Search, Edit } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const TYPES = [
  { icon: FileText,  color: '#a78bfa', title: 'Website Content',      desc: 'Persuasive, SEO-optimised copy for homepages, about pages, service pages, and product descriptions.' },
  { icon: BookOpen,  color: '#60a5fa', title: 'Blog Writing',         desc: 'Long-form, research-backed blog articles that build authority and drive organic traffic.' },
  { icon: Briefcase, color: '#4ade80', title: 'Business Writing',     desc: 'Proposals, reports, executive summaries, emails, company profiles, and investor decks.' },
  { icon: Search,    color: '#fb923c', title: 'Academic Support',     desc: 'Essay writing assistance, research papers, literature reviews, and assignment support.' },
  { icon: PenTool,   color: '#f472b6', title: 'Copywriting',          desc: 'High-converting ad copy, sales pages, email sequences, and marketing materials.' },
  { icon: Edit,      color: '#22d3ee', title: 'Proofreading & Editing', desc: 'Professional editing for grammar, clarity, style, and formatting on any document.' },
];

const ServiceWriting = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [typesRef, typesVisible] = useReveal();
  const [processRef, processVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <section className="relative pt-32 pb-20 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(139,92,246,0.12),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.08)', color: '#a78bfa' }}>
            <span className="glow-dot" style={{ background: '#a78bfa' }} /> Writing Services
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            Words that convert, inform, <span style={{ WebkitTextFillColor: 'transparent', background: 'linear-gradient(135deg,#a78bfa,#7c3aed)', WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>and build authority</span>
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            Professional writing services across every format — from persuasive website copy to
            detailed research articles, business documents, and academic support.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-sm font-bold text-genz-navy transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#a78bfa,#7c3aed)' }}>
            <MessageCircle size={15} /> Discuss Your Project
          </a>
        </div>
      </section>

      {/* Service types */}
      <section className="py-20 px-4">
        <div ref={typesRef} className={`max-w-6xl mx-auto reveal ${typesVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-12">What we write</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {TYPES.map(({ icon: Icon, color, title, desc }) => (
              <div key={title} className="p-6 rounded-2xl transition-all hover:-translate-y-0.5"
                style={{ background: `${color}09`, border: `1px solid ${color}20` }}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: `${color}20` }}>
                  <Icon size={20} style={{ color }} />
                </div>
                <h3 className="text-genz-navy font-semibold text-sm mb-2">{title}</h3>
                <p className="text-genz-muted text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quality promise */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto rounded-3xl p-8"
          style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.2)' }}>
          <h3 className="text-genz-navy font-bold text-xl mb-6 text-center">Our writing quality standards</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {['100% original, plagiarism-free content','SEO-optimised where required','Delivered on agreed timelines','Revisions included in every package','Tone and style matched to your brand','Research-backed and fact-checked'].map(f => (
              <div key={f} className="flex items-start gap-2.5 text-genz-muted text-sm">
                <CheckCircle size={14} style={{ color: '#a78bfa', flexShrink: 0 }} className="mt-0.5" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section className="py-16 px-4">
        <div ref={processRef} className={`max-w-3xl mx-auto reveal ${processVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-genz-navy text-center mb-10">How it works</h2>
          <div className="space-y-4">
            {[
              { n:'01', t:'Share your brief',    s:'Tell us what you need — topic, tone, audience, length, and any key details.' },
              { n:'02', t:'Research & planning', s:'We research the topic and create a structured outline for your approval.' },
              { n:'03', t:'Writing',             s:'First draft delivered within the agreed timeline.' },
              { n:'04', t:'Revisions',           s:'We refine based on your feedback until you are fully satisfied.' },
              { n:'05', t:'Final delivery',      s:'Clean, formatted final version ready for publication or submission.' },
            ].map(({ n, t, s }) => (
              <div key={n} className="flex gap-5 p-5 rounded-2xl"
                style={{ background: '#ffffff', border: '1px solid #ffffff' }}>
                <span className="text-2xl font-extrabold flex-shrink-0" style={{ color: 'rgba(167,139,250,0.4)' }}>{n}</span>
                <div>
                  <h3 className="text-genz-navy font-semibold text-sm mb-1">{t}</h3>
                  <p className="text-genz-muted text-sm">{s}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Need professional writing for your project?" sub="Contact us to discuss your content requirements and get a quote." />
    </div>
  );
};

export default ServiceWriting;

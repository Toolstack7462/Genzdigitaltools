import { Link } from 'react-router-dom';
import { Instagram, CheckCircle, ArrowRight, BarChart2, Calendar, Image, Film, MessageCircle, TrendingUp } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal';
import CTASection from '../../components/public/CTASection';
import { WHATSAPP_URL } from '../../components/public/PublicNavbar';

const DELIVERABLES = [
  { icon: Calendar, label: 'Content Calendar',        desc: 'Monthly content planning with scheduled posts across all platforms.' },
  { icon: Image,    label: 'Post Design',             desc: 'Eye-catching graphics, templates, and branded social media creatives.' },
  { icon: MessageCircle, label: 'Captions & Hashtags', desc: 'Engaging, SEO-optimised captions and targeted hashtag strategies.' },
  { icon: Film,     label: 'Reels Strategy',          desc: 'Short-form video strategy, scripting, and direction for growth.' },
  { icon: Instagram,label: 'Page Optimisation',       desc: 'Profile bios, highlights, link-in-bio pages, and platform branding.' },
  { icon: BarChart2,label: 'Growth Reporting',        desc: 'Monthly performance reports with reach, engagement, and growth metrics.' },
];

const PLATFORMS = ['Instagram','Facebook','TikTok','LinkedIn','Twitter / X','YouTube Shorts','Pinterest','Threads'];

const ServiceSocialMedia = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [delRef, delVisible] = useReveal();
  const [platRef, platVisible] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="page-hero pt-32 pb-20 lg:pt-32 lg:pb-24 px-5">
        <span className="brand-blob brand-blob-a" aria-hidden="true" />
        <span className="brand-blob brand-blob-b" aria-hidden="true" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(225,48,108,0.12),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-3xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(225,48,108,0.3)', background: 'rgba(225,48,108,0.08)', color: '#e1306c' }}>
            <span className="glow-dot" style={{ background: '#e1306c' }} /> Social Media Management
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-genz-navy mb-5 leading-tight">
            Your brand, consistently <span className="text-grad-brand">showing up</span>
          </h1>
          <p className="text-genz-muted text-base sm:text-lg leading-relaxed mb-8">
            We manage your entire social media presence — strategy, content, design, scheduling, and reporting —
            so you can focus on growing your business.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="btn-grad inline-flex items-center gap-2 px-7 py-3.5 rounded-[14px] text-[15px] font-bold">
            <MessageCircle size={16} /> Get Started on WhatsApp
          </a>
        </div>
      </section>

      {/* Deliverables */}
      <section className="py-20 px-4">
        <div ref={delRef} className={`max-w-6xl mx-auto reveal ${delVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl sm:text-3xl font-bold text-genz-navy text-center mb-4">What&apos;s included</h2>
          <p className="text-genz-muted text-center text-sm mb-12">Every social media management package includes:</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {DELIVERABLES.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="p-6 rounded-2xl transition-all hover:-translate-y-0.5"
                style={{ background: 'rgba(225,48,108,0.07)', border: '1px solid rgba(225,48,108,0.18)' }}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: 'rgba(225,48,108,0.18)' }}>
                  <Icon size={20} style={{ color: '#e1306c' }} />
                </div>
                <h3 className="text-genz-navy font-semibold text-sm mb-2">{label}</h3>
                <p className="text-genz-muted text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Platforms */}
      <section className="py-16 px-4">
        <div ref={platRef} className={`max-w-4xl mx-auto text-center reveal ${platVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-genz-navy mb-4">Platforms we manage</h2>
          <p className="text-genz-muted text-sm mb-10">We work across all major social platforms.</p>
          <div className="flex flex-wrap justify-center gap-3">
            {PLATFORMS.map(p => (
              <span key={p} className="px-4 py-2 rounded-full text-sm font-medium text-genz-muted"
                style={{ background: 'rgba(225,48,108,0.1)', border: '1px solid rgba(225,48,108,0.2)' }}>
                {p}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-genz-navy text-center mb-10">Our process</h2>
          <div className="space-y-4">
            {[
              { n:'01', t:'Strategy & Brief',   s:'We learn your brand, audience, and goals to build a tailored social strategy.' },
              { n:'02', t:'Content Planning',   s:'Monthly content calendar created and approved before scheduling begins.' },
              { n:'03', t:'Design & Copywriting', s:'All posts, captions, and creatives produced by our team.' },
              { n:'04', t:'Scheduling & Publishing', s:'Content published on time across all agreed platforms.' },
              { n:'05', t:'Reporting',          s:'Monthly performance report with insights, recommendations, and next steps.' },
            ].map(({ n, t, s }) => (
              <div key={n} className="flex gap-5 p-5 rounded-2xl"
                style={{ background: '#ffffff', border: '1px solid #ffffff' }}>
                <span className="text-2xl font-extrabold flex-shrink-0" style={{ color: 'rgba(225,48,108,0.5)' }}>{n}</span>
                <div>
                  <h3 className="text-genz-navy font-semibold text-sm mb-1">{t}</h3>
                  <p className="text-genz-muted text-sm">{s}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to grow your social media presence?" sub="Contact us on WhatsApp to discuss your brand and requirements." />
    </div>
  );
};

export default ServiceSocialMedia;

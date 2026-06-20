import { Link } from 'react-router-dom';
import { CheckCircle, MessageCircle, Zap, ArrowRight } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import PricingCard from '../components/public/PricingCard';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import PageHero from '../components/public/PageHero';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';

const PLANS = [
  { tier: 'Starter',      price: 'Contact for quote', priceNote: '', tagline: 'Great for individuals and solo creators.',
    highlighted: false,
    features: ['Tool access (up to 3 tools)','Basic social media management','Content calendar','1 blog post per month','Email support','Monthly performance report'],
    cta: 'Get Started', ctaTo: '/contact' },
  { tier: 'Professional', price: 'Contact for quote', priceNote: '', tagline: 'For growing businesses and active creators.',
    highlighted: true,
    features: ['Tool access (up to 10 tools)','Full social media management','Blog writing (4 posts/month)','Website or landing page','Branding starter kit','Priority support','Weekly performance reports'],
    cta: 'Get Started', ctaTo: '/contact' },
  { tier: 'Business',     price: 'Contact for quote', priceNote: '', tagline: 'Full-service for serious businesses.',
    highlighted: false,
    features: ['Unlimited tool access','Social media + paid ads management','Web app or mobile app','Full branding package','SEO strategy & implementation','Automation / CRM setup','Dedicated account manager'],
    cta: 'Get Started', ctaTo: '/contact' },
  { tier: 'Custom',       price: "Let's talk",        priceNote: '', tagline: 'Tailored to your exact requirements.',
    highlighted: false,
    features: ['Any combination of services','API integrations','Custom software development','White-label solutions','Custom SLA & timelines','Executive-level support'],
    cta: 'Request Custom Quote', ctaTo: '/contact' },
];

const ADDONS = [
  'Single landing page design','Logo & brand identity','Social media post pack (30 posts)','Blog article (1000-2000 words)','Website SEO audit','Mobile app (basic)','Web app (custom scope)','Social media monthly management','Proofreading & editing','Flyer / print design','Pitch deck design','Chrome extension development',
];

const FAQS = [
  { q: 'Are the prices fixed?', a: 'Prices vary depending on the scope, scale, and specific requirements of your project. Contact us for a tailored quote based on exactly what you need.' },
  { q: 'Can I mix services across plans?', a: 'Yes. Our Custom plan is fully flexible. You can combine any services from across our offering. Contact us to build your ideal package.' },
  { q: 'Is there a trial or free consultation?', a: 'We offer a free initial consultation to understand your requirements before providing a proposal. Contact us via WhatsApp to get started.' },
  { q: 'How are projects billed?', a: 'We typically bill monthly for ongoing services, and per-project for one-time work like websites and apps. Payment terms are agreed before work begins.' },
  { q: 'What happens after I contact you?', a: 'We will discuss your requirements, send a detailed proposal within 24 hours, and agree on scope and pricing before any work begins.' },
];

const Pricing = () => {
  const [plansRef, plansV] = useReveal();
  const [addonRef, addonV] = useReveal();
  const [faqRef, faqV] = useReveal();

  return (
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="Pricing"
        title={<>Transparent, <span className="text-grad-brand">flexible</span> pricing</>}
        subtitle="Every project is scoped individually. Contact us for a custom quote. We don't do one-size-fits-all."
      />

      {/* Plans */}
      <section className="gz-section px-5 -mt-4">
        <div ref={plansRef} className={`gz-container max-w-7xl reveal ${plansV ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 pt-8">
            {PLANS.map((p) => <PricingCard key={p.tier} {...p} />)}
          </div>
          <p className="text-center text-genz-muted text-[13px] mt-10">
            All prices are quoted individually based on your requirements. Contact us to discuss your project.
          </p>
        </div>
      </section>

      {/* Add-ons */}
      <section className="gz-section px-5" style={{ background: 'var(--brand-surface-soft)' }}>
        <div ref={addonRef} className={`gz-container max-w-5xl reveal ${addonV ? 'visible' : ''}`}>
          <div className="text-center mb-10">
            <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> Individual service pricing</div>
            <h2 className="font-heading text-genz-navy font-extrabold text-3xl sm:text-4xl mb-3">
              Need just <span className="text-grad-cyan-teal">one service?</span>
            </h2>
            <p className="text-genz-muted">We quote individually for every line item below.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ADDONS.map((item) => (
              <div key={item} className="flex items-center gap-2.5 px-4 py-3.5 rounded-2xl text-[14px] text-genz-navy/85 hover-glow"
                style={{ background: '#ffffff', border: '1px solid var(--brand-border)' }}>
                <CheckCircle size={14} className="text-genz-blue flex-shrink-0" />
                {item}
              </div>
            ))}
          </div>
          <div className="text-center mt-10 flex flex-wrap justify-center gap-3">
            <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold text-emerald-700 bg-white border border-emerald-200 hover:bg-emerald-50 transition-all">
              <MessageCircle size={16} /> Get a Quote on WhatsApp
            </a>
            <Link to="/contact" className="btn-grad inline-flex items-center gap-2 px-6 py-3.5 rounded-[14px] text-[15px] font-bold">
              <Zap size={16} /> Request a Proposal <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <div className="brand-divider mx-5 sm:mx-16" />

      {/* FAQ */}
      <section className="gz-section px-5">
        <div ref={faqRef} className={`mx-auto max-w-3xl reveal ${faqV ? 'visible' : ''}`}>
          <div className="text-center mb-10">
            <div className="gz-eyebrow-grad mb-5"><span className="glow-dot" /> FAQ</div>
            <h2 className="font-heading text-genz-navy font-extrabold text-3xl sm:text-4xl">Pricing questions</h2>
          </div>
          <div className="space-y-3">
            {FAQS.map((f, i) => <FAQItem key={i} question={f.q} answer={f.a} defaultOpen={i === 0} />)}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to get a quote?" sub="Contact us today and we'll have a proposal to you within 24 hours." />
    </div>
  );
};

export default Pricing;

import { Link } from 'react-router-dom';
import { CheckCircle, MessageCircle, Zap } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import PricingCard from '../components/public/PricingCard';
import FAQItem from '../components/public/FAQItem';
import CTASection from '../components/public/CTASection';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';

const PLANS = [
  {
    tier: 'Starter',
    price: 'Contact for quote',
    priceNote: '',
    tagline: 'Great for individuals and solo creators.',
    highlighted: false,
    features: [
      'Tool access (up to 3 tools)',
      'Basic social media management',
      'Content calendar',
      '1 blog post per month',
      'Email support',
      'Monthly performance report',
    ],
    cta: 'Get Started',
    ctaTo: '/contact',
  },
  {
    tier: 'Professional',
    price: 'Contact for quote',
    priceNote: '',
    tagline: 'For growing businesses and active creators.',
    highlighted: true,
    features: [
      'Tool access (up to 10 tools)',
      'Full social media management',
      'Blog writing (4 posts/month)',
      'Website or landing page',
      'Branding starter kit',
      'Priority support',
      'Weekly performance reports',
    ],
    cta: 'Get Started',
    ctaTo: '/contact',
  },
  {
    tier: 'Business',
    price: 'Contact for quote',
    priceNote: '',
    tagline: 'Full-service for serious businesses.',
    highlighted: false,
    features: [
      'Unlimited tool access',
      'Social media + paid ads management',
      'Web app or mobile app',
      'Full branding package',
      'SEO strategy & implementation',
      'Automation / CRM setup',
      'Dedicated account manager',
    ],
    cta: 'Get Started',
    ctaTo: '/contact',
  },
  {
    tier: 'Custom',
    price: "Let's talk",
    priceNote: '',
    tagline: 'Tailored to your exact requirements.',
    highlighted: false,
    features: [
      'Any combination of services',
      'API integrations',
      'Custom software development',
      'White-label solutions',
      'Custom SLA & timelines',
      'Executive-level support',
    ],
    cta: 'Request Custom Quote',
    ctaTo: '/contact',
  },
];

const FAQS = [
  { q: 'Are the prices fixed?', a: 'Prices vary depending on the scope, scale, and specific requirements of your project. Contact us for a tailored quote based on exactly what you need.' },
  { q: 'Can I mix services across plans?', a: 'Yes — our Custom plan is fully flexible. You can combine any services from across our offering. Contact us to build your ideal package.' },
  { q: 'Is there a trial or free consultation?', a: 'We offer a free initial consultation to understand your requirements before providing a proposal. Contact us via WhatsApp to get started.' },
  { q: 'How are projects billed?', a: 'We typically bill monthly for ongoing services, and per-project for one-time work like websites and apps. Payment terms are agreed before work begins.' },
  { q: 'What happens after I contact you?', a: 'We will discuss your requirements, send a detailed proposal within 24 hours, and agree on scope and pricing before any work begins.' },
];

const Pricing = () => {
  const [heroRef, heroVisible] = useReveal(0.05);
  const [plansRef, plansVisible] = useReveal();
  const [addonRef, addonVisible] = useReveal();
  const [faqRef, faqVisible] = useReveal();

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="relative pt-32 pb-16 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(0,175,193,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-2xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> Pricing
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            Transparent, <span className="text-gradient-teal">flexible</span> pricing
          </h1>
          <p className="text-white/55 text-base leading-relaxed">
            Every project is scoped individually. Contact us for a custom quote — we don't do one-size-fits-all.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="py-16 px-4">
        <div ref={plansRef} className={`max-w-7xl mx-auto reveal ${plansVisible ? 'visible' : ''}`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {PLANS.map(p => <PricingCard key={p.tier} {...p} />)}
          </div>
          <p className="text-center text-white/55 text-xs mt-8">
            All prices are quoted individually based on your requirements. Contact us to discuss your project.
          </p>
        </div>
      </section>

      {/* Add-ons */}
      <section className="py-16 px-4">
        <div ref={addonRef} className={`max-w-4xl mx-auto reveal ${addonVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-white text-center mb-4">Individual service pricing</h2>
          <p className="text-white/50 text-center text-sm mb-10">Need just one service? We quote individually for all of the following:</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[
              'Single landing page design',
              'Logo & brand identity',
              'Social media post pack (30 posts)',
              'Blog article (1000-2000 words)',
              'Website SEO audit',
              'Mobile app (basic)',
              'Web app (custom scope)',
              'Social media monthly management',
              'Proofreading & editing',
              'Flyer / print design',
              'Pitch deck design',
              'Chrome extension development',
            ].map(item => (
              <div key={item} className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm text-white/60"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <CheckCircle size={13} className="text-genz-teal flex-shrink-0" />
                {item}
              </div>
            ))}
          </div>
          <div className="text-center mt-8">
            <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-bold text-genz-deep-navy transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
              <MessageCircle size={15} /> Get a Quote on WhatsApp
            </a>
          </div>
        </div>
      </section>

      <div className="section-divider mx-4 sm:mx-16" />

      {/* FAQ */}
      <section className="py-16 px-4">
        <div ref={faqRef} className={`max-w-2xl mx-auto reveal ${faqVisible ? 'visible' : ''}`}>
          <h2 className="text-2xl font-bold text-white text-center mb-8">Pricing FAQs</h2>
          <div className="space-y-3">
            {FAQS.map((f,i) => <FAQItem key={i} question={f.q} answer={f.a} />)}
          </div>
        </div>
      </section>

      <CTASection headline="Ready to get a quote?" sub="Contact us today and we'll have a proposal to you within 24 hours." />
    </div>
  );
};

export default Pricing;

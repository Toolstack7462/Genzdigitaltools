import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Zap, Star, ArrowRight, Shield, Users, Package } from 'lucide-react';

const PLANS = [
  {
    name: 'Starter',
    monthly: 29,
    annual: 249,
    desc: 'Perfect for individuals getting started with digital tools',
    features: [
      '15 Premium Tools', 'Basic AI Writing Tools', 'SEO Tools (1 platform)', 
      'Chrome Extension Access', 'Email Support', '1 Device Binding',
      'Monthly Updates',
    ],
    notIncluded: ['Full AI Suite', 'Academic Tools', 'Video Tools', 'Priority Support'],
    cta: 'Get Starter',
    color: 'border-genz-border/30',
    highlight: false,
  },
  {
    name: 'Pro',
    monthly: 59,
    annual: 499,
    desc: 'Everything you need for professional work and business',
    features: [
      '50+ Premium Tools', 'Full AI Writing Suite (ChatGPT, Claude, Grammarly)',
      'Full SEO Suite (Semrush, Ahrefs, Surfer)', 'AI Design Tools (Midjourney, Canva)',
      'Academic Research Tools', 'Chrome Extension Access', 'Priority Support (24h)',
      '2 Device Bindings', 'Weekly New Tools',
    ],
    notIncluded: ['Team Dashboard', 'Custom Onboarding'],
    cta: 'Get Pro — Best Value',
    color: 'border-genz-teal/50',
    highlight: true,
  },
  {
    name: 'Business',
    monthly: 99,
    annual: 849,
    desc: 'Complete suite for teams, agencies, and power users',
    features: [
      '90+ Premium Tools', 'Everything in Pro', 'AI Video Tools (Invideo, Loom)',
      'AI Coding Tools (GitHub Copilot, Tabnine)', 'Business Analytics Suite',
      'Marketing Automation Tools', 'Team Dashboard', 'Dedicated Support (WhatsApp)',
      'Unlimited Devices', 'Same-day New Tools', 'Custom Onboarding Session',
    ],
    notIncluded: [],
    cta: 'Get Business',
    color: 'border-genz-border/30',
    highlight: false,
  },
];

const Pricing = () => {
  const [billing, setBilling] = useState('monthly');

  return (
    <div className="min-h-screen pt-20 pb-20 px-4"
         style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)' }}>
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <div className="text-center mb-12 pt-10">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-6"
               style={{ background: 'rgba(0,175,193,0.1)', borderColor: 'rgba(0,175,193,0.3)' }}>
            <Star size={14} className="text-genz-teal" />
            <span className="text-genz-teal text-sm font-medium">Simple, Transparent Pricing</span>
          </div>
          <h1 className="text-5xl font-black text-white mb-4">
            Choose Your <span className="text-genz-teal">Membership</span>
          </h1>
          <p className="text-genz-muted text-lg max-w-2xl mx-auto mb-8">
            All plans include instant access, device-bound security, and 24/7 support.
            No hidden fees. Cancel anytime.
          </p>

          {/* Billing Toggle */}
          <div className="inline-flex items-center p-1.5 rounded-full border"
               style={{ background: 'rgba(0,175,193,0.06)', borderColor: 'rgba(0,175,193,0.2)' }}>
            {['monthly', 'annually'].map(p => (
              <button key={p} onClick={() => setBilling(p)}
                      className={`px-6 py-2 rounded-full text-sm font-semibold transition-all ${
                        billing === p ? 'text-genz-deep-navy' : 'text-genz-muted hover:text-white'
                      }`}
                      style={billing === p ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
                {p === 'annually' ? '🎉 Annual (Save 30%)' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>

        {/* Plans */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          {PLANS.map(plan => (
            <div key={plan.name}
                 className={`relative rounded-2xl border p-8 transition-all ${plan.highlight ? 'lg:scale-105' : ''}`}
                 style={{
                   background: plan.highlight
                     ? 'linear-gradient(135deg, rgba(0,175,193,0.12), rgba(0,16,48,0.9))'
                     : 'rgba(0,175,193,0.04)',
                   borderColor: plan.highlight ? 'rgba(0,175,193,0.45)' : 'rgba(0,175,193,0.1)',
                   boxShadow: plan.highlight ? '0 20px 60px rgba(0,175,193,0.2)' : 'none',
                 }}>
              {plan.highlight && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-5 py-1.5 rounded-full text-xs font-bold text-genz-deep-navy whitespace-nowrap"
                     style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                  ⚡ MOST POPULAR
                </div>
              )}

              <h3 className="text-xl font-black text-white mb-1">{plan.name}</h3>
              <p className="text-genz-muted text-sm mb-5 leading-relaxed">{plan.desc}</p>

              <div className="mb-6">
                <span className="text-5xl font-black text-white">
                  ${billing === 'monthly' ? plan.monthly : plan.annual}
                </span>
                <span className="text-genz-muted text-sm ml-1">
                  /{billing === 'monthly' ? 'month' : 'year'}
                </span>
                {billing === 'annually' && (
                  <div className="mt-1 text-xs text-green-400">
                    Save ${(plan.monthly * 12 - plan.annual)} vs monthly
                  </div>
                )}
              </div>

              <Link to="/join"
                    className={`w-full py-3.5 rounded-xl font-bold text-sm text-center block mb-7 transition-all hover:opacity-90 hover:scale-105 ${
                      plan.highlight ? 'text-genz-deep-navy' : 'text-genz-teal border border-genz-teal/40 hover:bg-genz-teal/10'
                    }`}
                    style={plan.highlight ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
                {plan.cta}
              </Link>

              <div className="space-y-2.5">
                {plan.features.map(f => (
                  <div key={f} className="flex items-start gap-2.5">
                    <CheckCircle2 size={15} className="text-genz-teal flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-white/80">{f}</span>
                  </div>
                ))}
                {plan.notIncluded.map(f => (
                  <div key={f} className="flex items-start gap-2.5 opacity-40">
                    <div className="w-3.5 h-3.5 rounded-full border border-genz-muted flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-genz-muted line-through">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Trust badges */}
        <div className="mt-14 grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { icon: Shield,  text: 'Device-secured accounts'     },
            { icon: Zap,     text: 'Instant access after payment' },
            { icon: Users,   text: '1,000+ happy members'         },
            { icon: Package, text: 'New tools added weekly'        },
          ].map(({ icon: Icon, text }) => (
            <div key={text}
                 className="flex items-center gap-3 p-4 rounded-xl border"
                 style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.1)' }}>
              <Icon size={18} className="text-genz-teal flex-shrink-0" />
              <span className="text-sm text-genz-muted">{text}</span>
            </div>
          ))}
        </div>

        {/* FAQ link */}
        <div className="mt-10 text-center">
          <p className="text-genz-muted text-sm">
            Have questions?{' '}
            <Link to="/contact" className="text-genz-teal hover:underline font-medium">
              Contact our team
            </Link>
            {' '}or{' '}
            <Link to="/#faq" className="text-genz-teal hover:underline font-medium">
              read our FAQ
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Pricing;

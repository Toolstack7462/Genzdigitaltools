import { Link } from 'react-router-dom';
import { Shield, Zap, Users, Star, ArrowRight, CheckCircle2 } from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';

const About = () => {
  return (
    <div className="min-h-screen pt-20 pb-20 px-4"
         style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)' }}>
      <div className="max-w-5xl mx-auto pt-10">

        {/* Hero */}
        <div className="text-center mb-16">
          <GenZDigitalStoreLogo className="h-14 justify-center mb-6" textSize="2xl" />
          <h1 className="text-5xl font-black text-white mb-4">
            About <span className="text-genz-teal">Gen Z Digital Store</span>
          </h1>
          <p className="text-genz-muted text-lg max-w-2xl mx-auto leading-relaxed">
            We're on a mission to democratize access to premium digital tools — making
            the same professional-grade software used by Fortune 500 companies accessible
            to everyone through one affordable membership.
          </p>
        </div>

        {/* Mission */}
        <div className="p-8 rounded-2xl border mb-10"
             style={{ background: 'linear-gradient(135deg, rgba(0,175,193,0.08), rgba(0,16,48,0.8))', borderColor: 'rgba(0,175,193,0.2)' }}>
          <h2 className="text-2xl font-black text-white mb-4">Our Mission</h2>
          <p className="text-genz-muted leading-relaxed mb-4">
            Premium software subscriptions are expensive. ChatGPT Plus, Semrush, Grammarly Business,
            Midjourney, Ahrefs, GitHub Copilot — each costs $20–$200/month individually. The average
            professional needs 8–12 of these tools to do their best work.
          </p>
          <p className="text-genz-muted leading-relaxed">
            Gen Z Digital Store solves this by bundling 90+ of the most-used premium tools into a
            single, secure, affordable membership. Students, freelancers, small business owners, and
            professionals all deserve access to the best tools — not just large enterprises.
          </p>
        </div>

        {/* Values */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-12">
          {[
            { icon: Shield,  title: 'Security First',  desc: 'Device-bound accounts, encrypted tokens, and zero data exposure.'  },
            { icon: Zap,     title: 'Instant Access',  desc: 'Get your tools immediately after payment — no waiting or delays.'   },
            { icon: Users,   title: 'Member Focus',    desc: '24/7 support via WhatsApp. We\'re here when you need us.'            },
            { icon: Star,    title: 'Quality Curation',desc: 'Only the best tools make it into our catalog — constantly updated.' },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="p-5 rounded-2xl border text-center"
                 style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.1)' }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3"
                   style={{ background: 'rgba(0,175,193,0.15)' }}>
                <Icon size={22} className="text-genz-teal" />
              </div>
              <h3 className="font-bold text-white mb-2">{title}</h3>
              <p className="text-xs text-genz-muted leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>

        {/* What's Included */}
        <div className="mb-12">
          <h2 className="text-2xl font-black text-white mb-6">What You Get</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              '90+ premium software tools in one dashboard',
              'AI writing: ChatGPT, Claude, Grammarly, Jasper',
              'SEO tools: Semrush, Ahrefs, Surfer SEO, Mangools',
              'Design tools: Midjourney, Canva Pro, Adobe Firefly',
              'Coding tools: GitHub Copilot, Tabnine',
              'Academic research and citation tools',
              'Business and CRM software',
              'Video creation and editing platforms',
              'Chrome extension for seamless access',
              'Device-bound account security',
              'Priority WhatsApp support',
              'Weekly new tool additions',
            ].map(item => (
              <div key={item} className="flex items-center gap-2.5 p-3 rounded-xl border"
                   style={{ background: 'rgba(0,175,193,0.03)', borderColor: 'rgba(0,175,193,0.08)' }}>
                <CheckCircle2 size={15} className="text-genz-teal flex-shrink-0" />
                <span className="text-sm text-white/80">{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center p-10 rounded-2xl border"
             style={{ background: 'rgba(0,175,193,0.06)', borderColor: 'rgba(0,175,193,0.2)' }}>
          <h3 className="text-2xl font-black text-white mb-3">Ready to join?</h3>
          <p className="text-genz-muted mb-6">Start your Gen Z Digital Store membership today.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/join"
                  className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl font-semibold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
                  style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              <Zap size={18} /> Get Membership
            </Link>
            <Link to="/pricing"
                  className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl font-medium border border-genz-teal/40 text-genz-teal hover:bg-genz-teal/10 transition-all">
              View Pricing <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default About;

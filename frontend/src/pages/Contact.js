import { useState } from 'react';
import { MessageCircle, Mail, Send, CheckCircle } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';
import api from '../services/api';

const Contact = () => {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [status, setStatus] = useState('idle');
  const [heroRef, heroVisible] = useReveal(0.05);
  const [formRef, formVisible] = useReveal();

  const handleChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('sending');
    try {
      await api.post('/public/contact', form);
      setStatus('sent');
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch {
      setStatus('error');
    }
  };

  return (
    <div style={{ background: '#000820' }} className="overflow-x-hidden">
      {/* Hero */}
      <section className="relative pt-32 pb-16 px-4 overflow-hidden">
        <div className="absolute inset-0 hero-grid opacity-40 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(0,175,193,0.1),transparent 70%)' }} />
        <div ref={heroRef} className={`max-w-2xl mx-auto text-center reveal ${heroVisible ? 'visible' : ''}`}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold text-genz-teal mb-6 uppercase tracking-widest"
            style={{ borderColor: 'rgba(0,175,193,0.3)', background: 'rgba(0,175,193,0.08)' }}>
            <span className="glow-dot" /> Contact Us
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-5 leading-tight">
            Let's build something <span className="text-gradient-teal">great</span> together
          </h1>
          <p className="text-white/55 text-base leading-relaxed">
            Reach out via WhatsApp for the fastest response, or fill out the contact form below.
          </p>
        </div>
      </section>

      {/* WhatsApp CTA */}
      <section className="py-8 px-4">
        <div className="max-w-xl mx-auto">
          <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-3 w-full py-4 rounded-2xl text-sm font-bold text-white transition-all hover:opacity-90 hover:scale-[1.02]"
            style={{ background: 'linear-gradient(135deg,rgba(37,211,102,0.25),rgba(37,211,102,0.1))', border: '1.5px solid rgba(37,211,102,0.4)' }}>
            <MessageCircle size={20} className="text-green-400" />
            <span>Chat directly on WhatsApp <span className="opacity-70 font-normal">— fastest response</span></span>
          </a>
        </div>
      </section>

      {/* Contact form */}
      <section className="py-12 pb-24 px-4">
        <div ref={formRef} className={`max-w-xl mx-auto reveal ${formVisible ? 'visible' : ''}`}>
          <div className="rounded-3xl p-8" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center gap-3 mb-7">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,175,193,0.15)' }}>
                <Mail size={18} className="text-genz-teal" />
              </div>
              <div>
                <h3 className="text-white font-bold text-base">Send us a message</h3>
                <p className="text-white/40 text-xs">We'll reply within a few hours</p>
              </div>
            </div>

            {status === 'sent' ? (
              <div className="text-center py-10">
                <CheckCircle size={36} className="text-green-400 mx-auto mb-3" />
                <h4 className="text-white font-bold text-lg mb-2">Message sent!</h4>
                <p className="text-white/50 text-sm">We'll get back to you very soon.</p>
                <button onClick={() => setStatus('idle')} className="mt-5 text-genz-teal text-sm hover:underline">
                  Send another message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {[
                  { name: 'name',    label: 'Full Name',     type: 'text', placeholder: 'Your name' },
                  { name: 'email',   label: 'Email Address', type: 'email', placeholder: 'your@email.com' },
                  { name: 'subject', label: 'Subject',       type: 'text', placeholder: 'What is this about?' },
                ].map(({ name, label, type, placeholder }) => (
                  <div key={name}>
                    <label className="block text-white/60 text-xs font-medium mb-1.5">{label}</label>
                    <input
                      type={type}
                      name={name}
                      value={form[name]}
                      onChange={handleChange}
                      required
                      placeholder={placeholder}
                      className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-white/25 outline-none transition-all"
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                  </div>
                ))}
                <div>
                  <label className="block text-white/60 text-xs font-medium mb-1.5">Message</label>
                  <textarea
                    name="message"
                    value={form.message}
                    onChange={handleChange}
                    required
                    rows={5}
                    placeholder="Tell us about your project or question..."
                    className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-white/25 outline-none resize-none transition-all"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                {status === 'error' && (
                  <p className="text-red-400 text-xs">Failed to send. Please try WhatsApp instead.</p>
                )}
                <button
                  type="submit"
                  disabled={status === 'sending'}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-bold text-genz-deep-navy transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}
                >
                  <Send size={15} />
                  {status === 'sending' ? 'Sending...' : 'Send Message'}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default Contact;

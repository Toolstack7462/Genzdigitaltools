import { useState } from 'react';
import { MessageCircle, Mail, Send, CheckCircle, Clock, Shield } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';
import { WHATSAPP_URL } from '../components/public/PublicNavbar';
import PageHero from '../components/public/PageHero';
import api from '../services/api';

const Contact = () => {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [status, setStatus] = useState('idle');
  const [formRef, formV] = useReveal();
  const [infoRef, infoV] = useReveal();

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

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
    <div style={{ background: 'var(--brand-soft)' }} className="overflow-x-hidden">
      <PageHero
        eyebrow="Contact Us"
        title={<>Let&apos;s build something <span className="text-grad-brand">great together</span></>}
        subtitle="Reach out via WhatsApp for the fastest response, or use the form below — we reply within a few hours."
      />

      <section className="gz-section px-5 pt-0 -mt-10">
        <div className="gz-container max-w-6xl">
          <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-8 items-start">

            {/* LEFT — Form */}
            <div ref={formRef} className={`reveal ${formV ? 'visible' : ''}`}>
              <div className="grad-border rounded-[24px] overflow-hidden">
                <div className="rounded-[24px] p-7 sm:p-9" style={{ background: 'var(--gradient-card), #ffffff' }}>
                  <div className="flex items-center gap-3 mb-7">
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white" style={{ background: 'var(--gradient-cta)' }}>
                      <Mail size={18} />
                    </div>
                    <div>
                      <h3 className="text-genz-navy font-bold text-[18px]">Send us a message</h3>
                      <p className="text-genz-muted text-[13px]">We&apos;ll reply within a few hours</p>
                    </div>
                  </div>

                  {status === 'sent' ? (
                    <div className="text-center py-12">
                      <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.32)' }}>
                        <CheckCircle size={28} className="text-emerald-500" />
                      </div>
                      <h4 className="text-genz-navy font-bold text-[20px] mb-2">Message sent</h4>
                      <p className="text-genz-muted text-[14px] mb-5">We&apos;ll get back to you very soon.</p>
                      <button onClick={() => setStatus('idle')} className="text-genz-blue text-[14px] font-semibold hover:underline">
                        Send another message
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                      <div className="grid sm:grid-cols-2 gap-4">
                        {[
                          { name: 'name',  label: 'Full Name',     type: 'text',  placeholder: 'Your name' },
                          { name: 'email', label: 'Email Address', type: 'email', placeholder: 'your@email.com' },
                        ].map(({ name, label, type, placeholder }) => (
                          <div key={name}>
                            <label className="block text-genz-navy/80 text-[12.5px] font-semibold mb-1.5">{label}</label>
                            <input
                              type={type} name={name} value={form[name]} onChange={handleChange} required placeholder={placeholder}
                              className="w-full px-4 py-3 rounded-xl text-[14px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all focus:border-genz-blue/60 focus:ring-2 focus:ring-genz-blue/15"
                              style={{ background: '#ffffff', border: '1px solid var(--brand-border)' }}
                            />
                          </div>
                        ))}
                      </div>

                      <div>
                        <label className="block text-genz-navy/80 text-[12.5px] font-semibold mb-1.5">Subject</label>
                        <input
                          type="text" name="subject" value={form.subject} onChange={handleChange} required placeholder="What is this about?"
                          className="w-full px-4 py-3 rounded-xl text-[14px] text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all focus:border-genz-blue/60 focus:ring-2 focus:ring-genz-blue/15"
                          style={{ background: '#ffffff', border: '1px solid var(--brand-border)' }}
                        />
                      </div>

                      <div>
                        <label className="block text-genz-navy/80 text-[12.5px] font-semibold mb-1.5">Message</label>
                        <textarea
                          name="message" value={form.message} onChange={handleChange} required rows={5}
                          placeholder="Tell us about your project or question..."
                          className="w-full px-4 py-3 rounded-xl text-[14px] text-genz-navy placeholder:text-genz-muted/70 outline-none resize-none transition-all focus:border-genz-blue/60 focus:ring-2 focus:ring-genz-blue/15"
                          style={{ background: '#ffffff', border: '1px solid var(--brand-border)' }}
                        />
                      </div>

                      {status === 'error' && (
                        <p className="text-red-500 text-[13px]">Failed to send. Please try WhatsApp instead.</p>
                      )}

                      <button
                        type="submit"
                        disabled={status === 'sending'}
                        className="btn-grad w-full flex items-center justify-center gap-2 py-3.5 rounded-[14px] text-[15px] font-bold disabled:opacity-50"
                      >
                        <Send size={16} />
                        {status === 'sending' ? 'Sending...' : 'Send Message'}
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT — WhatsApp + Info */}
            <div ref={infoRef} className={`reveal delay-150 ${infoV ? 'visible' : ''} space-y-5`}>
              <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
                className="hover-glow flex items-center gap-4 p-6 rounded-2xl bg-white border border-emerald-200/60"
                style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.08), #ffffff)' }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white"
                  style={{ background: 'linear-gradient(135deg,#10B981,#059669)', boxShadow: '0 12px 26px -10px rgba(16,185,129,0.5)' }}>
                  <MessageCircle size={20} />
                </div>
                <div>
                  <div className="text-genz-navy font-bold text-[15.5px]">Chat on WhatsApp</div>
                  <div className="text-genz-muted text-[13px] mt-0.5">Fastest response — usually within minutes.</div>
                </div>
              </a>

              <a href="mailto:admin@genzdigitalstore.com"
                className="hover-glow flex items-center gap-4 p-6 rounded-2xl bg-white border border-blue-200/60"
                style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.06), #ffffff)' }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white"
                  style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 12px 26px -10px rgba(37,99,235,0.5)' }}>
                  <Mail size={20} />
                </div>
                <div>
                  <div className="text-genz-navy font-bold text-[15.5px]">Email us</div>
                  <div className="text-genz-muted text-[13px] mt-0.5">admin@genzdigitalstore.com</div>
                </div>
              </a>

              <div className="gz-card-soft p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2' }}>
                    <Clock size={18} />
                  </div>
                  <div className="text-genz-navy font-bold text-[15.5px]">Response time</div>
                </div>
                <p className="text-genz-muted text-[14px] leading-relaxed">
                  Replies within a few hours during business days. WhatsApp messages are typically answered within minutes.
                </p>
              </div>

              <div className="gz-card-soft p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(37,99,235,0.12)', color: '#2563EB' }}>
                    <Shield size={18} />
                  </div>
                  <div className="text-genz-navy font-bold text-[15.5px]">Private & secure</div>
                </div>
                <p className="text-genz-muted text-[14px] leading-relaxed">
                  Your details are kept confidential and only used to respond to your enquiry.
                </p>
              </div>
            </div>

          </div>
        </div>
      </section>
    </div>
  );
};

export default Contact;

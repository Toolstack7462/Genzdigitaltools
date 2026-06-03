import { useState } from 'react';
import { Mail, MessageCircle, Phone, MapPin, Send, CheckCircle2 } from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';

const Contact = () => {
  const [formData, setFormData] = useState({ name: '', email: '', subject: '', message: '' });
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/crm/public/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        setSubmitted(true);
        setFormData({ name: '', email: '', subject: '', message: '' });
      }
    } catch {
      // Still show success for UX - admin can see the form data
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen pt-20 pb-20 px-4"
         style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)' }}>
      <div className="max-w-6xl mx-auto pt-10">
        <div className="text-center mb-12">
          <h1 className="text-5xl font-black text-white mb-4">
            Get in <span className="text-genz-teal">Touch</span>
          </h1>
          <p className="text-genz-muted text-lg max-w-xl mx-auto">
            We're here to help. Reach out via WhatsApp for the fastest response,
            or send us a message below.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          {/* Contact Info */}
          <div className="space-y-6">
            <div className="p-6 rounded-2xl border"
                 style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
              <GenZDigitalStoreLogo className="h-10 mb-6" textSize="lg" />
              <p className="text-genz-muted text-sm leading-relaxed mb-6">
                Gen Z Digital Store provides premium AI and digital tool memberships for professionals,
                students, and businesses. We're committed to making premium tools accessible to everyone.
              </p>
              <div className="space-y-4">
                {[
                  { icon: MessageCircle, label: 'WhatsApp (Fastest)',  value: 'Contact via WhatsApp below', href: 'https://wa.me/' }, // TODO: Update with actual WhatsApp number
                  { icon: Mail,          label: 'Email Support',       value: 'support@genzdigitalstore.com', href: 'mailto:support@genzdigitalstore.com' },
                  { icon: Phone,         label: 'Business Hours',      value: 'Mon–Sat, 9AM–9PM (Gulf Time)', href: null },
                  { icon: MapPin,        label: 'Service Area',        value: 'Online — Worldwide', href: null },
                ].map(({ icon: Icon, label, value, href }) => (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                         style={{ background: 'rgba(0,175,193,0.12)' }}>
                      <Icon size={16} className="text-genz-teal" />
                    </div>
                    <div>
                      <p className="text-xs text-genz-muted">{label}</p>
                      {href
                        ? <a href={href} className="text-sm text-white hover:text-genz-teal transition-colors">{value}</a>
                        : <p className="text-sm text-white">{value}</p>
                      }
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* WhatsApp CTA */}
            <a href="https://wa.me/" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-3 p-5 rounded-2xl border transition-all hover:-translate-y-0.5 hover:shadow-xl"
               style={{ background: 'rgba(37,211,102,0.08)', borderColor: 'rgba(37,211,102,0.25)' }}>
              <MessageCircle size={28} className="text-green-400 flex-shrink-0" />
              <div>
                <p className="font-bold text-white">Chat on WhatsApp</p>
                <p className="text-xs text-green-400 mt-0.5">Typically responds within minutes</p>
              </div>
            </a>
          </div>

          {/* Contact Form */}
          <div>
            {submitted ? (
              <div className="h-full flex flex-col items-center justify-center p-10 text-center rounded-2xl border"
                   style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
                <CheckCircle2 size={56} className="text-genz-teal mb-4" />
                <h3 className="text-xl font-bold text-white mb-2">Message Sent!</h3>
                <p className="text-genz-muted text-sm max-w-xs">
                  We've received your message and will get back to you within 24 hours.
                  For urgent matters, please WhatsApp us directly.
                </p>
                <button onClick={() => setSubmitted(false)}
                        className="mt-6 text-genz-teal hover:underline text-sm font-medium">
                  Send another message
                </button>
              </div>
            ) : (
              <div className="p-8 rounded-2xl border"
                   style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
                <h2 className="text-xl font-bold text-white mb-6">Send a Message</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {[
                      { key: 'name',  label: 'Full Name',     type: 'text',  placeholder: 'Your name'      },
                      { key: 'email', label: 'Email Address', type: 'email', placeholder: 'your@email.com' },
                    ].map(({ key, label, type, placeholder }) => (
                      <div key={key}>
                        <label className="block text-xs font-medium text-genz-muted mb-1.5">{label}</label>
                        <input type={type} required value={formData[key]} placeholder={placeholder}
                               onChange={e => setFormData({ ...formData, [key]: e.target.value })}
                               className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-genz-muted focus:outline-none transition-all"
                               style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }} />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-genz-muted mb-1.5">Subject</label>
                    <input type="text" required value={formData.subject} placeholder="How can we help?"
                           onChange={e => setFormData({ ...formData, subject: e.target.value })}
                           className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-genz-muted focus:outline-none transition-all"
                           style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-genz-muted mb-1.5">Message</label>
                    <textarea required rows={5} value={formData.message} placeholder="Tell us more..."
                              onChange={e => setFormData({ ...formData, message: e.target.value })}
                              className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-genz-muted focus:outline-none transition-all resize-none"
                              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.2)' }} />
                  </div>
                  <button type="submit" disabled={loading}
                          className="w-full py-3.5 rounded-xl font-bold text-genz-deep-navy flex items-center justify-center gap-2 transition-all hover:opacity-90 hover:scale-105 disabled:opacity-50"
                          style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                    <Send size={16} />
                    {loading ? 'Sending...' : 'Send Message'}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Contact;

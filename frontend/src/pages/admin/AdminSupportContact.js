import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { LifeBuoy, Loader2, MessageCircle, Mail, Save, RotateCcw, Info } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

/**
 * Admin → Support Contact. Edits the OFFICIAL public support WhatsApp number + email.
 * Everything public (website, client dashboard, renew buttons, emails, extension expired
 * page) reads it from GET /public/support-contact. Leaving a field empty falls back to the
 * server default. This page never touches client numbers, payments, OTP or tool settings.
 */
const SOURCE_LABEL = {
  admin: 'Admin setting',
  env: 'Server environment default',
  default: 'Built-in default',
};

const AdminSupportContact = () => {
  const { showSuccess, showError } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(null);
  const [form, setForm] = useState({ whatsappNumber: '', supportEmail: '' });

  const apply = (data) => {
    setView(data);
    setForm({
      whatsappNumber: data?.stored?.whatsappNumber ? `+${data.stored.whatsappNumber}` : '',
      supportEmail: data?.stored?.supportEmail || '',
    });
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/admin/support-settings');
      apply(res.data);
    } catch (_) { showError('Failed to load support contact'); }
    finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    try {
      setSaving(true);
      const res = await api.put('/admin/support-settings', patch);
      apply(res.data);
      showSuccess('Support contact saved. Live everywhere within about a minute.');
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to save support contact');
    } finally { setSaving(false); }
  };

  const inputCls = 'w-full px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all';
  const contact = view?.contact;
  const fallback = view?.fallback;

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-3xl mx-auto space-y-5">
        <div>
          <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
            <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center"><LifeBuoy size={18} /></span>
            Support Contact
          </h1>
          <p className="text-sm text-genz-muted mt-0.5">
            The official WhatsApp number and email shown on the website, client dashboard, renew buttons, emails and the extension's expired page.
          </p>
        </div>

        {loading ? (
          <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-6 flex items-center gap-2 text-sm text-genz-muted`}>
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {contact && (
              <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-2`} data-testid="support-live">
                <div className="text-xs font-bold uppercase tracking-wide text-genz-muted">Live now · {SOURCE_LABEL[contact.source] || contact.source}</div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-genz-navy">
                  <span className="inline-flex items-center gap-2"><MessageCircle size={15} className="text-emerald-600" /> {contact.whatsappDisplay}
                    <span className="text-genz-muted">({contact.whatsappUrl})</span></span>
                  <span className="inline-flex items-center gap-2"><Mail size={15} className="text-blue-600" /> {contact.email}</span>
                </div>
              </div>
            )}

            <form
              className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-4`}
              onSubmit={(e) => { e.preventDefault(); save({ whatsappNumber: form.whatsappNumber, supportEmail: form.supportEmail }); }}
            >
              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-genz-navy">WhatsApp support number</span>
                <input className={inputCls} inputMode="tel" autoComplete="off" maxLength={24}
                  placeholder={fallback ? fallback.whatsappDisplay : '+92 335 5500134'}
                  value={form.whatsappNumber}
                  onChange={e => setForm(f => ({ ...f, whatsappNumber: e.target.value }))}
                  data-testid="support-whatsapp-input" />
                <span className="block text-xs text-genz-muted">With country code, e.g. +92 335 5500134 or 0335 5500134 (Pakistan assumed for a leading 0).</span>
              </label>

              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-genz-navy">Support email</span>
                <input className={inputCls} type="email" autoComplete="off" maxLength={254}
                  placeholder={fallback ? fallback.email : 'admin@genzdigitalstore.com'}
                  value={form.supportEmail}
                  onChange={e => setForm(f => ({ ...f, supportEmail: e.target.value }))}
                  data-testid="support-email-input" />
              </label>

              <p className="flex items-start gap-2 text-xs text-genz-muted">
                <Info size={14} className="mt-0.5 shrink-0" />
                Leave a field empty to use the server default{fallback ? ` (${fallback.whatsappDisplay} · ${fallback.email})` : ''}.
                Visitors pick up a change on their next page load; already-open pages keep the previous value until refreshed.
              </p>

              <div className="flex flex-wrap gap-2.5">
                <button type="submit" disabled={saving}
                  className="btn-grad inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold disabled:opacity-60">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
                </button>
                <button type="button" disabled={saving}
                  onClick={() => save({ whatsappNumber: '', supportEmail: '' })}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border border-genz-border text-genz-navy hover:bg-genz-bg disabled:opacity-60">
                  <RotateCcw size={15} /> Reset to defaults
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminSupportContact;

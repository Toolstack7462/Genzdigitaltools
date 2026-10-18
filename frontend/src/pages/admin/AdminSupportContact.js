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

/**
 * MAY THE ADMIN WRITE? Only when the current values were actually READ.
 *
 * An empty string on PUT means "clear to the fallback", so a blank-but-editable form is a data-loss
 * weapon: one Save wipes the live support contact, and the request SUCCEEDS, so nothing warns
 * anybody. The fields may only be editable when we know what is stored.
 *
 * THREE SIGNALS, IN ORDER. The first is the contract; the second exists because the backend half of
 * this fix is NOT YET DEPLOYED, so in production today `storedAvailable` is absent.
 *
 *   1. `storedAvailable === true`   -> read succeeded. Editable.
 *      `storedAvailable === false`  -> read failed. NOT editable.
 *      Anything else present (null, 0, "", "false", {}) is MALFORMED and fails safe: not editable.
 *      A malformed flag is a broken contract, and a broken contract is not permission to write.
 *
 *   2. FLAG ABSENT (a backend predating this fix, which is what is live right now). Fall back to a
 *      consistency check between the two values the response already carries. `contact.source` is
 *      'admin' only when the row was read AND held a valid value (utils/supportContact.js). So
 *      `source === 'admin'` with BOTH stored fields blank is a contradiction: the effective contact
 *      came out of that row, so the row cannot be empty — the admin-view read must have failed and
 *      been reported as blanks. Not editable.
 *      `source` of 'env'/'default' with blank stored values is consistent with a genuinely empty
 *      record, so that stays editable: an admin setting the contact for the first time must be able
 *      to.
 *
 *   3. `stored` missing, not an object, or carrying non-string fields -> malformed. Not editable.
 *
 * A failed GET (`loadFailed`) is not editable either, whatever is left in state.
 *
 * Exported for direct testing: this guard is the load-bearing part of the page.
 */
export function isStoredKnown({ loadFailed, view }) {
  if (loadFailed) return false;
  if (view == null || typeof view !== 'object') return false;

  // (3) the stored block itself must be well formed before anything is believed about it.
  const stored = view.stored;
  if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) return false;
  for (const k of ['whatsappNumber', 'supportEmail']) {
    const v = stored[k];
    if (v !== undefined && typeof v !== 'string') return false;
  }

  // (1) the explicit contract, when the running backend speaks it.
  const flag = view.storedAvailable;
  if (flag !== undefined) return flag === true;

  // (2) cross-version fallback for a backend that does not send the flag yet.
  const blank = !stored.whatsappNumber && !stored.supportEmail;
  const fromAdminRow = view.contact && view.contact.source === 'admin';
  if (blank && fromAdminRow) return false;
  return true;
}

const AdminSupportContact = () => {
  const { showSuccess, showError } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState({ whatsappNumber: '', supportEmail: '' });

  const storedKnown = isStoredKnown({ loadFailed, view });

  const apply = (data) => {
    setView(data);
    setLoadFailed(false);
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
    } catch (_) {
      setLoadFailed(true);
      setView(null);
      setForm({ whatsappNumber: '', supportEmail: '' });
      showError('Failed to load support contact');
    }
    finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    try {
      setSaving(true);
      const res = await api.put('/admin/support-settings', patch);
      apply(res.data);
      // TRUTHFUL, because two 60s layers stack and only one of them is cleared by this save:
      // updateSupportContact() clears the in-memory cache of the worker that handled THIS request,
      // but other Passenger workers keep their own copy for up to CACHE_TTL_MS (60s); and the
      // public endpoint is served with `Cache-Control: public, max-age=60`, so a browser or CDN can
      // hold the previous value for another 60s. Worst case is therefore ~2 minutes, and only on a
      // visitor's NEXT page load. "Within about a minute" was optimistic.
      showSuccess('Support contact saved. Visitors see it on their next page load, usually within a minute and at most about two.');
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

            {!storedKnown && (
              <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-2 border-amber-300`}
                   data-testid="support-stored-unavailable" role="alert">
                <div className="text-sm font-bold text-amber-700">
                  The saved support contact could not be read.
                </div>
                <p className="text-sm text-genz-navy">
                  The fields below are blank because the current values are <strong>unknown</strong>,
                  not because they are empty. Saving is disabled so an edit cannot overwrite them.
                  Visitors are unaffected — the live contact above is still being served.
                </p>
                <button type="button" onClick={load} disabled={loading}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold border border-genz-border text-genz-navy hover:bg-genz-bg disabled:opacity-60"
                  data-testid="support-retry">
                  Try again
                </button>
              </div>
            )}

            <form
              className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-4`}
              onSubmit={(e) => {
                e.preventDefault();
                // Belt and braces: the button is disabled, but a form can also be submitted by
                // pressing Enter in a field, so the guard lives on the handler too.
                if (!storedKnown) return;
                save({ whatsappNumber: form.whatsappNumber, supportEmail: form.supportEmail });
              }}
            >
              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-genz-navy">WhatsApp support number</span>
                <input className={inputCls} inputMode="tel" autoComplete="off" maxLength={24} disabled={!storedKnown}
                  placeholder={fallback ? fallback.whatsappDisplay : '+92 335 5500134'}
                  value={form.whatsappNumber}
                  onChange={e => setForm(f => ({ ...f, whatsappNumber: e.target.value }))}
                  data-testid="support-whatsapp-input" />
                <span className="block text-xs text-genz-muted">With country code, e.g. +92 335 5500134 or 0335 5500134 (Pakistan assumed for a leading 0).</span>
              </label>

              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-genz-navy">Support email</span>
                <input className={inputCls} type="email" autoComplete="off" maxLength={254} disabled={!storedKnown}
                  placeholder={fallback ? fallback.email : 'admin@genzdigitalstore.com'}
                  value={form.supportEmail}
                  onChange={e => setForm(f => ({ ...f, supportEmail: e.target.value }))}
                  data-testid="support-email-input" />
              </label>

              <p className="flex items-start gap-2 text-xs text-genz-muted">
                <Info size={14} className="mt-0.5 shrink-0" />
                Leave a field empty to use the server default{fallback ? ` (${fallback.whatsappDisplay} · ${fallback.email})` : ''}.
                Visitors pick up a change on their next page load — usually within a minute, at most about two
                (each server worker caches for 60s and the public response is cacheable for 60s).
                Already-open pages keep the previous value until refreshed.
              </p>

              <div className="flex flex-wrap gap-2.5">
                <button type="submit" disabled={saving || !storedKnown}
                  title={!storedKnown ? 'Disabled: the saved values could not be read' : undefined}
                  className="btn-grad inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold disabled:opacity-60">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
                </button>
                <button type="button" disabled={saving || !storedKnown}
                  title={!storedKnown ? 'Disabled: the saved values could not be read' : undefined}
                  onClick={() => { if (!storedKnown) return; save({ whatsappNumber: '', supportEmail: '' }); }}
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

import { useEffect, useState } from 'react';
import { Save, ShieldCheck } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Textarea } from '../components/ui';
// Same brand asset the backend embeds in the PDF, so the preview cannot drift from the document.
import invoiceLogo from '../../../assets/brand/logo-genz-digital-store.png';
import { today } from '../constants';

const toForm = (row = {}) => ({
  storeName: row.store_name || 'Gen Z Digital Store',
  storeEmail: row.store_email || '',
  storePhone: row.store_phone || '',
  storeAddress: row.store_address || '',
  invoicePrefix: row.invoice_prefix || 'GDS',
  defaultCurrency: row.default_currency || 'PKR',
  whatsappCountryCode: row.whatsapp_country_code || '92',
  invoiceTerms: row.invoice_terms || '',
  logoUrl: row.logo_url || '',
  includeCredentialsInInvoice: Boolean(row.include_credentials_in_invoice),
  includeCredentialsInMessages: Boolean(row.include_credentials_in_messages),
});

export default function SettingsPage() {
  const crm = useBusinessCrm();
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try { const response = await crmApi.get('/admin/settings'); setForm(toForm(response.data)); }
    catch (e) { setError(messageFromError(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const change = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setSaved(''); setError('');
    try { const response = await crmApi.put('/admin/settings', form); setForm(toForm(response.data)); setSaved('Store and invoice settings saved.'); await crm.reloadBootstrap(); }
    catch (e) { setError(messageFromError(e)); }
    finally { setSaving(false); }
  };
  if (loading) return <Loading label="Loading store settings…"/>;
  if (!form && error) return <ErrorState message={error} onRetry={load}/>;
  return <><PageHeader title="Store & invoice settings" description="Brand invoices, choose the default ledger currency and control sensitive credential output."/>
    {error && <div className="bcrm-banner warning">{error}</div>}{saved && <div className="bcrm-banner">{saved}</div>}
    <form className="bcrm-form" onSubmit={submit}>
      <Card title="Store identity" subtitle="Used on invoices and reminder messages"><div className="bcrm-form-grid">
        <Field label="Store name"><Input required maxLength={160} value={form.storeName} onChange={(e)=>change('storeName',e.target.value)}/></Field>
        <Field label="Store email"><Input type="email" value={form.storeEmail} onChange={(e)=>change('storeEmail',e.target.value)}/></Field>
        <Field label="Phone"><Input value={form.storePhone} onChange={(e)=>change('storePhone',e.target.value)}/></Field>
        <Field label="Logo URL" hint="Relative or HTTPS URL. Upload handling remains in the existing website media flow."><Input value={form.logoUrl} onChange={(e)=>change('logoUrl',e.target.value)}/></Field>
        <Field label="Address" className="bcrm-form-grid-wide"><Textarea value={form.storeAddress} onChange={(e)=>change('storeAddress',e.target.value)}/></Field>
      </div></Card>
      <Card title="Invoice defaults" subtitle="Every sale still stores its own immutable currency"><div className="bcrm-form-grid bcrm-form-grid-3">
        <Field label="Invoice prefix"><Input required pattern="[A-Za-z0-9-]+" value={form.invoicePrefix} onChange={(e)=>change('invoicePrefix',e.target.value.toUpperCase())}/></Field>
        <Field label="Default currency"><Select value={form.defaultCurrency} onChange={(e)=>change('defaultCurrency',e.target.value)}>{['PKR','INR','NGN'].map((x)=><option key={x}>{x}</option>)}</Select></Field>
        <Field label="WhatsApp country code"><Input inputMode="numeric" value={form.whatsappCountryCode} onChange={(e)=>change('whatsappCountryCode',e.target.value.replace(/\D/g,''))}/></Field>
        <Field label="Invoice terms"><Textarea value={form.invoiceTerms} onChange={(e)=>change('invoiceTerms',e.target.value)}/></Field>
      </div></Card>
      {/*
        Read-only preview of how the store identity appears at the top of a PDF invoice. It mirrors
        the PDF header rather than driving it: the PDF embeds a fixed local brand asset, so the
        operator can confirm the wording and contact details without a download.
      */}
      <Card title="Invoice header preview" subtitle="How the top of a customer invoice reads with these details">
        <div className="bcrm-invoice-preview" aria-label="Invoice header preview">
          <div className="bcrm-invoice-preview-bar">
            <img src={invoiceLogo} alt="" aria-hidden="true" />
            <div>
              <strong>{form.storeName || 'Gen Z Digital Store'}</strong>
              <span>BUSINESS INVOICE</span>
            </div>
            <div className="bcrm-invoice-preview-meta">
              <strong>{form.invoicePrefix || 'GDS'}-000142</strong>
              <span>Date: {today()}</span>
            </div>
          </div>
          <div className="bcrm-invoice-preview-body">
            <p><em>Billed in {form.defaultCurrency || 'PKR'} · status shown as Paid, Partially Paid, Pending or Cancelled</em></p>
            <p>{[form.storePhone, form.storeEmail, form.storeAddress].filter(Boolean).join(' • ') || 'Add a phone, email and address to show contact details in the invoice footer.'}</p>
          </div>
        </div>
      </Card>
      <Card title="Credential policy" subtitle="Encrypted credentials stay server-side; output requires both policy and permission"><div className="bcrm-form">
        <label className="bcrm-check"><input type="checkbox" checked={form.includeCredentialsInInvoice} onChange={(e)=>change('includeCredentialsInInvoice',e.target.checked)}/> Permit credentials on PDF invoices for users who also hold the invoice.credentials permission</label>
        <label className="bcrm-check"><input type="checkbox" checked={form.includeCredentialsInMessages} onChange={(e)=>change('includeCredentialsInMessages',e.target.checked)}/> Permit credentials in prepared messages for authorized users</label>
        <div className="bcrm-banner"><ShieldCheck size={15}/> Viewer access never receives decrypted credential fields.</div>
      </div></Card>
      <div className="bcrm-form-actions"><Button type="submit" icon={Save} disabled={saving}>{saving?'Saving…':'Save settings'}</Button></div>
    </form></>;
}

/**
 * Admin WhatsApp message templates (manual send only — never automatic).
 *
 * SAFETY: templates only ever interpolate non-sensitive CRM fields
 * (client_name, client_email, tool_name, expiry_date, latest_extension_version).
 * They MUST NOT contain cookies, tokens, sessions, passwords, lease tokens, API
 * keys, or any secret. Clicking "Send" opens WhatsApp with the message pre-filled;
 * the admin reviews and sends it themselves.
 */

export const WA_TEMPLATES = [
  { key: 'renewal',  label: 'Renewal reminder',
    body: 'Hi {client_name}, this is a friendly reminder from Gen Z Digital Store that your plan is due for renewal{expiry_clause}. Reply here to renew and keep uninterrupted access. Thank you!' },
  { key: 'expired',  label: 'Plan expired',
    body: 'Hi {client_name}, your Gen Z Digital Store plan has expired{expiry_clause}. Renew anytime to restore access to your tools — just reply here and we will help you out.' },
  { key: 'payment',  label: 'Payment received',
    body: 'Hi {client_name}, we have received your payment — thank you! Your Gen Z Digital Store access is active. Reach out anytime if you need anything.' },
  { key: 'extension', label: 'Extension update available',
    body: 'Hi {client_name}, a new Gen Z Digital Store extension update{version_clause} is available. Please update it from your dashboard for the best experience.' },
  { key: 'assigned', label: 'Tool assigned',
    body: 'Hi {client_name}, {tool_clause} has been added to your Gen Z Digital Store account. Log in to your dashboard to start using it.' },
  { key: 'support',  label: 'Support follow-up',
    body: 'Hi {client_name}, following up from Gen Z Digital Store support — is everything working well for you? Let us know if we can help with anything.' },
];

// Replace {placeholders} with safe context values and tidy optional clauses so a
// message never shows a dangling "{expiry_clause}" or awkward double spaces.
export function fillTemplate(body, ctx = {}) {
  const name = ctx.client_name || 'there';
  const expiry = ctx.expiry_date ? ` (expiry: ${ctx.expiry_date})` : '';
  const version = ctx.latest_extension_version ? ` (v${ctx.latest_extension_version})` : '';
  const tool = ctx.tool_name ? `"${ctx.tool_name}"` : 'a new tool';
  return body
    .replace(/\{client_name\}/g, name)
    .replace(/\{client_email\}/g, ctx.client_email || '')
    .replace(/\{expiry_clause\}/g, expiry)
    .replace(/\{version_clause\}/g, version)
    .replace(/\{tool_clause\}/g, tool)
    .replace(/\{tool_name\}/g, ctx.tool_name || 'your tool')
    .replace(/\{expiry_date\}/g, ctx.expiry_date || '')
    .replace(/\{latest_extension_version\}/g, ctx.latest_extension_version || '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Build a wa.me link. With no phone, WhatsApp lets the admin pick the recipient
// contact — we never store client phone numbers. `phone` (digits only) is used if
// the client record ever carries one.
export function buildWhatsAppUrl(message, phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}

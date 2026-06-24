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

/**
 * Normalize a typed phone number into the digits-only, country-coded form wa.me
 * expects (no "+", no spaces). Handles the common ways admins/clients write numbers:
 *   "+92 300 1234567"  → "923001234567"   (leading + → drop it)
 *   "0092 300 1234567" → "923001234567"   (00 international prefix → drop it)
 *   "+2348012345678"   → "2348012345678"  (any country, e.g. +234, +91)
 *   "0300-1234567"     → "923001234567"   (national 0… → prepend defaultCC)
 *   "923001234567"     → "923001234567"   (already country-coded → unchanged)
 * defaultCC (digits only, default 92 = Pakistan, the store's base) is applied ONLY
 * to local numbers that start with a single 0; numbers that already carry a country
 * code via "+" or "00" keep theirs. Returns "" if there are no digits.
 */
export function normalizeWhatsAppNumber(input, defaultCC = '92') {
  if (input == null) return '';
  const raw = String(input).trim();
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus) return digits;                     // "+CC…" → CC… (digits already stripped of +)
  if (digits.startsWith('00')) return digits.slice(2); // "00CC…" → CC…
  if (digits.startsWith('0')) return String(defaultCC).replace(/\D/g, '') + digits.slice(1); // national → CC…
  return digits;                                  // assume already country-coded
}

// A normalized WhatsApp number is valid if it is 8–15 digits (E.164 max is 15).
export function isValidWhatsAppNumber(digits) {
  return /^\d{8,15}$/.test(String(digits || ''));
}

function fmtWaDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Build a professional, ready-to-send renewal message for a client. Includes the
 * client's first name, each tool with its expiry date/status, a renewal instruction,
 * and the Gen Z Digital Store signature. SAFE CONTENT ONLY — never tokens, cookies,
 * sessions, passwords, lease tokens, or any secret. The admin reviews before sending;
 * the message is never auto-sent (wa.me always requires a manual Send tap).
 * `tools` = [{ toolName, endDate, daysLeft, expired }].
 */
export function buildRenewalMessage({ clientName, tools = [] } = {}) {
  const name = String(clientName || '').trim().split(/\s+/)[0] || 'there';
  const anyExpired = (tools || []).some(t => t.expired);
  const lines = [];
  lines.push(`Hello ${name},`);
  lines.push('');
  lines.push(anyExpired
    ? 'This is a reminder from Gen Z Digital Store regarding the following tool access on your account that needs renewal:'
    : 'This is a friendly reminder from Gen Z Digital Store that the following tool access on your account is expiring soon:');
  lines.push('');
  (tools || []).forEach(t => {
    const when = fmtWaDate(t.endDate);
    const status = t.expired
      ? `expired${when ? ` on ${when}` : ''}`
      : (t.daysLeft === 0 ? 'expires today' : `expires in ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'}${when ? ` (${when})` : ''}`);
    lines.push(`• ${t.toolName || 'Tool'} — ${status}`);
  });
  lines.push('');
  lines.push('To keep your access uninterrupted, just reply to this message and we will renew it for you right away.');
  lines.push('');
  lines.push('Thank you,');
  lines.push('Gen Z Digital Store');
  return lines.join('\n');
}

// Optional retention offer clause (admin-controlled; never auto-applied).
function offerClause(offer) {
  if (offer === 'discount10') return 'To help you continue without interruption, we can offer you a limited 10% renewal discount for the next 48 hours.';
  if (offer === 'bonus2') return 'Renew now and we will add 2 bonus days of access on us, as a thank-you.';
  return 'To help you continue without interruption, just reply here and we will reactivate your access right away.';
}

/**
 * Build a professional renewal RECOVERY/follow-up message for an EXPIRED client,
 * with an optional retention offer ('none' | 'discount10' | 'bonus2'). Mirrors the
 * approved support wording. Safe content only — no secrets; never auto-sent.
 * `tools` = [{ toolName, ... }].
 */
export function buildFollowupMessage({ clientName, tools = [], offer = 'none' } = {}) {
  const name = String(clientName || '').trim().split(/\s+/)[0] || 'there';
  const names = (tools || []).map(t => t.toolName).filter(Boolean);
  const toolPhrase = names.length === 0 ? 'your tools'
    : names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return [
    `Hello ${name},`,
    '',
    `Your Gen Z Digital Store access for ${toolPhrase} has expired.`,
    '',
    `We noticed you have not renewed yet. ${offerClause(offer)}`,
    '',
    'Reply here if you want us to reactivate your access.',
    '',
    'Thank you,',
    'Gen Z Digital Store Support',
  ].join('\n');
}

const OFFER_INTRO = {
  combo: 'here is a combo deal we think you will love',
  renewal: 'here is a special renewal offer for you',
  upgrade: 'here is an upgrade offer for your account',
  recovery: 'we would love to welcome you back with this offer',
};

/**
 * Build a professional WhatsApp message for a marketing Offer (combo / renewal /
 * upgrade / recovery). Safe content only (title, description, tools, price, expiry)
 * — no secrets; never auto-sent. `offer` = { title, description, toolNames[],
 * priceText, expiryDate, kind }.
 */
export function buildOfferMessage({ clientName, offer = {} } = {}) {
  const name = String(clientName || '').trim().split(/\s+/)[0] || 'there';
  const tools = (offer.toolNames || []).filter(Boolean);
  const lines = [`Hello ${name},`, ''];
  lines.push(`From Gen Z Digital Store — ${OFFER_INTRO[offer.kind] || 'a special offer for you'}: ${offer.title || ''}`.trim());
  if (offer.description) { lines.push(''); lines.push(offer.description); }
  if (tools.length) { lines.push(''); lines.push(`Included: ${tools.join(', ')}`); }
  if (offer.priceText) { lines.push(''); lines.push(offer.priceText); }
  if (offer.expiryDate) {
    const d = new Date(offer.expiryDate);
    if (!isNaN(d.getTime())) { lines.push(''); lines.push(`Valid until ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`); }
  }
  lines.push('', 'Reply here to claim it or if you have any questions.', '', 'Thank you,', 'Gen Z Digital Store');
  return lines.join('\n');
}

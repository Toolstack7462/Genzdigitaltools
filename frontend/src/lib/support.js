// Central support / "Renew Plan" configuration.
// Single source of truth for the support WhatsApp number used by every
// expired/renew action (dashboard, My Tools, expired cards, extension page).
//
// wa.me REQUIRES the number with no "+" and no spaces.
export const SUPPORT_WHATSAPP_NUMBER = '923027467462';

// Plain-text fallback contact (used if WhatsApp can't open in the browser).
export const SUPPORT_CONTACT_PATH = '/contact';

/**
 * Build a wa.me renewal link with a safe, pre-filled message.
 * Includes ONLY non-sensitive info (name/email/tool/status). Never tokens,
 * cookies, sessions, lease tokens, passwords, or secrets.
 */
export function buildRenewWhatsAppUrl({ clientName, clientEmail, toolName, status } = {}) {
  const lines = ['Hello, I want to renew my plan.'];
  if (toolName) lines.push(`Tool: ${toolName}`);
  if (status) lines.push(`Status: ${status}`);
  const who = clientName || clientEmail;
  if (who) lines.push(`Account: ${who}`);
  const text = encodeURIComponent(lines.join('\n'));
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${text}`;
}

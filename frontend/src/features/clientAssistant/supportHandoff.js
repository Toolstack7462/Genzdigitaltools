// Gen Z Guide — human-support handoff. REUSES the single central support-contact helper in
// frontend/src/lib/support.js (admin-managed number, with its own fallback). We never hard-code a
// second WhatsApp number and never include tokens, cookies, sessions, or private diagnostics.
import { buildSupportWhatsAppUrl } from '../../lib/support';

/** Build the safe, pre-filled support message. ONLY non-sensitive fields are ever included. */
export function buildAssistantSupportMessage({ issueTitle, toolName, clientName, clientEmail } = {}) {
  const lines = ['Hello Gen Z Digital Store Support. I need help with my account.'];
  if (issueTitle) lines.push(`Issue: ${issueTitle}`);
  if (toolName) lines.push(`Tool: ${toolName}`);
  const who = clientName || clientEmail;
  if (who) lines.push(`Account: ${who}`);
  lines.push('I have already followed the Gen Z Guide steps.');
  return lines.join('\n');
}

/** Safe wa.me URL via the central helper — the number comes from lib/support.js, never from here. */
export function buildAssistantSupportUrl(fields = {}) {
  return buildSupportWhatsAppUrl(buildAssistantSupportMessage(fields));
}

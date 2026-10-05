// Central support / "Renew Plan" configuration.
// Single source of truth for the official support WhatsApp number + support email
// used by every website, dashboard and renew action.
//
// The live value is ADMIN-EDITABLE (Admin → Support Contact), served by
// GET /api/crm/public/support-contact. The constants below are only the bundled
// fallback, used until (or if) that request answers — so a support link is never
// broken, even with the API down.
import { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../services/api';

// wa.me REQUIRES the number with no "+" and no spaces.
export const SUPPORT_WHATSAPP_NUMBER = '923355500134';

// Human-readable form of the same number, for visible contact text.
export const SUPPORT_WHATSAPP_DISPLAY = '+92 335 5500134';

// Plain support chat link (no pre-filled message).
export const SUPPORT_WHATSAPP_URL = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`;

export const SUPPORT_EMAIL = 'admin@genzdigitalstore.com';

// Plain-text fallback contact (used if WhatsApp can't open in the browser).
export const SUPPORT_CONTACT_PATH = '/contact';

export const DEFAULT_SUPPORT_CONTACT = Object.freeze({
  whatsappNumber: SUPPORT_WHATSAPP_NUMBER,
  whatsappDisplay: SUPPORT_WHATSAPP_DISPLAY,
  whatsappUrl: SUPPORT_WHATSAPP_URL,
  email: SUPPORT_EMAIL,
});

const CACHE_KEY = 'genz_support_contact_v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** Accept only a well-formed contact; anything else → null (caller keeps its fallback). */
export function sanitizeContact(c) {
  if (!c || typeof c !== 'object') return null;
  const number = String(c.whatsappNumber || '');
  if (!/^\d{8,15}$/.test(number)) return null;
  const email = EMAIL_RE.test(String(c.email || '')) ? String(c.email) : SUPPORT_EMAIL;
  const display = /^\+[\d ]{8,24}$/.test(String(c.whatsappDisplay || '')) ? c.whatsappDisplay : `+${number}`;
  return {
    whatsappNumber: number,
    whatsappDisplay: display,
    whatsappUrl: `https://wa.me/${number}`, // always rebuilt from digits — never trust a URL
    email,
  };
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw && Date.now() - raw.at < CACHE_TTL_MS) return sanitizeContact(raw.contact);
  } catch (_) { /* storage blocked / corrupt → ignore */ }
  return null;
}

let current = readCache() || DEFAULT_SUPPORT_CONTACT;
let inflight = null;
const listeners = new Set();

/** Fetch the live contact once per page load (de-duplicated); never rejects. */
export function loadSupportContact() {
  if (!inflight) {
    inflight = Promise.resolve()
      .then(() => fetch(`${getApiBaseUrl()}/public/support-contact`, { credentials: 'omit' }))
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        const next = sanitizeContact(body && body.contact);
        if (next) {
          current = next;
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), contact: next })); } catch (_) {}
          listeners.forEach(fn => fn(next));
        }
        return current;
      })
      .catch(() => current);
  }
  return inflight;
}

/** Current best-known contact (synchronous). */
export function getSupportContact() {
  return current;
}

/** React hook: the live support contact; re-renders once when the admin value arrives. */
export function useSupportContact() {
  const [contact, setContact] = useState(current);
  useEffect(() => {
    listeners.add(setContact);
    setContact(current);
    loadSupportContact();
    return () => { listeners.delete(setContact); };
  }, []);
  return contact;
}

/** Support chat link with a pre-filled message (safely URL-encoded). */
export function buildSupportWhatsAppUrl(message, contact = current) {
  const base = contact.whatsappUrl;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/**
 * Build a wa.me renewal link with a safe, pre-filled message.
 * Includes ONLY non-sensitive info (name/email/tool/status). Never tokens,
 * cookies, sessions, lease tokens, passwords, or secrets.
 */
export function buildRenewWhatsAppUrl({ clientName, clientEmail, toolName, status } = {}, contact = current) {
  const lines = ['Hello, I want to renew my plan.'];
  if (toolName) lines.push(`Tool: ${toolName}`);
  if (status) lines.push(`Status: ${status}`);
  const who = clientName || clientEmail;
  if (who) lines.push(`Account: ${who}`);
  return buildSupportWhatsAppUrl(lines.join('\n'), contact);
}

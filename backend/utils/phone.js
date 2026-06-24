'use strict';

/**
 * Phone / WhatsApp number normalization — server-side mirror of the frontend
 * helper (components/admin/whatsappTemplates.js) so saved numbers are always
 * stored in the digits-only, country-coded form wa.me expects (no "+", no spaces).
 *
 *   "+92 300 1234567"  → "923001234567"   (leading + → drop it)
 *   "0092 300 1234567" → "923001234567"   (00 international prefix → drop it)
 *   "+2348012345678"   → "2348012345678"  (any country, e.g. +234, +91)
 *   "0300-1234567"     → "923001234567"   (national 0… → prepend defaultCC)
 *   "923001234567"     → "923001234567"   (already country-coded → unchanged)
 *
 * defaultCC (digits, default 92 = Pakistan, the store's base) is applied ONLY to
 * local numbers starting with a single 0. Returns "" when there are no digits.
 */
function normalizeWhatsAppNumber(input, defaultCC = '92') {
  if (input == null) return '';
  const raw = String(input).trim();
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return String(defaultCC).replace(/\D/g, '') + digits.slice(1);
  return digits;
}

// A normalized WhatsApp number is valid if it is 8–15 digits (E.164 max is 15).
function isValidWhatsAppNumber(digits) {
  return /^\d{8,15}$/.test(String(digits || ''));
}

module.exports = { normalizeWhatsAppNumber, isValidWhatsAppNumber };

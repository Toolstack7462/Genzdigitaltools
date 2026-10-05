'use strict';
/**
 * Official public support contact (WhatsApp + email) — the backend's single source.
 *
 * Precedence (highest first):
 *   1. Admin setting  — the single SupportSettings row (Admin → Support Contact).
 *   2. Environment    — SUPPORT_WHATSAPP_NUMBER / SUPPORT_EMAIL (deploy-time default).
 *   3. Built-in       — DEFAULTS below.
 * An invalid value at any level is ignored and the next level is used, so a bad
 * row or env var can never produce a broken wa.me link.
 *
 * Reads are cached per worker for CACHE_TTL_MS, so an admin change reaches every
 * Passenger worker within a minute, and public traffic never hammers the DB. A DB
 * failure NEVER throws to callers: they get the env/built-in contact instead.
 */
const { normalizeWhatsAppNumber, isValidWhatsAppNumber } = require('./phone');

const DEFAULTS = Object.freeze({
  whatsappNumber: '923355500134',
  supportEmail: 'admin@genzdigitalstore.com',
});

const CACHE_TTL_MS = 60 * 1000;
const DB_READ_TIMEOUT_MS = 1500;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

let cache = null; // { contact, at }

function cleanNumber(v) {
  const n = normalizeWhatsAppNumber(v);
  return isValidWhatsAppNumber(n) ? n : '';
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : '';
}

/** "923355500134" → "+92 335 5500134"; other countries → "+<digits>". */
function formatWhatsAppDisplay(digits) {
  const d = String(digits || '');
  const pk = /^92(\d{3})(\d{7})$/.exec(d);
  return pk ? `+92 ${pk[1]} ${pk[2]}` : `+${d}`;
}

function toContact({ whatsappNumber, supportEmail }, source) {
  return {
    whatsappNumber,
    whatsappDisplay: formatWhatsAppDisplay(whatsappNumber),
    whatsappUrl: `https://wa.me/${whatsappNumber}`,
    email: supportEmail,
    source,
  };
}

/** Env/built-in contact (no DB). */
function baseContact() {
  const envNumber = cleanNumber(process.env.SUPPORT_WHATSAPP_NUMBER);
  const envEmail = cleanEmail(process.env.SUPPORT_EMAIL);
  return toContact({
    whatsappNumber: envNumber || DEFAULTS.whatsappNumber,
    supportEmail: envEmail || DEFAULTS.supportEmail,
  }, envNumber || envEmail ? 'env' : 'default');
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('support_contact_timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function readRow() {
  const SupportSettings = require('../models/SupportSettings'); // lazy: no DB side effects at require time
  return SupportSettings.findOne({});
}

/** Effective contact; never throws. */
async function getSupportContact({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.contact;
  const base = baseContact();
  let contact = base;
  try {
    const row = await withTimeout(readRow(), DB_READ_TIMEOUT_MS);
    if (row) {
      const n = cleanNumber(row.whatsappNumber);
      const e = cleanEmail(row.supportEmail);
      if (n || e) {
        contact = toContact({
          whatsappNumber: n || base.whatsappNumber,
          supportEmail: e || base.email,
        }, 'admin');
      }
    }
  } catch (err) {
    console.warn('[support-contact] using fallback:', err.message);
    if (cache) return cache.contact; // keep the last known-good admin value
  }
  cache = { contact, at: Date.now() };
  return contact;
}

/** Synchronous best-known contact (last cached value, else env/built-in); never blocks. */
function getSupportContactSync() {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) getSupportContact().catch(() => {}); // refresh in background
  return cache ? cache.contact : baseContact();
}

/** Validate a patch → { value } or { error }. Both fields optional; '' clears to fallback. */
function validatePatch(patch = {}) {
  const out = {};
  if (patch.whatsappNumber !== undefined) {
    const raw = String(patch.whatsappNumber || '').trim();
    const n = raw ? cleanNumber(raw) : '';
    if (raw && !n) return { error: 'Enter a valid WhatsApp number with country code, e.g. +92 335 5500134.' };
    out.whatsappNumber = n;
  }
  if (patch.supportEmail !== undefined) {
    const raw = String(patch.supportEmail || '').trim();
    const e = raw ? cleanEmail(raw) : '';
    if (raw && !e) return { error: 'Enter a valid support email address.' };
    out.supportEmail = e;
  }
  return { value: out };
}

/** Admin update. Throws { status: 400 } on invalid input. Returns the new effective contact. */
async function updateSupportContact(patch, actorId) {
  const { value, error } = validatePatch(patch);
  if (error) { const err = new Error(error); err.status = 400; throw err; }
  const SupportSettings = require('../models/SupportSettings');
  const row = await SupportSettings.findOne({});
  if (!row) {
    await SupportSettings.create({
      whatsappNumber: value.whatsappNumber || '',
      supportEmail: value.supportEmail || '',
      ...(actorId ? { updatedBy: actorId } : {}),
    });
  } else {
    if (value.whatsappNumber !== undefined) row.whatsappNumber = value.whatsappNumber;
    if (value.supportEmail !== undefined) row.supportEmail = value.supportEmail;
    if (actorId) row.updatedBy = actorId;
    await row.save();
  }
  cache = null;
  return getSupportContact({ fresh: true });
}

/** Raw admin-stored values (for the admin form), plus the effective contact. */
async function getAdminView() {
  const contact = await getSupportContact({ fresh: true });
  let stored = { whatsappNumber: '', supportEmail: '', updatedAt: null };
  try {
    const row = await withTimeout(readRow(), DB_READ_TIMEOUT_MS);
    if (row) stored = { whatsappNumber: row.whatsappNumber || '', supportEmail: row.supportEmail || '', updatedAt: row.updatedAt || null };
  } catch (_) { /* contact already reflects the fallback */ }
  return { contact, stored, fallback: baseContact() };
}

function _resetCacheForTests() { cache = null; }

module.exports = {
  DEFAULTS,
  CACHE_TTL_MS,
  formatWhatsAppDisplay,
  getSupportContact,
  getSupportContactSync,
  updateSupportContact,
  validatePatch,
  getAdminView,
  _resetCacheForTests,
};

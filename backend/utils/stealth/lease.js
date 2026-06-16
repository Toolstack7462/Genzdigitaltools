'use strict';
/**
 * Lease token signing / verification for the StealthWriter gateway.
 *
 * The lease is a short-lived JWT. We use a dedicated secret (STEALTH_LEASE_SECRET)
 * so a leak of this secret can never mint core auth tokens. If the dedicated
 * secret is not configured we derive a strong, isolated key from JWT_SECRET via
 * HMAC — this keeps startup working without weakening the core JWT secret.
 *
 * Payload (no secrets): { jti, sub:userId, scid:stealthClientId, type:'stealth_lease', fixed }
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const LEASE_TYPE = 'stealth_lease';

function leaseSecret() {
  const dedicated = process.env.STEALTH_LEASE_SECRET;
  if (dedicated && dedicated.length >= 32) return dedicated;
  // Derive an isolated key from the core secret — never reuse JWT_SECRET directly.
  const base = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', base).update('stealthwriter:lease:v1').digest('hex');
}

/** Sign a lease. ttlMinutes controls expiry; jti must match the DB lease row id.
 *  accountId binds the lease to a vault account; the gateway uses it to load the
 *  correct encrypted session server-side (never exposed to the browser). */
function signLease({ jti, userId, stealthClientId, accountId, fixed, ttlMinutes }) {
  const expiresIn = `${Math.max(1, Math.trunc(ttlMinutes))}m`;
  const payload = { jti, sub: String(userId), scid: String(stealthClientId), type: LEASE_TYPE, fixed: !!fixed };
  if (accountId) payload.acid = String(accountId);
  return jwt.sign(payload, leaseSecret(), { expiresIn });
}

/** Verify a lease token. Returns the decoded payload or null. */
function verifyLease(token) {
  try {
    const decoded = jwt.verify(token, leaseSecret());
    if (decoded.type !== LEASE_TYPE || !decoded.jti) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Build the gateway open URL for a freshly signed lease. */
function gatewayUrl(token) {
  const base = process.env.STEALTH_GATEWAY_URL || 'https://stealth1.genzdigitalstore.com/gateway';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}lease=${encodeURIComponent(token)}`;
}

module.exports = { LEASE_TYPE, signLease, verifyLease, hashToken, gatewayUrl, leaseSecret };

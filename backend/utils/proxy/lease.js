'use strict';
/**
 * Lease token signing / verification for the Proxy-Tools gateways (HIX / BypassGPT).
 *
 * The lease is a short-lived JWT (30 min). It uses a DEDICATED secret
 * (PROXY_LEASE_SECRET) so a leak can never mint core auth tokens. If the dedicated
 * secret is missing, an isolated key is derived from JWT_SECRET via HMAC under a
 * distinct namespace (separate from StealthWriter's lease key).
 *
 * Payload (no secrets): { jti, sub:userId, tool, acid:accountId?, type:'proxy_lease', cap? }
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const tools = require('./tools');

const LEASE_TYPE = 'proxy_lease';

let _warnedFallback = false;
function leaseSecret() {
  const dedicated = process.env.PROXY_LEASE_SECRET;
  if (dedicated && dedicated.length >= 32) return dedicated;
  // Fallback: derive an isolated key from JWT_SECRET. This keeps the gateway
  // working, but it means a JWT_SECRET leak also exposes the lease key. Warn ONCE
  // at boot so the operator sets a dedicated PROXY_LEASE_SECRET (>=32 chars).
  // NOTE: we intentionally keep deriving the SAME value rather than failing hard —
  // changing the secret would invalidate every live lease and drop active tool
  // sessions. Rotate by setting PROXY_LEASE_SECRET during a maintenance window.
  if (!_warnedFallback) {
    _warnedFallback = true;
    console.warn('[SECURITY] PROXY_LEASE_SECRET is not set (or <32 chars); using a key derived from JWT_SECRET. Set a dedicated PROXY_LEASE_SECRET so a JWT_SECRET leak cannot forge proxy leases.');
  }
  const base = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', base).update('proxytools:lease:v1').digest('hex');
}

function signLease({ jti, userId, tool, accountId, ttlMinutes, capture }) {
  const expiresIn = `${Math.max(1, Math.trunc(ttlMinutes || 30))}m`;
  const payload = { jti, sub: String(userId), tool: String(tool), type: LEASE_TYPE };
  if (accountId) payload.acid = String(accountId);
  if (capture) payload.cap = true; // admin "capture cookies through proxy" lease
  return jwt.sign(payload, leaseSecret(), { expiresIn });
}

function verifyLease(token) {
  try {
    const decoded = jwt.verify(token, leaseSecret());
    if (decoded.type !== LEASE_TYPE || !decoded.jti || !decoded.tool) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function gatewayUrl(tool, token) {
  return tools.gatewayOpenUrl(tool, token);
}

module.exports = { LEASE_TYPE, signLease, verifyLease, hashToken, gatewayUrl, leaseSecret };

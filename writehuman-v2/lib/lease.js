'use strict';
/**
 * WriteHuman V2 — lease token signing / verification.
 *
 * Dependency-free HS256 JWT (no `jsonwebtoken`), signed with the V2 lease secret
 * (config.leaseSecret). The payload shape matches what the cloned gateway's local verifier
 * (gateway/proxy.js → verifyLeaseLocal) expects, so a V2-minted lease verifies both
 * in-process (here) and inside the gateway:
 *   { jti, sub, tool:'writehuman', type:'proxy_lease', acid?, cap?, iat, exp }
 *
 * Uses a DEDICATED secret so a leak can never mint core auth tokens, and is distinct from
 * the production proxy lease secret (a V2 lease is never valid in production and vice versa).
 */
const crypto = require('crypto');
const { config } = require('./config');

const LEASE_TYPE = 'proxy_lease';
const TOOL = 'writehuman';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj), 'utf8')); }
function sign(data) {
  return crypto.createHmac('sha256', config.effectiveLeaseSecret).update(data).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function newJti() { return crypto.randomBytes(16).toString('hex'); }

function signLease({ jti, userId, accountId, ttlMinutes, capture }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Math.trunc((ttlMinutes || config.leaseMinutes) * 60));
  const payload = { jti: jti || newJti(), sub: String(userId || 'wh-v2'), tool: TOOL, type: LEASE_TYPE, iat: now, exp };
  if (accountId) payload.acid = String(accountId);
  if (capture) payload.cap = true;
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = sign(`${head}.${body}`);
  return { token: `${head}.${body}.${sig}`, payload };
}

function verifyLease(token) {
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const expected = sign(`${h}.${p}`);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.type !== LEASE_TYPE || !payload.jti) return null;
    if (payload.tool && payload.tool !== TOOL) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}

module.exports = { LEASE_TYPE, TOOL, signLease, verifyLease, newJti };

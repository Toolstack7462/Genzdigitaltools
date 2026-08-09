'use strict';

const crypto = require('crypto');
const COOKIE = process.env.NODE_ENV === 'production' ? '__Secure-gds_biz_csrf' : 'gds_biz_csrf';
const HEADER = 'x-business-csrf-token';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/api/crm/admin/business',
    maxAge: 8 * 60 * 60 * 1000,
  };
}
function issue(req, res) {
  const existing = String(req.cookies?.[COOKIE] || '');
  if (/^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  res.cookie(COOKIE, token, cookieOptions());
  return token;
}
function equal(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
function requireToken(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookie = req.cookies?.[COOKIE];
  const header = req.get(HEADER);
  if (!equal(cookie, header)) {
    return res.status(403).json({ error: 'Invalid Business CRM request token', code: 'BUSINESS_CSRF_INVALID' });
  }
  return next();
}
module.exports = { COOKIE, HEADER, issue, requireToken, cookieOptions };

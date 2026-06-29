'use strict';
/**
 * WriteHuman V2 — cookie manager (auth-cookie identity + change detection).
 *
 * Monitors ONLY the authentication cookies (per spec): the Supabase auth-token cookie
 * `sb-<ref>-auth-token` (and its `.0`/`.1` chunks) plus `sb-session-token`. Analytics /
 * tracking cookies are ignored for hashing and replacement.
 *
 * Step-1 ships the full interface (cookieHash + replaceAuthCookies); it is exercised by
 * the test harness. Step-2 wires it to the live ingest source (the CDP sync agent) so a
 * changed hash triggers a replace-not-merge + auto-verify.
 */
const crypto = require('crypto');
const { config } = require('../lib/config');

const STATIC_AUTH_NAMES = ['sb-session-token'];
function authTokenBase() { return 'sb-' + config.supabase.projectRef + '-auth-token'; }

function isAuthCookieName(name) {
  if (!name) return false;
  const base = authTokenBase();
  return name === base || name.startsWith(base + '.') || STATIC_AUTH_NAMES.includes(name);
}

function authCookies(bundle) {
  const arr = (bundle && Array.isArray(bundle.cookies)) ? bundle.cookies : [];
  return arr.filter(c => c && isAuthCookieName(c.name));
}

// Stable, order-independent hash of ONLY the authentication cookies (name+value). One-way
// digest — never logs or exposes a value. Returns null when no auth cookie is present.
function cookieHash(bundle) {
  const auth = authCookies(bundle).map(c => `${c.name}=${c.value == null ? '' : c.value}`).sort();
  if (!auth.length) return null;
  return crypto.createHash('sha256').update(auth.join('\n')).digest('hex');
}

// Replace (NOT merge) the auth cookies: drop ALL existing auth cookies, keep every other
// cookie byte-for-byte, then append the incoming auth cookies. Returns a NEW bundle and
// never mutates the input.
function replaceAuthCookies(bundle, incomingAuthCookies) {
  const base = (bundle && Array.isArray(bundle.cookies)) ? bundle.cookies : [];
  const kept = base.filter(c => !(c && isAuthCookieName(c.name)));
  const incoming = (incomingAuthCookies || []).filter(c => c && isAuthCookieName(c.name));
  return Object.assign({}, bundle || {}, { cookies: kept.concat(incoming) });
}

module.exports = { isAuthCookieName, authCookies, cookieHash, replaceAuthCookies, authTokenBase };

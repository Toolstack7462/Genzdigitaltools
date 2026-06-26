'use strict';
/**
 * Cookie-bundle parsing + Cookie-header building for the Proxy-Tools vaults.
 * Isolated copy of the StealthWriter cookie logic, generalized so it is not tied to
 * a single tool's session-cookie name. Never logs cookie names/values.
 *
 * Canonical bundle: { cookies: [{ name, value, domain?, path? }], localStorage?, sessionStorage?, origin? }
 * Accepts: JSON object, JSON cookie array, pairs array, flat map, or a raw
 * "name=value; ..." header string.
 */

function parseCookieString(s) {
  return String(s).split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    if (i < 0) return null;
    // Preserve the value EXACTLY — no decode/re-encode (keeps %2B/%2F/%3D/dots intact).
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1) };
  }).filter(c => c && c.name);
}

// True when the bundle carries a usable session/auth cookie (generic detection).
function hasSessionCookie(bundle) {
  const arr = (bundle && Array.isArray(bundle.cookies)) ? bundle.cookies : [];
  return arr.some(c => c && c.name && /session|auth|token|sid|sess|jwt|login/i.test(c.name) && c.value != null && String(c.value).length > 0);
}

function normCookieArray(arr) {
  return arr.map(c => {
    if (Array.isArray(c) && c.length >= 2) return { name: String(c[0]), value: String(c[1]) };
    if (c && typeof c === 'object') {
      const name = c.name != null ? c.name : (c.Name != null ? c.Name : c.key);
      if (name == null) return null;
      const value = c.value != null ? c.value : (c.Value != null ? c.Value : '');
      const out = { name: String(name), value: String(value) };
      const domain = c.domain || c.Domain;
      const path = c.path || c.Path;
      if (domain) out.domain = String(domain);
      if (path) out.path = String(path);
      return out;
    }
    return null;
  }).filter(c => c && c.name);
}

function normalizeCookieBundle(input) {
  let v = input;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { v = JSON.parse(s); } catch (_) { return { cookies: parseCookieString(s) }; }
  }
  if (Array.isArray(v)) return { cookies: normCookieArray(v) };
  if (v && typeof v === 'object') {
    const out = {};
    if (v.localStorage && typeof v.localStorage === 'object') out.localStorage = v.localStorage;
    if (v.sessionStorage && typeof v.sessionStorage === 'object') out.sessionStorage = v.sessionStorage;
    if (v.origin) out.origin = String(v.origin);
    if (Array.isArray(v.cookies)) { out.cookies = normCookieArray(v.cookies); return out; }
    if (typeof v.cookies === 'string') { out.cookies = parseCookieString(v.cookies); return out; }
    if ('cookies' in v || 'localStorage' in v || 'sessionStorage' in v || 'origin' in v) {
      out.cookies = []; return out;
    }
    const entries = Object.entries(v).filter(([, val]) => typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean');
    if (entries.length) return { cookies: entries.map(([k, val]) => ({ name: String(k), value: String(val) })) };
  }
  return null;
}

function hostMatchesCookieDomain(cookieDomain, host) {
  if (!cookieDomain) return true; // host-only cookie — include
  const d = String(cookieDomain).replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  return h === d || h.endsWith('.' + d) || d.endsWith('.' + h);
}

/** Build "name=value; name2=value2" for the upstream target host. Last value wins. */
function buildCookieHeader(bundle, targetHost) {
  const cookies = (bundle && Array.isArray(bundle.cookies)) ? bundle.cookies : [];
  const map = new Map();
  for (const c of cookies) {
    if (!c || !c.name) continue;
    if (c.domain && !hostMatchesCookieDomain(c.domain, targetHost)) continue;
    map.set(c.name, c.value == null ? '' : c.value);
  }
  return [...map.entries()].map(([n, val]) => `${n}=${val}`).join('; ');
}

function countCookies(bundle, targetHost) {
  const h = buildCookieHeader(bundle, targetHost);
  return h ? h.split('; ').filter(Boolean).length : 0;
}

// SAFE diagnostic: the NAMES (never values) of the cookies that would attach to the tool
// host. Lets an admin see whether the required session cookie is present without ever
// exposing a cookie value/secret. Capped + de-duped.
function cookieNames(bundle, targetHost) {
  const cookies = (bundle && Array.isArray(bundle.cookies)) ? bundle.cookies : [];
  const seen = new Set();
  for (const c of cookies) {
    if (!c || !c.name) continue;
    if (c.domain && !hostMatchesCookieDomain(c.domain, targetHost)) continue;
    seen.add(String(c.name));
  }
  return [...seen].slice(0, 50);
}

module.exports = { normalizeCookieBundle, buildCookieHeader, countCookies, cookieNames, parseCookieString, hostMatchesCookieDomain, hasSessionCookie };

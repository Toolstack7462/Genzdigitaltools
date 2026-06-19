'use strict';
/**
 * Per-tool browser-session cleanup config.
 *
 * Derives, from a Tool's own `domain` / `targetUrl`, the EXACT scope the Chrome
 * extension must wipe when a client's assignment to that tool expires or is
 * revoked:
 *   - tool_code            stable identifier for the tool (its _id)
 *   - domains              hostnames the tool runs on (base + apex)
 *   - cookieDomains        chrome.cookies domain filters (apex + leading-dot)
 *   - localStorageOrigins  https origins whose localStorage/sessionStorage to clear
 *   - tabUrlPatterns       match patterns used to find/redirect open tool tabs
 *
 * Scope is strictly the tool's OWN domain family. It NEVER widens to unrelated
 * tools or personal sites, and it explicitly refuses to emit any rule that would
 * touch the Gen Z dashboard/app/api domains (defence-in-depth — a misconfigured
 * tool domain must never wipe the dashboard session).
 *
 * No secrets are involved; this builds public hostname/pattern metadata only.
 */

// Multi-part public suffixes we must not collapse past (so "co.uk" stays whole).
const MULTI_PART_TLDS = new Set([
  'co.uk', 'com.au', 'co.nz', 'co.in', 'com.br', 'org.uk', 'net.au', 'ac.uk', 'gov.uk',
]);

// Domains the cleanup MUST never target — our own dashboard/app/api/gateways.
// A tool whose domain accidentally resolves into this family yields NO cleanup
// config, so client sessions on our own properties are never wiped.
const PROTECTED_SUFFIXES = ['genzdigitalstore.com'];

function getBaseDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function hostFromTool(tool) {
  if (!tool) return null;
  if (tool.domain) {
    try { return new URL(`https://${String(tool.domain).replace(/^https?:\/\//, '')}`).hostname; }
    catch (_) { return String(tool.domain).toLowerCase(); }
  }
  const url = tool.targetUrl || tool.loginUrl;
  if (url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) {} }
  return null;
}

function isProtected(host, base) {
  return PROTECTED_SUFFIXES.some(s => host === s || host.endsWith('.' + s) || base === s);
}

/**
 * @returns {object|null} cleanup config, or null when no valid/allowed domain.
 */
function buildToolCleanupConfig(tool) {
  const host = hostFromTool(tool);
  if (!host) return null;
  const base = getBaseDomain(host);
  if (!base) return null;
  if (isProtected(host, base)) return null; // never clean our own properties

  // SCOPE IS HOST-CENTRIC ON PURPOSE. We clean only the tool's own host and its
  // subdomains — never the registrable parent. This matters for tools hosted on
  // a subdomain of a shared platform (e.g. a tool on docs.<shared>.com must NOT
  // wipe the user's personal session on <shared>.com). chrome.cookies.getAll
  // ({domain: host}) already matches host + its subdomains and does NOT return
  // parent-domain cookies, so a host-scoped filter is both sufficient and safe.
  // For the dedicated SaaS tools in use (hix.ai, stealthwriter.ai, scispace.com,
  // paperpal.com) the host IS the apex, so subdomains are still fully covered.
  const domains = [host];

  // Both the bare host and the leading-dot form, so host-only and subdomain
  // (.host) cookie shapes are both removed.
  const cookieDomains = [...new Set([host, '.' + host])];

  const localStorageOrigins = [`https://${host}`];

  const tabUrlPatterns = [...new Set([
    `*://${host}/*`,
    `*://*.${host}/*`,
  ])];

  return {
    tool_code: tool && tool._id != null ? String(tool._id) : (host || null),
    name: (tool && tool.name) || host,
    domains,
    cookieDomains,
    localStorageOrigins,
    tabUrlPatterns,
  };
}

module.exports = { buildToolCleanupConfig, getBaseDomain };

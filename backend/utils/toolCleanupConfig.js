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

// ── Curated allowlist of known EXTENSION-tool registrable domains ────────────
// For these dedicated SaaS tools it is SAFE and DESIRED to broaden cleanup to the
// whole domain family (apex + every subdomain), because the entire registrable
// domain belongs to that one tool. This is what lets a tool configured as a
// subdomain (e.g. app.jenni.ai) still clear apex/SSO cookies on .jenni.ai.
//
// A domain is added here ONLY when the whole registrable domain is owned by a
// single tool — never a shared platform (so we never wipe a user's personal
// session on a multi-tenant host). Unknown tools fall back to the strict
// host-centric scope below.
const KNOWN_EXTENSION_TOOL_BASES = new Set([
  'hix.ai',
  'paperpal.com',
  'scispace.com',
  'jenni.ai',
  'chatgpt.com',
  // add other dedicated extension-tool registrable domains here
]);

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

  // Two scoping modes:
  //  • KNOWN extension tool (registrable domain on the curated allowlist): clean
  //    the WHOLE domain family (apex + all subdomains). This is how a tool
  //    configured as app.jenni.ai still clears apex .jenni.ai SSO cookies, and
  //    matches the required hix.ai/*.hix.ai, paperpal.com/*.paperpal.com,
  //    scispace.com/*.scispace.com, jenni.ai/app.jenni.ai patterns.
  //  • UNKNOWN tool: strict HOST-CENTRIC scope — only the tool's own host and its
  //    subdomains, never the registrable parent. This protects a tool hosted on a
  //    shared multi-tenant platform (e.g. docs.<shared>.com) from wiping the
  //    user's personal session on <shared>.com. chrome.cookies.getAll({domain:
  //    host}) matches host + subdomains and not the parent, so it's safe.
  const known = KNOWN_EXTENSION_TOOL_BASES.has(base);
  const scope = known ? base : host;

  const domains = [...new Set(known ? [base, host] : [host])];

  // Both bare and leading-dot forms so host-only and subdomain (.scope) cookie
  // shapes are both removed.
  const cookieDomains = [...new Set([scope, '.' + scope, host])];

  const localStorageOrigins = [...new Set([`https://${scope}`, `https://${host}`])];

  const tabUrlPatterns = [...new Set([
    `*://${scope}/*`,
    `*://*.${scope}/*`,
    `*://${host}/*`,
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

// Access mode for a catalog tool, matching routes/admin/assignments.js:
// direct-open only when admin explicitly enabled direct open AND dropped the
// permission requirement; otherwise the tool uses the extension/cookie flow.
// (Proxy/stealth tools are tagged 'proxy' elsewhere and never reach here.)
function getToolAccessMode(tool) {
  const es = tool && tool.extensionSettings;
  if (es && es.directOpenEnabled === true && es.requirePermission === false) return 'direct';
  return 'extension';
}

module.exports = { buildToolCleanupConfig, getBaseDomain, getToolAccessMode };

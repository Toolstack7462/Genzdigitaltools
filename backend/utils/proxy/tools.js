'use strict';
/**
 * Proxy-Tools registry — the SINGLE source of truth for which extra tools are
 * served through their own reverse-proxy gateway (HIX AI, BypassGPT). This module
 * is fully isolated from StealthWriter and from the existing Tool/ToolAssignment
 * system: it only describes the proxy tools and reads their per-tool env config.
 *
 * Each tool keeps its OWN encrypted cookie vault (ProxyAccount rows are tagged with
 * `tool`), its OWN gateway origin and its OWN target origin. No usage metering and
 * no daily limits are applied here.
 */

const TOOLS = {
  hix: {
    key: 'hix',
    name: 'HIX AI',
    category: 'AI',
    tagline: 'AI Humanizer & Detector',
    // Config (env first, sane defaults second).
    targetOriginEnv: 'HIX_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://hix.ai',
    gatewayUrlEnv: 'HIX_GATEWAY_URL',
    defaultGatewayUrl: 'https://hix1.genzdigitalstore.com',
    defaultPathEnv: 'HIX_DEFAULT_PATH',
    defaultPath: '/app/bypass-ai-detection/dashboard',
    // Sign-in path used by the server-side account verifier.
    verifyPathEnv: 'HIX_VERIFY_PATH',
  },
  bypassgpt: {
    key: 'bypassgpt',
    name: 'BypassGPT',
    category: 'AI',
    tagline: 'Undetectable AI Humanizer',
    targetOriginEnv: 'BYPASSGPT_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://www.bypassgpt.ai',
    gatewayUrlEnv: 'BYPASSGPT_GATEWAY_URL',
    defaultGatewayUrl: 'https://bypassgpt1.genzdigitalstore.com',
    defaultPathEnv: 'BYPASSGPT_DEFAULT_PATH',
    defaultPath: '/ai-humanizer',
    verifyPathEnv: 'BYPASSGPT_VERIFY_PATH',
  },
};

const TOOL_KEYS = Object.keys(TOOLS);

function isValidTool(tool) {
  return Object.prototype.hasOwnProperty.call(TOOLS, String(tool || ''));
}

function getTool(tool) {
  return TOOLS[String(tool || '')] || null;
}

function stripSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function targetOrigin(tool) {
  const t = getTool(tool); if (!t) return '';
  return stripSlash(process.env[t.targetOriginEnv] || t.defaultTargetOrigin);
}

function targetHost(tool) {
  try { return new URL(targetOrigin(tool)).hostname; } catch (_) { return ''; }
}

// Public gateway base, e.g. https://hix1.genzdigitalstore.com  (no trailing /gateway).
function gatewayBase(tool) {
  const t = getTool(tool); if (!t) return '';
  return stripSlash(process.env[t.gatewayUrlEnv] || t.defaultGatewayUrl);
}

// Build the open URL: <gatewayBase>/gateway?lease=<token>
function gatewayOpenUrl(tool, token) {
  const base = gatewayBase(tool);
  if (!base) return '';
  return `${base}/gateway?lease=${encodeURIComponent(token)}`;
}

function defaultPath(tool) {
  const t = getTool(tool); if (!t) return '/';
  const p = process.env[t.defaultPathEnv] || t.defaultPath;
  return p.startsWith('/') ? p : '/' + p;
}

function verifyPath(tool) {
  const t = getTool(tool); if (!t) return '/';
  return process.env[t.verifyPathEnv] || defaultPath(tool);
}

// Safe public descriptor for the client UI (never any secret/config).
function publicInfo(tool) {
  const t = getTool(tool); if (!t) return null;
  return { tool: t.key, name: t.name, category: t.category, tagline: t.tagline };
}

module.exports = {
  TOOLS, TOOL_KEYS, isValidTool, getTool,
  targetOrigin, targetHost, gatewayBase, gatewayOpenUrl, defaultPath, verifyPath, publicInfo,
};

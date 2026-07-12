'use strict';
/**
 * Machine-to-machine cookie ingest for the RDP Cookie Sync Agent.
 * Mounted at /api/crm/proxy/agent — writes fresh auth cookies into the EXISTING ProxyAccount
 * vault (the single source of truth) via the shared applyAccountSession path, so the production
 * gateway serves a live, self-healing session with no separate store.
 *
 * Least privilege: the agent key can ONLY push cookies / heartbeat / logout for its tool and
 * read its own queued command — it can never read other accounts, clients, or admin data.
 * Tool-scoped, timing-safe key check, per-IP rate limit, optional IP allowlist. Never logs or
 * returns cookie values/tokens.
 *
 * DORMANT until PROXY_AGENT_SYNC_KEY is set → every route returns 503 (zero effect on deploy).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const ProxyAccount = require('../../models/proxy/ProxyAccount');
const tools = require('../../utils/proxy/tools');
const vaultCrypto = require('../../utils/proxy/vaultCrypto');
const { normalizeCookieBundle, replaceAuthCookies, authCookieHash, hasSessionCookie } = require('../../utils/proxy/cookies');
const { applyAccountSession } = require('../../utils/proxy/applySession');
const { selectAccount } = require('../../utils/proxy/accountSelect');

const AGENT_KEY = process.env.PROXY_AGENT_SYNC_KEY || '';
const ALLOW_IPS = (process.env.PROXY_AGENT_SYNC_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';
const ALLOWED_COMMANDS = ['relaunch-chrome', 'reverify'];

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function timingEq(got, expected) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
// Tiny per-IP sliding window — brute-force guard on the key. Generous: the agent polls every
// few seconds legitimately.
const RL = new Map();
const RL_MAX = Number(process.env.PROXY_AGENT_SYNC_RATE_PER_MIN || 240);
function rateOk(ip) {
  const now = Date.now(); const e = RL.get(ip);
  if (!e || now - e.t > 60000) { RL.set(ip, { t: now, n: 1 }); return true; }
  e.n += 1; return e.n <= RL_MAX;
}
// Non-secret agent telemetry only (counts / ids / status — never cookie values).
function sanitizeReport(r) {
  if (!r || typeof r !== 'object') return undefined;
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  const i = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  return {
    host: s(r.host, 80), version: s(r.version, 40), cdp: s(r.cdp, 12),
    chrome: r.chrome === true || r.chrome === 'true',
    pollCount: i(r.pollCount), authCookies: i(r.authCookies), uptimeSec: i(r.uptimeSec),
    lastError: s(r.lastError, 200), lastErrorAt: s(r.lastErrorAt, 40), errorCount: i(r.errorCount),
    lastCommand: s(r.lastCommand, 40), lastCommandAt: s(r.lastCommandAt, 40),
    receivedAt: new Date(),
  };
}

router.param('tool', (req, res, next, tool) => {
  if (!tools.isValidTool(tool)) return res.status(404).json({ ok: false, code: 'unknown_tool' });
  req.proxyTool = tool; next();
});

router.post('/:tool/cookies', express.json({ limit: '256kb' }), async (req, res) => {
  if (!AGENT_KEY) return res.status(503).json({ ok: false, code: 'agent_sync_not_configured' });
  const ip = clientIp(req);
  if (!rateOk(ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
  if (ALLOW_IPS.length && !ALLOW_IPS.includes(ip)) return res.status(403).json({ ok: false, code: 'ip_not_allowed' });
  if (!timingEq(req.headers['x-agent-key'], AGENT_KEY)) return res.status(403).json({ ok: false, code: 'forbidden' });

  const tool = req.proxyTool;
  const tcfg = tools.getTool(tool);
  const projectRef = tcfg && tcfg.supabase && tcfg.supabase.projectRef;
  const body = req.body || {};
  // The RDP Cookie Sync Agent attaches its telemetry under `agent` on every call.
  const report = sanitizeReport(body.agent);

  // The operator account this agent keeps fresh: the primary, else the selection order.
  const accounts = await ProxyAccount.find({ tool });
  if (!accounts.length) return res.status(404).json({ ok: false, code: 'no_account' });
  const account = accounts.find(a => a.isPrimary) || selectAccount(accounts, SELECTION_MODE) || accounts[0];

  const pending = account.pendingCommand && ALLOWED_COMMANDS.includes(account.pendingCommand) ? account.pendingCommand : null;
  const touchLiveness = () => {
    if (report !== undefined) account.agentReport = report;
    account.lastSyncedAt = new Date();
    account.syncCount = (account.syncCount || 0) + 1;
  };

  // Heartbeat (no cookies): liveness + telemetry only.
  if (body.heartbeat === true && body.cookies == null) {
    touchLiveness(); if (pending) account.pendingCommand = null; await account.save();
    return res.json({ ok: true, heartbeat: true, changed: false, command: pending });
  }

  // Explicit logout signal (agent debounces a vanished auth cookie → real logout).
  if (body.loggedOut === true) {
    account.status = 'session_expired'; account.session_status = 'needs_login';
    account.verification = { result: 'session_expired', maskedId: account.verification?.maskedId || null, httpStatus: 0, checkedAt: new Date() };
    touchLiveness(); if (pending) account.pendingCommand = null; await account.save();
    return res.json({ ok: true, loggedOut: true, changed: true, command: pending });
  }

  // Cookie push.
  const incoming = normalizeCookieBundle(body.cookies);
  if (!incoming || !Array.isArray(incoming.cookies) || !incoming.cookies.length) {
    return res.status(400).json({ ok: false, code: 'no_cookies' });
  }
  // Replace-not-merge the auth cookies on the existing stored bundle (keep any non-auth cookies).
  let stored = null;
  try { if (account.sessionEncrypted) stored = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)); } catch (_) { stored = null; }
  const merged = replaceAuthCookies(stored || { cookies: [] }, incoming.cookies, projectRef);
  // Safety: NEVER wipe the vault — the merged bundle must still carry an auth/session cookie.
  if (!hasSessionCookie(merged)) return res.status(400).json({ ok: false, code: 'no_auth_cookie' });

  const newHash = authCookieHash(merged, projectRef);
  touchLiveness();

  // Unchanged auth cookies → cheap liveness update only (no re-encrypt / no verify) UNLESS the
  // agent asked to force it (dashboard "Re-sync" / reverify command) — then we re-apply + re-verify
  // the current cookies even though the hash matches (otherwise Re-sync would be a silent no-op).
  const unchanged = !!(account.cookieHash && newHash && account.cookieHash === newHash);
  if (unchanged && body.force !== true) {
    if (pending) account.pendingCommand = null; await account.save();
    return res.json({ ok: true, changed: false, command: pending });
  }

  // Changed (or forced) → the shared write path (encrypt + revoke in-flight leases + auto-verify).
  const r = await applyAccountSession(account, merged, { tool, source: 'agent', actorType: 'AGENT', actorId: 'cookie-sync-agent', ip });
  account.cookieHash = newHash;
  if (report !== undefined) account.agentReport = report;
  if (pending) account.pendingCommand = null;
  await account.save();
  return res.json({ ok: true, changed: !unchanged, forced: body.force === true, result: r.verifyResult, command: pending });
});

module.exports = router;

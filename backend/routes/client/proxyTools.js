'use strict';
/**
 * Client routes for the Proxy-Tools module (HIX AI / BypassGPT).
 * Mounted at /api/crm/client/proxy-tools.
 *
 *  GET  /            → the proxy tools assigned to this client (status/expiry only;
 *                      shown as normal assigned-tool cards on Dashboard / My Tools).
 *  POST /:tool/open  → validate access, pick an account, mint a 30-min lease, return
 *                      the gateway open URL. No usage metering.
 */
const express = require('express');
const router = express.Router();

const ProxyClient = require('../../models/proxy/ProxyClient');
const ProxyLease = require('../../models/proxy/ProxyLease');
const ProxyAccount = require('../../models/proxy/ProxyAccount');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole, getClientIp } = require('../../middleware/authEnhanced');
const accountSelect = require('../../utils/proxy/accountSelect');
const leaseUtil = require('../../utils/proxy/lease');
const tools = require('../../utils/proxy/tools');
const { recordPresence } = require('../../utils/presence');

const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';

// The access-lease length (= the in-app countdown) is customizable. Precedence:
//   per-client (ProxyClient.leaseMinutes) → per-tool env → global PROXY_LEASE_MINUTES → 30.
function resolveLeaseMinutes(pc) {
  const clamped = tools.clampMinutes(pc && pc.leaseMinutes);
  return clamped || tools.defaultLeaseMinutes(pc ? pc.tool : null);
}

router.use(requireAuth);
router.use(requireRole('CLIENT'));

function presentAssigned(pc) {
  const info = tools.publicInfo(pc.tool) || { tool: pc.tool, name: pc.tool, category: 'AI', tagline: '' };
  return {
    tool: pc.tool,
    name: info.name,
    category: info.category,
    tagline: pc.planName || info.tagline,
    planName: pc.planName || info.name,
    status: pc.status,
    active: pc.isActive(),
    expired: pc.isExpired(),
    expiryDate: pc.expiryDate || null,
    leaseMinutes: resolveLeaseMinutes(pc), // drives the "Secure N-minute session" card label
  };
}

// ─── List assigned proxy tools ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await ProxyClient.find({ userId: req.userId });
    const items = (rows || []).filter(r => tools.isValidTool(r.tool)).map(presentAssigned);
    return res.json({ success: true, tools: items });
  } catch (err) {
    console.error('Proxy client list error:', err.message);
    return res.status(500).json({ error: 'Failed to load tools' });
  }
});

// ─── Open a proxy tool (mint a lease) ────────────────────────────────────────
router.post('/:tool/open', async (req, res) => {
  try {
    const tool = String(req.params.tool || '');
    if (!tools.isValidTool(tool)) return res.status(404).json({ error: 'Unknown tool', code: 'unknown_tool' });

    const client = await ProxyClient.findOne({ userId: req.userId, tool });
    if (!client) return res.status(404).json({ error: `No ${tool} access assigned`, code: 'no_plan' });
    if (!client.isActive()) {
      const code = client.isExpired() ? 'plan_expired' : 'client_disabled';
      return res.status(403).json({ error: client.isExpired() ? 'Your access has expired' : 'Your access is disabled', code });
    }

    // ── Account Vault selection (per tool) ─────────────────────────────────
    const accounts = await ProxyAccount.find({ tool });
    const account = accounts.length > 0 ? accountSelect.selectAccount(accounts, SELECTION_MODE) : null;
    if (!account) {
      // No usable vault session (none saved, or all expired/blocked/limit-reached). NEVER
      // open a cookie-less proxy session — for these logged-in tools that would just show
      // the platform's PUBLIC login / sign-up page to the client. Return a friendly
      // "session expired / being set up" status instead; admin sees the per-account
      // reasons (e.g. session_expired) and can refresh the session through the vault.
      const reasons = accounts.map(a => ({ account_id: a._id, account_label: a.label, reason: accountSelect.unavailableReason(a) }));
      const anyExpired = accounts.some(a => accountSelect.unavailableReason(a) === 'session_expired');
      await ActivityLog.log('CLIENT', req.userId, 'PROXY_NO_ACCOUNT_AVAILABLE', { tool, accountsTotal: accounts.length, reasons, ip: getClientIp(req) });
      const toolName = (tools.publicInfo(tool) || {}).name || tool;
      return res.status(503).json({
        error: anyExpired
          ? `${toolName} needs to sign in again and is being refreshed. Please try again shortly or contact support.`
          : `${toolName} is being set up and isn't available yet. Please try again shortly or contact support.`,
        code: anyExpired ? 'session_expired' : 'no_account_available',
      });
    }

    const leaseMinutes = resolveLeaseMinutes(client);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + leaseMinutes * 60 * 1000);

    const leaseRow = await ProxyLease.create({
      tool,
      userId: req.userId,
      proxyClientId: client._id,
      accountId: account ? account._id : null,
      accountLabel: account ? account.label : null, // label only — no secrets
      issuedAt, expiresAt,
      revoked: false,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
    });

    if (account) {
      account.usageCount = Number(account.usageCount || 0) + 1;
      account.lastUsedAt = issuedAt;
      await account.save();
    }

    const token = leaseUtil.signLease({
      jti: leaseRow._id,
      userId: req.userId,
      tool,
      accountId: account ? account._id : undefined,
      ttlMinutes: leaseMinutes,
    });
    leaseRow.tokenHash = leaseUtil.hashToken(token);
    await leaseRow.save();

    await ActivityLog.log('CLIENT', req.userId, 'PROXY_LEASE_ISSUED', {
      tool, proxyClientId: client._id, leaseId: leaseRow._id, ttlMinutes: leaseMinutes,
      accountId: account ? account._id : null, accountLabel: account ? account.label : null,
      ip: getClientIp(req),
    });

    // Live presence for the admin activity monitor (fire-and-forget, fail-safe).
    const toolInfo = tools.publicInfo(tool);
    recordPresence({
      clientId: req.userId,
      clientName: req.user && req.user.fullName,
      clientEmail: req.user && req.user.email,
      event: 'tool_launched',
      toolName: (toolInfo && toolInfo.name) || tool,
      ip: getClientIp(req),
    });

    return res.json({
      success: true,
      url: leaseUtil.gatewayUrl(tool, token),
      lease: { id: leaseRow._id, expiresAt, durationMinutes: leaseMinutes },
    });
  } catch (err) {
    console.error('Proxy open error:', err.message);
    return res.status(500).json({ error: 'Failed to open tool' });
  }
});

module.exports = router;

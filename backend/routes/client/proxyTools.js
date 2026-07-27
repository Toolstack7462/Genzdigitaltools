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
const claudeQuota = require('../../utils/proxy/claudeQuota');
const claudeUsage = require('../../utils/proxy/claudeUsage');
const claudeSettings = require('../../utils/proxy/claudeSettings');
const { recordPresence } = require('../../utils/presence');
const launchCode = require('../../utils/launchCode');
const launchStore = require('../../utils/launchStore');
const { requireCsrf } = require('../../middleware/csrf');

const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';

// The access-lease length (= the in-app countdown) is customizable. Precedence:
//   per-client (ProxyClient.leaseMinutes) → per-tool env → global PROXY_LEASE_MINUTES → 30.
function resolveLeaseMinutes(pc) {
  const clamped = tools.clampMinutes(pc && pc.leaseMinutes);
  return clamped || tools.defaultLeaseMinutes(pc ? pc.tool : null);
}

router.use(requireAuth);
router.use(requireRole('CLIENT'));

async function presentAssigned(pc) {
  const info = tools.publicInfo(pc.tool) || { tool: pc.tool, name: pc.tool, category: 'AI', tagline: '' };

  // Safe name of the backend account that will serve this tool (e.g. "Account 1").
  // Runs the SAME selection the open route uses, but exposes ONLY the operator's
  // chosen label — never the email, cookies, tokens or session ids. Fail-safe:
  // any error just omits the label. Display-only; does not affect selection.
  let accountLabel = null;
  let account = null;
  try {
    const accounts = await ProxyAccount.find({ tool: pc.tool });
    // Claude honours a pinned account; every other tool uses automatic selection unchanged.
    if (pc.tool === 'claude') {
      // Show usage for the account the client is ACTUALLY being served/metered against (their
      // active lease) so the card matches the live overlay widget + enforcement; fall back to a
      // fresh selection when there is no active lease. Fail-safe; never changes selection.
      let leaseAcct = null;
      try { const leases = await ProxyLease.find({ proxyClientId: pc._id, revoked: false }); leaseAcct = accountSelect.activeLeaseAccount(leases, accounts); } catch (_) {}
      account = leaseAcct || accountSelect.resolveAccount(accounts, SELECTION_MODE, pc.pinnedAccountId).account;
    } else {
      account = accounts.length ? accountSelect.selectAccount(accounts, SELECTION_MODE) : null;
    }
    if (account) accountLabel = account.label || 'Account';
  } catch (_) { /* non-fatal — card simply omits the account label */ }

  // Claude-only: attach an ESTIMATED local token-usage summary (never any secret) so the
  // client's tool card can show remaining allowance. Fail-safe: omitted on any error.
  let usage = null;
  if (pc.tool === 'claude' && claudeQuota.quotaMode() !== 'off') {
    try {
      const u = await claudeUsage.readUsage(account, pc);
      const decision = claudeUsage.resolveDecision({
        account, client: pc, clientUsed: u.clientUsed, accountUsed: u.accountUsed,
        weeklyClientUsed: u.weeklyClientUsed, weeklyAccountUsed: u.weeklyAccountUsed, estIncoming: 0,
      });
      // Weekly reset time is shown ONLY when the account's official weeklyResetAt is set —
      // otherwise weeklySynced=false → the widget shows "Not synced" (never a fabricated time).
      const weeklySynced = !!u.synced && !!(account && account.weeklyResetAt);
      usage = {
        synced: !!u.synced,
        clientLimit: decision.clientLimit,
        clientUsed: decision.clientUsed,
        clientRemaining: decision.clientRemaining,
        resetInSeconds: claudeQuota.secondsUntilReset(u.keys.fiveWindow),
        // The five-hour reset time is "official" only when the account carries an explicit
        // cycleResetAt; otherwise the countdown is a fallback and the UI must not present it as
        // synced (mirrors the weekly rule + the admin table + the compact widget).
        fiveHourResetOfficial: !!(account && account.cycleResetAt),
        // Weekly figures (labeled "Estimated usage" in the widget).
        weeklyLimit: decision.weeklyClientLimit,
        weeklyUsed: decision.weeklyClientUsed,
        weeklyRemaining: decision.weeklyClientRemaining,
        weeklyResetAt: (account && account.weeklyResetAt) || null,
        weeklyResetInSeconds: claudeQuota.secondsUntilReset(u.keys.weekWindow),
        weeklySynced,
        label: claudeQuota.USAGE_LABEL,
      };
    } catch (_) { usage = null; }
  }

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
    accountLabel,                          // small safe "Using <account>" label on the card
    usage,                                 // claude-only estimated-usage summary (null otherwise)
  };
}

// ─── List assigned proxy tools ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await ProxyClient.find({ userId: req.userId });
    const items = await Promise.all((rows || []).filter(r => tools.isValidTool(r.tool)).map(presentAssigned));
    return res.json({ success: true, tools: items });
  } catch (err) {
    console.error('Proxy client list error:', err.message);
    return res.status(500).json({ error: 'Failed to load tools' });
  }
});

// ─── Open a proxy tool (mint a lease) ────────────────────────────────────────
// CSRF-gated: this route is cookie-authenticated and the auth cookie is SameSite=None in
// production, so without a header only a preflight-free form POST from any site the client
// visits could force a launch (burning leases and shared Claude allowance). See
// middleware/csrf.js — and note LAUNCH_CSRF_ENFORCE=0 disables rejection if a rollback needs it.
router.post('/:tool/open', requireCsrf, async (req, res) => {
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
    // Claude: honour a pinned account (strict — never silently switch a pinned client to a
    // different account, which would break its shared reset grouping). Every other tool keeps
    // the exact automatic selection it had before.
    let account, pinnedStrictUnavailable = false;
    if (tool === 'claude') {
      const r = accountSelect.resolveAccount(accounts, SELECTION_MODE, client.pinnedAccountId);
      account = r.account;
      pinnedStrictUnavailable = r.pinned && !account; // pinned account exists but is unusable
    } else {
      account = accounts.length > 0 ? accountSelect.selectAccount(accounts, SELECTION_MODE) : null;
    }
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
        error: pinnedStrictUnavailable
          ? `Your assigned ${toolName} account needs to sign in again and is being refreshed. Please try again shortly or contact support.`
          : anyExpired
            ? `${toolName} needs to sign in again and is being refreshed. Please try again shortly or contact support.`
            : `${toolName} is being set up and isn't available yet. Please try again shortly or contact support.`,
        code: anyExpired || pinnedStrictUnavailable ? 'session_expired' : 'no_account_available',
      });
    }

    // ── Claude token quota — coarse OPEN gate ──────────────────────────────
    // In 'count'/'enforce' modes, refuse to START a new session when the client (or the shared
    // account) has ZERO estimated allowance left in the current five-hour cycle. This uses only
    // DB-summed integer estimates — no Claude body parsing — so it is safe. Per-message
    // enforcement (mode 'enforce') happens at the gateway. Fail-open on any error.
    if (tool === 'claude' && claudeQuota.quotaMode() !== 'off') {
      try {
        await claudeSettings.ensureLoaded(); // apply admin global defaults before resolving limits
        const u = await claudeUsage.readUsage(account, client);
        // estIncoming=1 → denies only when there is literally no room left (5-hour OR weekly).
        const decision = claudeUsage.resolveDecision({
          account, client, clientUsed: u.clientUsed, accountUsed: u.accountUsed,
          weeklyClientUsed: u.weeklyClientUsed, weeklyAccountUsed: u.weeklyAccountUsed, estIncoming: 1,
        });
        if (!decision.allowed) {
          await ActivityLog.log('CLIENT', req.userId, 'PROXY_CLAUDE_QUOTA_BLOCK_OPEN', {
            tool, proxyClientId: client._id, reason: decision.reason,
            clientUsed: decision.clientUsed, clientLimit: decision.clientLimit,
            accountUsed: decision.accountUsed, accountCapacity: decision.accountCapacity,
            weeklyClientUsed: decision.weeklyClientUsed, weeklyClientLimit: decision.weeklyClientLimit,
            ip: getClientIp(req),
          });
          const weekly = decision.reason === 'weekly_client_limit' || decision.reason === 'weekly_account_capacity';
          const resetIn = claudeQuota.secondsUntilReset(weekly ? u.keys.weekWindow : u.keys.fiveWindow);
          const window = weekly ? 'weekly' : '5-hour';
          const shared = decision.reason === 'account_capacity' || decision.reason === 'weekly_account_capacity';
          // For a weekly window, show hours; for the 5-hour window, minutes.
          const eta = weekly ? `${Math.max(1, Math.round(resetIn / 3600))} hour(s)` : `${Math.max(1, Math.round(resetIn / 60))} minute(s)`;
          return res.status(429).json({
            error: shared
              ? `This Claude account has reached its estimated ${window} capacity. It resets in about ${eta}.`
              : `You have reached your estimated Claude token allowance for the current ${window} cycle. It resets in about ${eta}.`,
            code: 'quota_exceeded',
            usage: Object.assign(claudeQuota.presentDecision(decision), { resetInSeconds: resetIn, window }),
          });
        }
      } catch (_) { /* fail-open: never block a launch on a metering error */ }
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

    // ── Launch carrier ──────────────────────────────────────────────────────
    // POST flow (default for Claude): the lease token is NOT signed here at all. The client
    // receives only a one-time, 30–60s launch code, which it POSTs to the gateway; the
    // gateway redeems it server-to-server and the backend signs the lease at that moment
    // (see routes/proxy/gateway.js /redeem-launch). So the lease JWT never exists in the
    // browser, in a URL, in history or in a log — and an unused code simply expires.
    //
    // URL flow (every other tool, and the rollback path): unchanged from before — sign now
    // and return `/gateway?lease=<JWT>`.
    const usePostFlow = launchCode.postFlowEnabled('proxy', tool);
    let token = null;
    if (!usePostFlow) {
      token = leaseUtil.signLease({
        jti: leaseRow._id,
        userId: req.userId,
        tool,
        accountId: account ? account._id : undefined,
        ttlMinutes: leaseMinutes,
      });
      leaseRow.tokenHash = leaseUtil.hashToken(token);
      await leaseRow.save();
    }

    await ActivityLog.log('CLIENT', req.userId, 'PROXY_LEASE_ISSUED', {
      tool, proxyClientId: client._id, leaseId: leaseRow._id, ttlMinutes: leaseMinutes,
      accountId: account ? account._id : null, accountLabel: account ? account.label : null,
      launchFlow: usePostFlow ? 'post' : 'url', // audit which carrier was used (never the code)
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

    // Neither response may be cached or referred onward: one carries a launch code, the
    // other a lease token.
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');

    if (usePostFlow) {
      const issued = await launchStore.issue({
        module: 'proxy', tool,
        userId: req.userId,
        clientRefId: client._id,
        accountId: account ? account._id : null,
        leaseId: leaseRow._id,
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'] || '',
      });
      return res.json({
        success: true,
        // `code` is returned exactly once, to this authenticated caller, and is dead after
        // one redemption or `expiresInSeconds`, whichever comes first.
        launch: {
          method: 'POST',
          url: tools.gatewayLaunchUrl(tool),
          field: 'code',
          code: issued.code,
          expiresInSeconds: issued.ttlSeconds,
        },
        lease: { id: leaseRow._id, expiresAt, durationMinutes: leaseMinutes },
      });
    }

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

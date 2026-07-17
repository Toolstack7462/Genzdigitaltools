'use strict';
/**
 * Admin routes for the Proxy-Tools module (HIX AI / BypassGPT).
 * Mounted at /api/crm/admin/proxy-tools — isolated from core admin routes and from
 * StealthWriter. Every route is scoped by :tool so each tool keeps its OWN client
 * grants and its OWN encrypted cookie vault.
 *
 * Capabilities: grant/disable client access (status + optional expiry); manage the
 * per-tool Account Vault (add/update cookies, verify, set primary, mark
 * active/standby/limit_reached/session_expired/blocked); view/revoke 30-min leases.
 * Never returns or logs raw cookies/sessions/tokens.
 */
const express = require('express');
const Joi = require('joi');
const router = express.Router();

const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const ProxyClient = require('../../models/proxy/ProxyClient');
const ProxyLease = require('../../models/proxy/ProxyLease');
const ProxyAccount = require('../../models/proxy/ProxyAccount');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate } = require('../../middleware/validation');
const vaultCrypto = require('../../utils/proxy/vaultCrypto');
const tools = require('../../utils/proxy/tools');
const { verifyAccountCookies, maskEmail, applySupabaseRefresh, jwtExp, extractSupabaseSession } = require('../../utils/proxy/verify');
const { normalizeCookieBundle, buildCookieHeader, countCookies, cookieNames, hasSessionCookie } = require('../../utils/proxy/cookies');
const { unavailableReason, selectAccount } = require('../../utils/proxy/accountSelect');
const { applyAccountSession, buildSessionMeta } = require('../../utils/proxy/applySession');
const { verifyAndApply } = require('../../utils/proxy/verifyAndApply');
const proxyVerifyScheduler = require('../../cron/proxyVerifyScheduler');
const healthAlerts = require('../../utils/proxy/healthAlerts');
const claudeQuota = require('../../utils/proxy/claudeQuota');
const claudeUsage = require('../../utils/proxy/claudeUsage');
const { isEmailEnabled } = require('../../utils/email');

// Validate a Claude pinned-account id: '' / null clears the pin; a value must reference an
// existing account of THIS tool (prevents cross-tool / arbitrary-id assignment — IDOR-safe).
// Returns { ok, value } or { ok:false, error }.
async function resolvePinnedAccountId(tool, raw) {
  if (raw === undefined) return { ok: true, value: undefined };   // not being changed
  if (raw === '' || raw === null) return { ok: true, value: null }; // explicit clear
  const acct = await ProxyAccount.findById(String(raw));
  if (!acct || acct.tool !== tool) return { ok: false, error: 'Pinned account not found for this tool' };
  return { ok: true, value: String(acct._id) };
}

// Same selection mode the CLIENT open route uses, so the admin "active account" preview
// reflects exactly which account clients will get (default auto_failover).
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';

router.use(requireAuth);
router.use(requireAdmin);

// Resolve + validate the :tool path segment once for every nested route.
router.param('tool', (req, res, next, tool) => {
  if (!tools.isValidTool(tool)) return res.status(404).json({ error: 'Unknown proxy tool' });
  req.proxyTool = tool;
  next();
});

// ─── Validation schemas (isolated) ──────────────────────────────────────────
const schemas = {
  createClient: Joi.object({
    userId: Joi.string().required(),
    planName: Joi.string().max(120).allow('', null),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled').default('active'),
    notes: Joi.string().max(500).allow('', null),
    // Per-client session length / countdown (minutes). null → use tool/global default.
    leaseMinutes: Joi.number().integer().min(1).max(1440).allow(null),
    // Claude token-quota (claude-only; ignored for other tools): custom per-cycle allowance
    // (null → global default) and a pinned account id (null → automatic selection).
    tokenLimit: Joi.number().integer().min(0).max(100000000).allow(null),
    pinnedAccountId: Joi.string().max(64).allow('', null),
  }),
  alertConfig: Joi.object({
    // Empty string clears the dashboard override (falls back to the env default recipient).
    email: Joi.string().email({ tlds: { allow: false } }).max(160).allow('', null),
    enabled: Joi.boolean(),
  }).min(1),
  updateClient: Joi.object({
    planName: Joi.string().max(120).allow('', null),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled'),
    notes: Joi.string().max(500).allow('', null),
    leaseMinutes: Joi.number().integer().min(1).max(1440).allow(null),
    tokenLimit: Joi.number().integer().min(0).max(100000000).allow(null),
    pinnedAccountId: Joi.string().max(64).allow('', null),
  }).min(1),
  createAccount: Joi.object({
    label: Joi.string().min(1).max(120).required(),
    sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).allow(null),
    expectedIdentifier: Joi.string().max(160).allow('', null),
    status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked').default('active'),
    priority: Joi.number().integer().min(0).max(100000).default(100),
    isPrimary: Joi.boolean().default(false),
    notes: Joi.string().max(500).allow('', null),
    // Claude token-quota (claude-only): manual plan + official reset timestamps.
    plan: Joi.string().valid('pro', 'max5', 'max20', 'unknown'),
    cycleResetAt: Joi.date().iso().allow(null),
    weeklyResetAt: Joi.date().iso().allow(null),
  }),
  updateAccount: Joi.object({
    label: Joi.string().min(1).max(120),
    expectedIdentifier: Joi.string().max(160).allow('', null),
    status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked'),
    priority: Joi.number().integer().min(0).max(100000),
    isPrimary: Joi.boolean(),
    notes: Joi.string().max(500).allow('', null),
    plan: Joi.string().valid('pro', 'max5', 'max20', 'unknown'),
    cycleResetAt: Joi.date().iso().allow(null),
    weeklyResetAt: Joi.date().iso().allow(null),
  }).min(1),
  accountSession: Joi.object({ sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).required() }),
  accountStatus: Joi.object({ status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked').required() }),
};

function safePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// ─── Tool list (for the admin tab switcher) ──────────────────────────────────
router.get('/tools', async (req, res) => {
  return res.json({ success: true, tools: tools.TOOL_KEYS.map(k => tools.publicInfo(k)) });
});

// ─── Claude token-quota configuration (claude-only, read) ─────────────────────
// Surfaces the GLOBAL defaults the admin UI needs: the default per-client allowance, the plan
// multipliers/labels, the safety reserve, the enforcement mode and the derived per-plan
// capacities. All values are estimates; no secret is ever involved.
router.get('/:tool/quota-config', async (req, res) => {
  if (req.proxyTool !== 'claude') return res.json({ success: true, quota: null });
  const plans = claudeQuota.PLANS.filter(p => p !== 'unknown').concat('unknown');
  return res.json({
    success: true,
    quota: {
      mode: claudeQuota.quotaMode(),
      defaultClientLimit: claudeQuota.defaultClientLimit(),
      accountBaseTokens: claudeQuota.accountBaseTokens(),
      safetyReservePct: claudeQuota.safetyReservePct(),
      charsPerToken: claudeQuota.charsPerToken(),
      cycleHours: claudeQuota.CYCLE_MS / 3600000,
      label: claudeQuota.USAGE_LABEL,
      plans: plans.map(p => ({ key: p, label: claudeQuota.planLabel(p), multiplier: claudeQuota.planMultiplier(p), capacity: claudeQuota.accountCapacity(p) })),
      // These global defaults are set via server env (documented) — surfaced read-only here so
      // the operator can SEE the active policy without exposing anything sensitive.
      envKeys: {
        mode: 'CLAUDE_QUOTA_MODE', defaultClientLimit: 'CLAUDE_DEFAULT_CLIENT_TOKENS',
        accountBaseTokens: 'CLAUDE_ACCOUNT_BASE_TOKENS', safetyReservePct: 'CLAUDE_SAFETY_RESERVE_PCT',
        charsPerToken: 'CLAUDE_CHARS_PER_TOKEN',
      },
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLIENT ACCESS GRANTS (per tool)
// ════════════════════════════════════════════════════════════════════════════
async function presentClient(pc) {
  const user = await User.findById(pc.userId).select('fullName email status');
  const now = Date.now();
  const activeLeases = (await ProxyLease.find({ proxyClientId: pc._id, revoked: false }))
    .filter(l => new Date(l.expiresAt).getTime() > now);
  return {
    id: pc._id,
    tool: pc.tool,
    userId: pc.userId,
    user: user ? { id: user._id, fullName: user.fullName, email: user.email, status: user.status } : null,
    planName: pc.planName || '',
    status: pc.status,
    expiryDate: pc.expiryDate || null,
    expired: pc.isExpired(),
    notes: pc.notes || '',
    leaseMinutes: pc.leaseMinutes ?? null,
    effectiveLeaseMinutes: pc.leaseMinutes || tools.defaultLeaseMinutes(pc.tool),
    activeLeaseCount: activeLeases.length,
    // Claude token-quota (claude-only; null on other tools so their card is unchanged).
    tokenLimit: pc.tool === 'claude' ? (pc.tokenLimit ?? null) : null,
    effectiveTokenLimit: pc.tool === 'claude' ? claudeQuota.clientAllowance(pc.tokenLimit) : null,
    pinnedAccountId: pc.tool === 'claude' ? (pc.pinnedAccountId || null) : null,
    createdAt: pc.createdAt,
    updatedAt: pc.updatedAt,
  };
}

router.get('/:tool/stats', async (req, res) => {
  try {
    const clients = await ProxyClient.find({ tool: req.proxyTool });
    const accounts = await ProxyAccount.find({ tool: req.proxyTool });
    const now = Date.now();
    const activeLeases = (await ProxyLease.find({ tool: req.proxyTool, revoked: false })).filter(l => new Date(l.expiresAt).getTime() > now);
    return res.json({
      success: true,
      stats: {
        totalClients: clients.length,
        activeClients: clients.filter(c => c.status === 'active' && !c.isExpired()).length,
        totalAccounts: accounts.length,
        availableAccounts: accounts.filter(a => unavailableReason(a) === null).length,
        activeLeases: activeLeases.length,
      },
    });
  } catch (err) {
    console.error('Proxy stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
});

router.get('/:tool/clients', async (req, res) => {
  try {
    const { page, limit, skip } = safePagination(req.query);
    const all = (await ProxyClient.find({ tool: req.proxyTool })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const pageItems = all.slice(skip, skip + limit);
    let clients = await Promise.all(pageItems.map(presentClient));
    if (req.query.search) {
      const term = String(req.query.search).toLowerCase().slice(0, 100);
      clients = clients.filter(c =>
        (c.user?.email || '').toLowerCase().includes(term) ||
        (c.user?.fullName || '').toLowerCase().includes(term) ||
        (c.planName || '').toLowerCase().includes(term));
    }
    return res.json({
      success: true, clients,
      pagination: { page, limit, totalCount: all.length, totalPages: Math.ceil(all.length / limit), hasMore: skip + pageItems.length < all.length },
    });
  } catch (err) {
    console.error('Proxy list clients error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

router.post('/:tool/clients', validate(schemas.createClient), async (req, res) => {
  try {
    const { userId, planName, expiryDate, status, notes, leaseMinutes, tokenLimit } = req.body;
    const user = await User.findById(userId).select('role');
    if (!user || user.role !== 'CLIENT') return res.status(400).json({ error: 'Target user must be an existing CRM client' });
    const existing = await ProxyClient.findOne({ userId, tool: req.proxyTool });
    if (existing) return res.status(400).json({ error: 'This client already has access to this tool' });

    // Claude-only quota fields (validated pinned account; no-op for other tools).
    const isClaude = req.proxyTool === 'claude';
    const pin = await resolvePinnedAccountId(req.proxyTool, isClaude ? req.body.pinnedAccountId : undefined);
    if (!pin.ok) return res.status(400).json({ error: pin.error });

    const pc = await ProxyClient.create({
      tool: req.proxyTool, userId,
      planName: planName || (tools.publicInfo(req.proxyTool) || {}).name || '',
      expiryDate: expiryDate || null,
      status: status || 'active',
      notes: notes || '',
      leaseMinutes: leaseMinutes ?? null,
      ...(isClaude ? { tokenLimit: tokenLimit ?? null, pinnedAccountId: pin.value ?? null } : {}),
      createdBy: req.userId,
    });
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CLIENT_CREATED', { tool: req.proxyTool, proxyClientId: pc._id, userId, ip: getClientIp(req) });
    return res.status(201).json({ success: true, client: await presentClient(pc) });
  } catch (err) {
    console.error('Proxy create client error:', err.message);
    return res.status(500).json({ error: 'Failed to grant access' });
  }
});

router.put('/:tool/clients/:id', validate(schemas.updateClient), async (req, res) => {
  try {
    const pc = await ProxyClient.findById(req.params.id);
    if (!pc || pc.tool !== req.proxyTool) return res.status(404).json({ error: 'Client grant not found' });
    for (const f of ['planName', 'status', 'notes']) if (req.body[f] !== undefined) pc[f] = req.body[f];
    if (req.body.expiryDate !== undefined) pc.expiryDate = req.body.expiryDate || null;
    if (req.body.leaseMinutes !== undefined) pc.leaseMinutes = req.body.leaseMinutes ?? null;
    // Claude-only quota fields.
    if (req.proxyTool === 'claude') {
      if (req.body.tokenLimit !== undefined) pc.tokenLimit = req.body.tokenLimit ?? null;
      if (req.body.pinnedAccountId !== undefined) {
        const pin = await resolvePinnedAccountId(req.proxyTool, req.body.pinnedAccountId);
        if (!pin.ok) return res.status(400).json({ error: pin.error });
        pc.pinnedAccountId = pin.value ?? null;
      }
    }
    await pc.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CLIENT_UPDATED', { tool: req.proxyTool, proxyClientId: pc._id, changes: req.body, ip: getClientIp(req) });
    return res.json({ success: true, client: await presentClient(pc) });
  } catch (err) {
    console.error('Proxy update client error:', err.message);
    return res.status(500).json({ error: 'Failed to update access' });
  }
});

router.post('/:tool/clients/:id/revoke-leases', async (req, res) => {
  try {
    const pc = await ProxyClient.findById(req.params.id);
    if (!pc || pc.tool !== req.proxyTool) return res.status(404).json({ error: 'Client grant not found' });
    const { modifiedCount } = await ProxyLease.updateMany(
      { proxyClientId: pc._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'admin_revoked', revokedAt: new Date() } }
    );
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CLIENT_LEASES_REVOKED', { tool: req.proxyTool, proxyClientId: pc._id, count: modifiedCount, ip: getClientIp(req) });
    return res.json({ success: true, revoked: modifiedCount });
  } catch (err) {
    console.error('Proxy revoke client leases error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke leases' });
  }
});

// Live estimated token usage for ONE Claude client in the current five-hour cycle. Reads the
// account the client would actually be served (pinned or automatic), sums the shared ledger,
// and returns the full allowance picture. Claude-only; never exposes cookies/identity.
router.get('/:tool/clients/:id/quota', async (req, res) => {
  try {
    if (req.proxyTool !== 'claude') return res.json({ success: true, quota: null });
    const pc = await ProxyClient.findById(req.params.id);
    if (!pc || pc.tool !== req.proxyTool) return res.status(404).json({ error: 'Client grant not found' });
    const accounts = await ProxyAccount.find({ tool: req.proxyTool });
    const account = require('../../utils/proxy/accountSelect').resolveAccount(accounts, SELECTION_MODE, pc.pinnedAccountId).account;
    const u = await claudeUsage.readUsage(account, pc);
    const decision = claudeUsage.resolveDecision({ account, client: pc, clientUsed: u.clientUsed, accountUsed: u.accountUsed, estIncoming: 0 });
    return res.json({
      success: true,
      quota: Object.assign(claudeQuota.presentDecision(decision), {
        accountLabel: account ? account.label : null,       // operator label only — never identity
        pinned: !!pc.pinnedAccountId,
        resetInSeconds: claudeQuota.secondsUntilReset(u.keys.fiveWindow),
        weeklyResetInSeconds: claudeQuota.secondsUntilReset(u.keys.weekWindow),
      }),
    });
  } catch (err) {
    console.error('Proxy client quota error:', err.message);
    return res.status(500).json({ error: 'Failed to load usage' });
  }
});

router.delete('/:tool/clients/:id', async (req, res) => {
  try {
    const pc = await ProxyClient.findById(req.params.id);
    if (!pc || pc.tool !== req.proxyTool) return res.status(404).json({ error: 'Client grant not found' });
    await ProxyLease.deleteMany({ proxyClientId: pc._id });
    await pc.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CLIENT_DELETED', { tool: req.proxyTool, proxyClientId: pc._id, ip: getClientIp(req) });
    return res.json({ success: true, message: 'Access removed' });
  } catch (err) {
    console.error('Proxy delete client error:', err.message);
    return res.status(500).json({ error: 'Failed to remove access' });
  }
});

router.post('/:tool/leases/:leaseId/revoke', async (req, res) => {
  try {
    const lease = await ProxyLease.findById(req.params.leaseId);
    if (!lease || lease.tool !== req.proxyTool) return res.status(404).json({ error: 'Lease not found' });
    if (!lease.revoked) { lease.revoked = true; lease.revokedReason = 'admin_revoked'; lease.revokedAt = new Date(); await lease.save(); }
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_LEASE_REVOKED', { tool: req.proxyTool, leaseId: lease._id, ip: getClientIp(req) });
    return res.json({ success: true });
  } catch (err) {
    console.error('Proxy revoke lease error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke lease' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNT VAULT (per tool) — encrypted at rest, secrets never returned/logged
// ════════════════════════════════════════════════════════════════════════════
function presentAccount(account, activeLeaseCount = 0) {
  return {
    id: account._id,
    tool: account.tool,
    label: account.label,
    status: account.status,
    isPrimary: !!account.isPrimary,
    priority: account.priority,
    usageCount: account.usageCount || 0,
    lastUsedAt: account.lastUsedAt || null,
    notes: account.notes || '',
    hasSession: !!account.sessionEncrypted,
    hasSessionCookie: account.sessionMeta?.hasSessionCookie ?? !!account.sessionEncrypted,
    sessionStatus: account.session_status || 'pending_verification',
    lastVerifiedAt: account.lastVerifiedAt || null,
    sessionMeta: account.sessionMeta || { cookieCount: 0, hasSessionCookie: false, hasLocalStorage: false, origin: '', updatedAt: null },
    verification: account.verification || null,
    maskedIdentifier: account.verification?.maskedId || (account.expectedIdentifier ? maskEmail(account.expectedIdentifier) : null),
    hasExpectedIdentifier: !!account.expectedIdentifier,
    available: unavailableReason(account) === null,
    unavailableReason: unavailableReason(account),
    activeLeaseCount,
    // Claude token-quota (claude-only): manual plan, advisory detected plan, official reset
    // timestamps and the computed shared per-cycle capacity (estimated). Null on other tools.
    plan: account.tool === 'claude' ? claudeQuota.normalizePlan(account.plan) : null,
    planLabel: account.tool === 'claude' ? claudeQuota.planLabel(account.plan) : null,
    planDetected: account.tool === 'claude' ? (account.planDetected || null) : null,
    cycleResetAt: account.tool === 'claude' ? (account.cycleResetAt || null) : null,
    weeklyResetAt: account.tool === 'claude' ? (account.weeklyResetAt || null) : null,
    estimatedCapacity: account.tool === 'claude' ? claudeQuota.accountCapacity(account.plan) : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function activeLeaseCountsByAccount(tool) {
  const now = Date.now();
  const leases = await ProxyLease.find({ tool, revoked: false });
  const map = {};
  for (const l of leases) {
    if (l.accountId && new Date(l.expiresAt).getTime() > now) {
      const k = String(l.accountId);
      map[k] = (map[k] || 0) + 1;
    }
  }
  return map;
}

async function clearOtherPrimaries(tool, exceptId) {
  await ProxyAccount.updateMany({ tool, isPrimary: true, _id: { $ne: exceptId } }, { $set: { isPrimary: false } });
}

router.get('/:tool/accounts', async (req, res) => {
  try {
    const accounts = (await ProxyAccount.find({ tool: req.proxyTool }))
      .sort((a, b) => (a.priority - b.priority) || (new Date(a.createdAt) - new Date(b.createdAt)));
    const counts = await activeLeaseCountsByAccount(req.proxyTool);
    return res.json({ success: true, accounts: accounts.map(a => presentAccount(a, counts[String(a._id)] || 0)), statuses: ProxyAccount.STATUSES() });
  } catch (err) {
    console.error('Proxy list accounts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Which account will a client actually get RIGHT NOW? Runs the same selection the client
// open route uses and reports the chosen account + why others were skipped — so an admin
// can confirm the NEW account is the one being served after a cookie refresh, WITHOUT ever
// exposing cookies/tokens (only id/label/status/masked identifier).
router.get('/:tool/active-account', async (req, res) => {
  try {
    const accounts = await ProxyAccount.find({ tool: req.proxyTool });
    const chosen = accounts.length ? selectAccount(accounts, SELECTION_MODE) : null;
    const counts = await activeLeaseCountsByAccount(req.proxyTool);

    // LIVE probe (opt out with ?probe=0): fetch the tool with the CHOSEN account's stored
    // cookies — exactly what the client gateway injects — and report safe signals so the
    // admin SEES which account/plan those cookies load (logged-in/out, page title, plan
    // keywords, masked email). Never returns cookies/tokens. This is the ground-truth check
    // for "I updated the cookies but the client still shows the old/free account".
    let liveProbe = null;
    if (chosen && chosen.sessionEncrypted && req.query.probe !== '0') {
      try {
        const host = tools.targetHost(req.proxyTool);
        const bundle = JSON.parse(vaultCrypto.decrypt(chosen.sessionEncrypted));
        const cookieHeader = buildCookieHeader(bundle, host);
        const cookieCount = countCookies(bundle, host);
        const names = cookieNames(bundle, host);
        const hasSess = hasSessionCookie(bundle);
        if (cookieHeader && hasSess) {
          const v = await verifyAccountCookies(req.proxyTool, cookieHeader, chosen.expectedIdentifier);
          liveProbe = {
            result: (v.result === 'session_expired' && v.loggedOut) ? 'needs_login' : v.result,
            httpStatus: v.httpStatus, finalPath: v.finalPath,
            loggedOut: v.loggedOut ?? null, title: v.title || null, plan: v.plan || null,
            maskedIdentifier: v.maskedId || null, cookieCount, cookieNames: names,
          };
        } else {
          liveProbe = { result: 'missing_required_session_cookie', cookieCount, cookieNames: names };
        }
      } catch (_) { liveProbe = { result: 'probe_failed' }; }
    }

    return res.json({
      success: true,
      selectionMode: SELECTION_MODE,
      liveProbe,
      activeAccount: chosen ? {
        id: chosen._id,
        label: chosen.label,
        status: chosen.status,
        sessionStatus: chosen.session_status || 'pending_verification',
        isPrimary: !!chosen.isPrimary,
        maskedIdentifier: chosen.verification?.maskedId || (chosen.expectedIdentifier ? maskEmail(chosen.expectedIdentifier) : null),
        lastVerifiedAt: chosen.lastVerifiedAt || null,
        activeLeaseCount: counts[String(chosen._id)] || 0,
      } : null,
      candidates: accounts.map(a => ({
        id: a._id, label: a.label, isPrimary: !!a.isPrimary, priority: a.priority,
        status: a.status, available: unavailableReason(a) === null, unavailableReason: unavailableReason(a),
        selected: !!(chosen && String(chosen._id) === String(a._id)),
      })),
    });
  } catch (err) {
    console.error('Proxy active-account error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve active account' });
  }
});

router.post('/:tool/accounts', validate(schemas.createAccount), async (req, res) => {
  try {
    const { label, sessionBundle, expectedIdentifier, status, priority, isPrimary, notes } = req.body;
    let sessionEncrypted, sessionMeta;
    if (sessionBundle !== undefined && sessionBundle !== null) {
      const bundle = normalizeCookieBundle(sessionBundle);
      if (!bundle) return res.status(400).json({ error: 'Invalid session bundle' });
      sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
      sessionMeta = buildSessionMeta(req.proxyTool, bundle);
    }
    const account = await ProxyAccount.create({
      tool: req.proxyTool, label, status: status || 'active', priority: priority ?? 100, isPrimary: !!isPrimary,
      expectedIdentifier: expectedIdentifier || '', notes: notes || '', usageCount: 0,
      sessionEncrypted: sessionEncrypted || null,
      sessionMeta: sessionMeta || { cookieCount: 0, hasLocalStorage: false, origin: '', updatedAt: null },
      // Claude-only quota fields (no-op for other tools; model preSave ignores them).
      ...(req.proxyTool === 'claude' ? {
        plan: req.body.plan || 'unknown',
        cycleResetAt: req.body.cycleResetAt || null,
        weeklyResetAt: req.body.weeklyResetAt || null,
      } : {}),
      createdBy: req.userId,
    });
    if (account.isPrimary) await clearOtherPrimaries(req.proxyTool, account._id);
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_CREATED', { tool: req.proxyTool, accountId: account._id, label, ip: getClientIp(req) });
    return res.status(201).json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Proxy create account error:', err.message);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

router.put('/:tool/accounts/:id', validate(schemas.updateAccount), async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    for (const f of ['label', 'status', 'priority', 'notes', 'expectedIdentifier']) if (req.body[f] !== undefined) account[f] = req.body[f];
    if (req.body.isPrimary !== undefined) account.isPrimary = !!req.body.isPrimary;
    // Claude-only quota fields: manual plan + official reset timestamps (operator-corrected).
    if (req.proxyTool === 'claude') {
      if (req.body.plan !== undefined) account.plan = req.body.plan;
      if (req.body.cycleResetAt !== undefined) account.cycleResetAt = req.body.cycleResetAt || null;
      if (req.body.weeklyResetAt !== undefined) account.weeklyResetAt = req.body.weeklyResetAt || null;
    }
    await account.save();
    if (account.isPrimary) await clearOtherPrimaries(req.proxyTool, account._id);
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_UPDATED', { tool: req.proxyTool, accountId: account._id, changes: { ...req.body, sessionBundle: undefined }, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Proxy update account error:', err.message);
    return res.status(500).json({ error: 'Failed to update account' });
  }
});

router.post('/:tool/accounts/:id/session', validate(schemas.accountSession), async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    const bundle = normalizeCookieBundle(req.body.sessionBundle);
    if (!bundle) return res.status(400).json({ error: 'Invalid session bundle' });
    // Single shared write path (also used by the RDP Cookie Sync Agent): encrypt → meta →
    // revoke in-flight leases (so the next open re-fetches the new bundle) → auto-verify.
    const r = await applyAccountSession(account, bundle, {
      tool: req.proxyTool, actorType: 'ADMIN', actorId: req.userId, source: 'admin', ip: getClientIp(req),
    });
    return res.json({ success: true, account: presentAccount(account), revokedLeases: r.revokedLeases, verifyResult: r.verifyResult, warning: r.warning, sessionStatus: account.session_status, maskedIdentifier: r.maskedId, cookieNames: r.cookieNames });
  } catch (err) {
    console.error('Proxy refresh session error:', err.message);
    return res.status(500).json({ error: 'Failed to refresh session' });
  }
});

router.post('/:tool/accounts/:id/verify', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    if (!account.sessionEncrypted) return res.status(400).json({ error: 'No cookie bundle saved for this account' });

    // Live-agent tools (WriteHuman): READ-ONLY verify — a manual check must never rotate the
    // refresh token and compete with the RDP browser (the sole rotator), which would revoke the
    // live session. Static-vault tools keep forceLive (the server IS their rotator). One shared
    // verify->apply path (also used by the on-sync write + the periodic auto-verify scheduler).
    const opts = tools.hasLiveAgent(req.proxyTool) ? { readOnly: true } : { forceLive: true };
    const r = await verifyAndApply(account, req.proxyTool, opts);
    // Claude only: record the best-effort DETECTED plan (advisory) and auto-adopt it as the
    // active plan when the operator hasn't manually chosen one yet ('unknown'). A manual plan
    // selection always wins — this only fills the gap when automatic detection is available.
    if (req.proxyTool === 'claude' && r.v && r.v.plan && claudeQuota.isValidPlan(r.v.plan)) {
      account.planDetected = { plan: r.v.plan, source: 'claude_api', at: new Date() };
      if (claudeQuota.normalizePlan(account.plan) === 'unknown') account.plan = r.v.plan;
      try { await account.save(); } catch (_) {}
    }
    console.log('[proxy] ' + JSON.stringify({ evt: 'verify', tool: req.proxyTool, account_id: account._id, cookie_count: r.cookieCount, upstream_status: r.v ? r.v.httpStatus : 0, result: r.result, mode: opts.readOnly ? 'readonly' : 'forcelive' }));
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_VERIFIED', { tool: req.proxyTool, accountId: account._id, label: account.label, result: r.result, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account), result: r.result, cookieNames: r.cookieNames });
  } catch (err) {
    console.error('Proxy verify account error:', err.message);
    return res.status(500).json({ error: 'Failed to verify account' });
  }
});

router.post('/:tool/accounts/:id/capture-lease', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    const leaseUtil = require('../../utils/proxy/lease');
    const captureMinutes = tools.defaultLeaseMinutes(req.proxyTool);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + captureMinutes * 60 * 1000);
    const leaseRow = await ProxyLease.create({
      tool: req.proxyTool, userId: req.userId, proxyClientId: null, accountId: account._id, accountLabel: account.label,
      issuedAt, expiresAt, revoked: false, capture: true, ip: getClientIp(req), userAgent: req.headers['user-agent'] || '',
    });
    const token = leaseUtil.signLease({ jti: leaseRow._id, userId: req.userId, tool: req.proxyTool, accountId: account._id, ttlMinutes: captureMinutes, capture: true });
    leaseRow.tokenHash = leaseUtil.hashToken(token);
    await leaseRow.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CAPTURE_LEASE', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, url: leaseUtil.gatewayUrl(req.proxyTool, token), expiresAt, ttlMinutes: captureMinutes });
  } catch (err) {
    console.error('Proxy capture-lease error:', err.message);
    return res.status(500).json({ error: 'Failed to create capture lease' });
  }
});

router.get('/:tool/accounts/:id/leases', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    const leases = (await ProxyLease.find({ accountId: account._id })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    const now = Date.now();
    const clientIds = [...new Set(leases.map(l => String(l.proxyClientId)).filter(Boolean))];
    const clientsById = {};
    for (const cid of clientIds) {
      const pc = await ProxyClient.findById(cid);
      if (pc) { const u = await User.findById(pc.userId).select('fullName email'); clientsById[cid] = u ? (u.fullName || u.email) : cid; }
    }
    const view = leases.map(l => ({
      id: l._id, issuedAt: l.issuedAt, expiresAt: l.expiresAt, revoked: l.revoked,
      active: !l.revoked && new Date(l.expiresAt).getTime() > now,
      capture: !!l.capture,
      client: clientsById[String(l.proxyClientId)] || null,
    }));
    return res.json({ success: true, account: presentAccount(account), leases: view });
  } catch (err) {
    console.error('Proxy account leases error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch account leases' });
  }
});

router.post('/:tool/accounts/:id/primary', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    account.isPrimary = true;
    await account.save();
    await clearOtherPrimaries(req.proxyTool, account._id);
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_PRIMARY_SET', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Proxy set primary error:', err.message);
    return res.status(500).json({ error: 'Failed to set primary' });
  }
});

router.post('/:tool/accounts/:id/status', validate(schemas.accountStatus), async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    account.status = req.body.status;
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_STATUS_SET', { tool: req.proxyTool, accountId: account._id, label: account.label, status: account.status, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Proxy set status error:', err.message);
    return res.status(500).json({ error: 'Failed to set status' });
  }
});

router.post('/:tool/accounts/:id/revoke-leases', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    const { modifiedCount } = await ProxyLease.updateMany(
      { accountId: account._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'account_revoked', revokedAt: new Date() } }
    );
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_LEASES_REVOKED', { tool: req.proxyTool, accountId: account._id, label: account.label, count: modifiedCount, ip: getClientIp(req) });
    return res.json({ success: true, revoked: modifiedCount });
  } catch (err) {
    console.error('Proxy revoke account leases error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke account leases' });
  }
});

// Tool-wide "Refresh proxy sessions / clear old leases": revoke EVERY active lease for the
// tool so the next launch (for any client) mints a fresh lease → fresh DB read of the
// latest cookies. Use after a cookie update if any stale session might still be open.
// Reuses the same revoke mechanism; no new cookie/session system.
router.post('/:tool/refresh-sessions', async (req, res) => {
  try {
    const r = await ProxyLease.updateMany(
      { tool: req.proxyTool, revoked: false },
      { $set: { revoked: true, revokedReason: 'tool_sessions_refreshed', revokedAt: new Date() } }
    );
    const revoked = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_TOOL_LEASES_REFRESHED', { tool: req.proxyTool, count: revoked, ip: getClientIp(req) });
    return res.json({ success: true, revoked });
  } catch (err) {
    console.error('Proxy refresh sessions error:', err.message);
    return res.status(500).json({ error: 'Failed to refresh sessions' });
  }
});

router.delete('/:tool/accounts/:id', async (req, res) => {
  try {
    const account = await ProxyAccount.findById(req.params.id);
    if (!account || account.tool !== req.proxyTool) return res.status(404).json({ error: 'Account not found' });
    await ProxyLease.updateMany(
      { accountId: account._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'account_deleted', revokedAt: new Date() } }
    );
    await account.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_DELETED', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('Proxy delete account error:', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ── Unified tool dashboard (MySQL-backed single source of truth) ──────────────
// Aggregates the PRIMARY account's live state + Cookie Sync Agent telemetry in the shape the
// admin WriteHuman dashboard renders. Reads the SAME ProxyAccount the client gateway serves and
// the SAME ProxyClient assignments — no separate store. "Verify now" reuses the existing
// /accounts/:id/verify route; "commands" queue on the account for the agent's next poll.
const AGENT_STALE_MIN = Number(process.env.PROXY_AGENT_STALE_MIN || 10);
// Update management: the version the RDP Cookie Sync Agent SHOULD be running. The dashboard flags
// when the reporting agent is behind so an operator knows to update it.
const EXPECTED_AGENT_VERSION = process.env.PROXY_EXPECTED_AGENT_VERSION || '2.5.2';
function primaryAccount(accounts) {
  return accounts.find(a => a.isPrimary) || selectAccount(accounts, SELECTION_MODE) || accounts[0] || null;
}

router.get('/:tool/agent-state', async (req, res) => {
  try {
    const tool = req.proxyTool;
    const accounts = await ProxyAccount.find({ tool });
    const account = primaryAccount(accounts);
    const clientsCount = (await ProxyClient.find({ tool })).length;
    // Live-agent tools verify READ-ONLY (no server-side exchange), so verifyExchange is false for
    // them; the smart-timer state reflects the real periodic auto-verify scheduler.
    const sched = proxyVerifyScheduler.status();
    const isLive = tools.hasLiveAgent(tool);
    const base = { ok: true, tool, mode: 'production-mysql', target: tools.targetHost(tool), store: 'mysql',
      verifyExchange: tools.verifyMode(tool) === 'supabase_refresh' && !isLive,
      scheduler: { running: isLive && sched.running, intervalMin: isLive ? sched.intervalMin : 0 },
      clientsCount };
    if (!account) return res.json({ ...base, account: null, agent: null, pendingCommand: null, health: 'unknown' });
    const lastSyncedAt = account.lastSyncedAt || null;
    const staleMs = lastSyncedAt ? (Date.now() - new Date(lastSyncedAt).getTime()) : null;
    const agentStale = lastSyncedAt ? (staleMs > AGENT_STALE_MIN * 60000) : null;

    // Access-token age — decode the JWT exp SERVER-SIDE only; the token itself is NEVER returned.
    // Gives the admin an "attention ETA" (how long the current session's access token is valid).
    let accessTokenExpiresInSec = null;
    try {
      if (account.sessionEncrypted) {
        const b = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted));
        const ref = (tools.supabaseConfig(tool) || {}).projectRef;
        const { accessToken } = extractSupabaseSession(buildCookieHeader(b, tools.targetHost(tool)), ref);
        const exp = jwtExp(accessToken);
        if (exp) accessTokenExpiresInSec = Math.round(exp - Date.now() / 1000);
      }
    } catch (_) { /* best-effort; never expose or log the token */ }

    // COHERENT health + reason — the single source of truth for the dashboard. Reconciles ALL
    // signals so cards can no longer contradict each other:
    //  - browserAuthCookies (agent report) = ground truth for "is the browser logged in RIGHT NOW";
    //    0 means the RDP browser has no auth cookie -> it is logged out (even if the stored status
    //    still reads 'working', because read-only verify won't downgrade a not-yet-expired JWT).
    //  - tokenExpired (vault access-token exp, decoded above) = a hard local fact.
    //  - agentStale = the agent isn't reporting, so freshness/liveness can't be trusted.
    // A stored 'working' is only shown as truly UP when the browser is logged in, the agent is
    // fresh, and the access token is still valid — otherwise it degrades (or goes down).
    const ss = account.session_status;
    const agentRep = account.agentReport || null;
    const browserAuthCookies = agentRep && typeof agentRep.authCookies === 'number' ? agentRep.authCookies : null;
    const tokenExpired = accessTokenExpiresInSec != null && accessTokenExpiresInSec <= 0;
    const DOWN_STATES = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];

    let health, statusReason;
    if (!account.sessionEncrypted) { health = 'down'; statusReason = 'No session bundle saved.'; }
    else if (DOWN_STATES.includes(ss)) { health = 'down'; statusReason = ss === 'needs_login' ? 'Logged out — log back into WriteHuman in the RDP Chrome.' : 'Session ' + ss.replace(/_/g, ' ') + '.'; }
    else if (browserAuthCookies === 0) { health = 'down'; statusReason = 'The RDP browser has no auth cookie right now — it is logged out. Log back in on the RDP; cached cookies may still be served briefly.'; }
    else if (ss === 'working') {
      if (agentStale) { health = 'degraded'; statusReason = 'Was working, but the Cookie Sync Agent is stale — current state is unverified.'; }
      else if (tokenExpired) { health = 'degraded'; statusReason = 'Access token has expired and no fresh cookie arrived — the browser may be logged out or idle. Unverified.'; }
      else { health = 'up'; statusReason = 'Working — browser logged in, agent fresh, access token valid.'; }
    } else { health = 'degraded'; statusReason = 'Verification pending — not yet confirmed working.'; }
    // A 'working' that is only degraded (not confidently up) is surfaced as unverified so cards
    // don't render a confident green.
    const working = ss === 'working';
    const workingUnverified = working && health !== 'up';

    const agentOutdated = agentRep && agentRep.version ? (agentRep.version !== EXPECTED_AGENT_VERSION) : null;
    return res.json({
      ...base,
      health,
      statusReason,
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
      agentOutdated,
      account: {
        id: account._id,
        label: account.label || null,
        status: account.status || null,
        sessionStatus: account.session_status || null,
        workingUnverified,
        hasBundle: !!account.sessionEncrypted,
        cookieCount: (account.sessionMeta && account.sessionMeta.cookieCount) || 0,
        hasCookieHash: !!account.cookieHash,
        verification: account.verification || null,
        lastVerifiedAt: account.lastVerifiedAt || null,
        lastSyncedAt,
        syncCount: account.syncCount || 0,
        staleSec: staleMs != null ? Math.round(staleMs / 1000) : null,
        agentStale,
        accessTokenExpiresInSec,
        tokenExpired,
        browserAuthCookies,
      },
      agent: account.agentReport || null,
      pendingCommand: account.pendingCommand || null,
    });
  } catch (err) {
    console.error('Proxy agent-state error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load agent state' });
  }
});

router.post('/:tool/agent-command', async (req, res) => {
  try {
    const tool = req.proxyTool;
    const command = req.body && req.body.command;
    if (!['relaunch-chrome', 'reverify'].includes(command)) return res.status(400).json({ ok: false, error: 'Unknown command' });
    const account = primaryAccount(await ProxyAccount.find({ tool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });
    account.pendingCommand = command;
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_AGENT_COMMAND_QUEUED', { tool, accountId: account._id, command, ip: getClientIp(req) });
    return res.json({ ok: true, queued: command });
  } catch (err) {
    console.error('Proxy agent-command error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to queue command' });
  }
});

router.get('/:tool/agent-logs', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    const events = []; let seq = 1;
    const push = (t, level, event, fields) => { if (t) events.push({ seq: seq++, t: new Date(t).toISOString(), level, event, fields: fields || {} }); };
    if (account) {
      const v = account.verification || {}; const ag = account.agentReport || {};
      push(account.lastSyncedAt, 'info', 'cookie_synced', { syncCount: account.syncCount || 0 });
      push(account.lastVerifiedAt, v.result === 'session_expired' ? 'warn' : 'info', 'verify_' + (v.result || 'unknown'), { httpStatus: v.httpStatus || 0 });
      if (v.checkedAt) push(v.checkedAt, 'info', 'verification', { result: v.result || null });
      if (ag.receivedAt) push(ag.receivedAt, ag.lastError ? 'warn' : 'info', 'agent_report', { cdp: ag.cdp || null, pollCount: ag.pollCount ?? null, error: ag.lastError || null });
    }
    events.sort((a, b) => new Date(a.t) - new Date(b.t));
    return res.json({ ok: true, events });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Failed to load logs' });
  }
});

// ── Alert email configuration (dashboard-managed, per primary account) ────────
// Where health alerts (session down / recovered / agent stale) are emailed. Stored on the primary
// ProxyAccount so it takes effect immediately (no redeploy). The full address is NEVER returned —
// only a masked form — so a shoulder-surfer / screenshot can't read the recipient.
router.get('/:tool/alert-config', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    const { recipient, enabled, source } = healthAlerts.resolveAlert(account);
    return res.json({
      ok: true,
      emailMasked: recipient ? maskEmail(recipient) : null,
      emailSet: !!recipient,
      enabled,
      source,                       // 'db' (dashboard) | 'env' (server default) | 'none'
      smtpConfigured: isEmailEnabled(),
      canConfigure: !!account,
    });
  } catch (err) {
    console.error('Proxy alert-config get error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load alert config' });
  }
});

router.post('/:tool/alert-config', validate(schemas.alertConfig), async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });
    const cfg = Object.assign({}, account.alertConfig || {});
    if (req.body.email !== undefined) cfg.email = (req.body.email || '').trim(); // '' clears → env fallback
    if (req.body.enabled !== undefined) cfg.enabled = !!req.body.enabled;
    cfg.updatedAt = new Date();
    account.alertConfig = cfg;
    await account.save();
    const { recipient, enabled, source } = healthAlerts.resolveAlert(account);
    // Log only the masked recipient — never the raw address.
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ALERT_CONFIG_SET',
      { tool: req.proxyTool, accountId: account._id, source, enabled, emailMasked: recipient ? maskEmail(recipient) : null, ip: getClientIp(req) });
    return res.json({
      ok: true,
      emailMasked: recipient ? maskEmail(recipient) : null,
      emailSet: !!recipient,
      enabled,
      source,
      smtpConfigured: isEmailEnabled(),
    });
  } catch (err) {
    console.error('Proxy alert-config set error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save alert config' });
  }
});

module.exports = router;

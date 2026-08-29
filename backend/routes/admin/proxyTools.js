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
const { rankAssignableClients, escapeRegex } = require('../../utils/proxy/assignableClients');
const { applyAccountSession, buildSessionMeta } = require('../../utils/proxy/applySession');
const deviceSync = require('../../utils/proxy/deviceSync');
const deviceState = require('../../utils/proxy/deviceState');
const activation = require('../../utils/proxy/activation');
const agentEnroll = require('../../utils/proxy/agentEnroll');
const { verifyAndApply } = require('../../utils/proxy/verifyAndApply');
const { deriveLifecycle, deriveHealth } = require('../../utils/proxy/sessionHealth');
const agentCommands = require('../../utils/proxy/agentCommands');
const proxyVerifyScheduler = require('../../cron/proxyVerifyScheduler');
const healthAlerts = require('../../utils/proxy/healthAlerts');
const claudeQuota = require('../../utils/proxy/claudeQuota');
const claudeUsage = require('../../utils/proxy/claudeUsage');
const launchCode = require('../../utils/launchCode');
const launchStore = require('../../utils/launchStore');
const { requireCsrf } = require('../../middleware/csrf');
const claudeSettings = require('../../utils/proxy/claudeSettings');
// Apply admin-editable global Claude defaults at boot (fail-safe; env defaults until loaded).
claudeSettings.ensureLoaded().catch(() => {});
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

// Resolve the account a Claude client is served by (pinned or automatic). Shared by the usage
// dashboard + history so they show exactly the account enforcement uses.
function accountSelectResolve(accounts, pinnedAccountId) {
  const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';
  return require('../../utils/proxy/accountSelect').resolveAccount(accounts || [], SELECTION_MODE, pinnedAccountId).account;
}

// The account to DISPLAY usage for: the client's active-lease account (what they're actually being
// served + metered against, matching the live overlay widget), else a fresh selection. Fail-safe.
async function displayAccountFor(pc, accounts) {
  try {
    const leases = await ProxyLease.find({ proxyClientId: pc._id, revoked: false });
    const a = require('../../utils/proxy/accountSelect').activeLeaseAccount(leases, accounts);
    if (a) return a;
  } catch (_) { /* fall through to fresh selection */ }
  return accountSelectResolve(accounts, pc.pinnedAccountId);
}

// Same selection mode the CLIENT open route uses, so the admin "active account" preview
// reflects exactly which account clients will get (default auto_failover).
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';

// Search + pagination for the Claude usage dashboard (pure; unit-tested separately). Default page
// size is modest so the browser never receives the whole client list; the caller may override with
// ?limit=, hard-capped server-side.
const usageSearch = require('../../utils/proxy/usageSearch');

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
    weeklyTokenLimit: Joi.number().integer().min(0).max(1000000000).allow(null),
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
    weeklyTokenLimit: Joi.number().integer().min(0).max(1000000000).allow(null),
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
    clientTokenLimit: Joi.number().integer().min(0).max(100000000).allow(null),
    weeklyClientTokenLimit: Joi.number().integer().min(0).max(1000000000).allow(null),
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
    clientTokenLimit: Joi.number().integer().min(0).max(100000000).allow(null),
    weeklyClientTokenLimit: Joi.number().integer().min(0).max(1000000000).allow(null),
  }).min(1),
  accountSession: Joi.object({ sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).required() }),
  accountStatus: Joi.object({ status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked').required() }),
  // Claude global quota defaults (admin-editable; null clears an override → env/hardcoded default).
  globalConfig: Joi.object({
    defaultClientLimit: Joi.number().integer().min(0).max(100000000).allow(null),
    defaultWeeklyClientLimit: Joi.number().integer().min(0).max(1000000000).allow(null),
    accountBaseTokens: Joi.number().integer().min(0).max(1000000000).allow(null),
    accountWeeklyBaseTokens: Joi.number().integer().min(0).max(10000000000).allow(null),
    safetyReservePct: Joi.number().integer().min(0).max(95).allow(null),
    // "Allow Fable 5: On/Off". Omitted = leave unchanged, so saving quota numbers alone can
    // never flip the model block. Strict boolean: the route below is the only writer.
    allowFable5: Joi.boolean(),
  }).min(1),
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
  await claudeSettings.ensureLoaded();
  const plans = claudeQuota.PLANS.filter(p => p !== 'unknown').concat('unknown');
  return res.json({
    success: true,
    quota: {
      mode: claudeQuota.quotaMode(),
      defaultClientLimit: claudeQuota.defaultClientLimit(),
      defaultWeeklyClientLimit: claudeQuota.defaultWeeklyClientLimit(),
      accountBaseTokens: claudeQuota.accountBaseTokens(),
      accountWeeklyBaseTokens: claudeQuota.accountWeeklyBaseTokens(),
      safetyReservePct: claudeQuota.safetyReservePct(),
      charsPerToken: claudeQuota.charsPerToken(),
      cycleHours: claudeQuota.CYCLE_MS / 3600000,
      weeklyHardFallback: claudeQuota.WEEKLY_HARD_FALLBACK,
      label: claudeQuota.USAGE_LABEL,
      plans: plans.map(p => ({ key: p, label: claudeQuota.planLabel(p), multiplier: claudeQuota.planMultiplier(p), capacity: claudeQuota.accountCapacity(p), weeklyCapacity: claudeQuota.accountWeeklyCapacity(p) })),
      // These global defaults are set via server env (documented) — surfaced read-only here so
      // the operator can SEE the active policy without exposing anything sensitive.
      // Which global values are ADMIN overrides (vs env/hardcoded), for the UI.
      overrides: claudeQuota.getGlobalOverrides(),
      envKeys: {
        mode: 'CLAUDE_QUOTA_MODE', defaultClientLimit: 'CLAUDE_DEFAULT_CLIENT_TOKENS',
        accountBaseTokens: 'CLAUDE_ACCOUNT_BASE_TOKENS', safetyReservePct: 'CLAUDE_SAFETY_RESERVE_PCT',
        charsPerToken: 'CLAUDE_CHARS_PER_TOKEN',
      },
    },
  });
});

// ─── Global quota defaults — admin-editable (claude-only) ─────────────────────
// GET returns the effective globals + which keys are admin overrides. PUT sets/clears overrides
// (null clears → falls back to env → hardcoded). Applied process-wide immediately. Admin-only.
router.get('/:tool/global-config', async (req, res) => {
  if (req.proxyTool !== 'claude') return res.json({ success: true, global: null });
  await claudeSettings.ensureLoaded();
  return res.json({
    success: true,
    global: {
      effective: {
        defaultClientLimit: claudeQuota.defaultClientLimit(),
        defaultWeeklyClientLimit: claudeQuota.defaultWeeklyClientLimit(),
        accountBaseTokens: claudeQuota.accountBaseTokens(),
        accountWeeklyBaseTokens: claudeQuota.accountWeeklyBaseTokens(),
        safetyReservePct: claudeQuota.safetyReservePct(),
      },
      overrides: claudeQuota.getGlobalOverrides(), // only the keys explicitly set by an admin
      label: claudeQuota.USAGE_LABEL,
      // Boolean admin switches. allowFable5 = "Allow Fable 5: On/Off"; false means the model
      // is blocked for every proxy client and the gateway switches any request for it onto the
      // fallback. Not a secret and not account data.
      flags: claudeSettings.flags(),
    },
  });
});

router.put('/:tool/global-config', validate(schemas.globalConfig), async (req, res) => {
  if (req.proxyTool !== 'claude') return res.status(400).json({ error: 'Global config is Claude-only' });
  try {
    await claudeSettings.update(req.body);
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CLAUDE_GLOBAL_CONFIG_SET', { tool: 'claude', changes: req.body, ip: getClientIp(req) });
    return res.json({
      success: true,
      global: {
        effective: {
          defaultClientLimit: claudeQuota.defaultClientLimit(),
          defaultWeeklyClientLimit: claudeQuota.defaultWeeklyClientLimit(),
          accountBaseTokens: claudeQuota.accountBaseTokens(),
          accountWeeklyBaseTokens: claudeQuota.accountWeeklyBaseTokens(),
          safetyReservePct: claudeQuota.safetyReservePct(),
        },
        overrides: claudeQuota.getGlobalOverrides(),
        flags: claudeSettings.flags(),
      },
    });
  } catch (err) {
    console.error('Proxy global-config set error:', err.message);
    return res.status(500).json({ error: 'Failed to save global config' });
  }
});

// ─── Usage dashboard — Claude clients' live estimated usage (claude-only) ──────
// SEARCHABLE + PAGINATED, both server-side. One efficient pass per page: fetch the ledger rows of
// the accounts on that page once, then compute each client's five-hour + weekly
// used/remaining/limit-reached from the cached rows. Never exposes cookies, sessions or identity —
// only labels, integer token estimates and reset times.
router.get('/:tool/usage-dashboard', async (req, res) => {
  try {
    if (req.proxyTool !== 'claude') return res.json({ success: true, rows: [], total: 0, page: 1, pageSize: 0, totalPages: 0, q: '', generatedAt: new Date() });
    await claudeSettings.ensureLoaded();
    // Search + pagination. `q` matches the client NAME, EMAIL or assigned ACCOUNT LABEL,
    // case-insensitively and on a partial string. Both are resolved server-side so the browser
    // never receives the full client list.
    const q = usageSearch.normalizeQuery(req.query.q);
    const [clients, accounts] = await Promise.all([
      ProxyClient.find({ tool: 'claude' }),
      ProxyAccount.find({ tool: 'claude' }),
    ]);
    // Resolve each client's identity + display account FIRST. The search spans all three fields,
    // and the account is a resolved value (active lease → selection) rather than a stored column,
    // so the match cannot be pushed into the ProxyClient query — it has to be decided here,
    // before the page is cut. Only the cheap lookups run for every client; the expensive ledger
    // read and usage maths below run for the CURRENT PAGE ONLY.
    const entries = [];
    for (const pc of clients) {
      const account = await displayAccountFor(pc, accounts);
      const user = await User.findById(pc.userId).select('fullName email status');
      entries.push({ pc, account, user });
    }
    // Filter → deterministic sort → slice. All three live in utils/proxy/usageSearch.js so they
    // are unit-tested without a database; see that file for why selection cannot be a DB query.
    const {
      entries: pageEntries, total, page: safePage, pageSize, totalPages,
    } = usageSearch.selectPage(entries, { q, page: req.query.page, pageSize: req.query.limit });

    // Cache the ledger rows for the accounts ON THIS PAGE only. `accountUsed` is an account-wide
    // total, so each needed account is still read in full — just never for accounts nobody on this
    // page is served by.
    const Usage = require('../../models/proxy/ClaudeUsage');
    const needed = new Set(pageEntries.map((e) => e.account && String(e.account._id)).filter(Boolean));
    const rowsByAccount = {};
    for (const a of accounts) {
      if (!needed.has(String(a._id))) continue;
      try { rowsByAccount[String(a._id)] = await Usage.find({ accountId: String(a._id) }); }
      catch (_) { rowsByAccount[String(a._id)] = null; } // null → not synced
    }
    const rows = [];
    for (const { pc, account, user } of pageEntries) {
      const acctRows = account ? rowsByAccount[String(account._id)] : [];
      const synced = acctRows != null;
      const keys = claudeUsage.cycleKeysFor(account, undefined);
      // Aggregate by real event time inside the active window (source-of-truth; immune to a
      // reset-anchor change) — the SAME path the client widget uses, so the two always agree.
      const clientRows = (acctRows || []).filter(r => r && String(r.proxyClientId) === String(pc._id));
      const clientUsed = claudeUsage.sumRowsInWindow(clientRows, keys.fiveWindow);
      const accountUsed = claudeUsage.sumRowsInWindow(acctRows || [], keys.fiveWindow);
      const weeklyClientUsed = claudeUsage.sumRowsInWindow(clientRows, keys.weekWindow);
      const weeklyAccountUsed = claudeUsage.sumRowsInWindow(acctRows || [], keys.weekWindow);
      const decision = claudeUsage.resolveDecision({
        account, client: pc, clientUsed, accountUsed, weeklyClientUsed, weeklyAccountUsed, estIncoming: 0,
      });
      const weeklySynced = synced && !!(account && account.weeklyResetAt);
      rows.push({
        id: pc._id,
        client: user ? { fullName: user.fullName, email: user.email, status: user.status } : null,
        clientStatus: pc.status,
        active: pc.isActive(),
        expired: pc.isExpired(),
        accountLabel: account ? account.label : null,
        accountAvailable: account ? unavailableReason(account) === null : false,
        plan: decision.plan, planLabel: decision.planLabel,
        synced,
        // five-hour
        fiveHour: {
          limit: decision.clientLimit, used: decision.clientUsed, remaining: decision.clientRemaining,
          isCustom: pc.tokenLimit != null,
          accountCapacity: decision.accountCapacity, accountUsed: decision.accountUsed, accountRemaining: decision.accountRemaining,
          resetAt: keys.fiveWindow ? new Date(keys.fiveWindow.endMs) : null,
          resetInSeconds: claudeQuota.secondsUntilReset(keys.fiveWindow),
          // The rolling five-hour cycle always has a computable reset; it is "official" only when
          // the account carries an explicit cycleResetAt (else it is anchored on the account age).
          resetOfficial: !!(account && account.cycleResetAt),
          reached: decision.clientRemaining === 0,
          accountAtCapacity: decision.accountRemaining === 0,
        },
        // weekly
        weekly: {
          limit: decision.weeklyClientLimit, used: decision.weeklyClientUsed, remaining: decision.weeklyClientRemaining,
          isCustom: pc.weeklyTokenLimit != null,
          accountCapacity: decision.weeklyAccountCapacity, accountUsed: decision.weeklyAccountUsed, accountRemaining: decision.weeklyAccountRemaining,
          resetAt: (account && account.weeklyResetAt) || null,
          resetInSeconds: claudeQuota.secondsUntilReset(keys.weekWindow),
          reached: decision.weeklyClientRemaining === 0,
          accountAtCapacity: decision.weeklyAccountRemaining === 0,
          synced: weeklySynced,
        },
        label: claudeQuota.USAGE_LABEL,
      });
    }
    // `total` is the count of clients MATCHING the search, which is what the pager and the empty
    // state need. `q` is echoed back so a late response can be identified and discarded.
    return res.json({
      success: true, rows, total, page: safePage, pageSize, totalPages, q,
      generatedAt: new Date(), label: claudeQuota.USAGE_LABEL,
    });
  } catch (err) {
    console.error('Proxy usage-dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load usage dashboard' });
  }
});

// ─── Recent usage history for one client (claude-only) ────────────────────────
router.get('/:tool/clients/:id/usage-history', async (req, res) => {
  try {
    if (req.proxyTool !== 'claude') return res.json({ success: true, history: [] });
    const pc = await ProxyClient.findById(req.params.id);
    if (!pc || pc.tool !== 'claude') return res.status(404).json({ error: 'Client grant not found' });
    const accounts = await ProxyAccount.find({ tool: 'claude' });
    const account = await displayAccountFor(pc, accounts);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const history = account ? await claudeUsage.recentHistory(account._id, pc._id, limit) : [];
    return res.json({ success: true, history, label: claudeQuota.USAGE_LABEL });
  } catch (err) {
    console.error('Proxy usage-history error:', err.message);
    return res.status(500).json({ error: 'Failed to load usage history' });
  }
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
    weeklyTokenLimit: pc.tool === 'claude' ? (pc.weeklyTokenLimit ?? null) : null,
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

// Lightweight, admin-only SOURCE for the "Grant access" picker. Server-side partial
// name/email search (case-insensitive), ranked exact → starts-with → contains, paginated,
// returning ONLY id/name/email/status/eligible. Excludes non-active and already-granted
// clients so the picker can't grant a suspended client or a duplicate grant. Purely additive:
// does NOT touch the shared /admin/clients endpoint, StealthWriter, auth, or usage limits.
router.get('/:tool/assignable-clients', async (req, res) => {
  try {
    const rawTerm = String(req.query.search || '').trim().slice(0, 100);
    const { limit, skip } = safePagination(req.query); // default 20, hard-capped at 100
    const CANDIDATE_CAP = 200;                          // rank within the top matches; type to narrow

    // Exclude clients that already have access to THIS tool (no duplicate grants).
    const granted = await ProxyClient.find({ tool: req.proxyTool });
    const grantedIds = granted.map(g => String(g.userId));

    // Eligible = an active CRM client not already granted this tool.
    const query = { role: 'CLIENT', status: 'active' };
    if (grantedIds.length) query._id = { $nin: grantedIds };
    if (rawTerm) {
      const escaped = escapeRegex(rawTerm);
      query.$or = [
        { fullName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }

    const candidates = await User.find(query)
      .select('fullName email status')
      .sort({ createdAt: -1 })   // recent-first for the no-search default
      .limit(CANDIDATE_CAP);

    const ranked = rankAssignableClients(candidates, rawTerm);
    const pageItems = ranked.slice(skip, skip + limit);

    return res.json({
      success: true,
      clients: pageItems,
      pagination: {
        limit, skip,
        returned: pageItems.length,
        hasMore: ranked.length > skip + limit,
        capped: candidates.length >= CANDIDATE_CAP, // more than CAP matches — narrow the search
      },
    });
  } catch (err) {
    console.error('Proxy assignable-clients error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

router.post('/:tool/clients', validate(schemas.createClient), async (req, res) => {
  try {
    const { userId, planName, expiryDate, status, notes, leaseMinutes, tokenLimit, weeklyTokenLimit } = req.body;
    // Re-validate the picked client on the server before granting (the picker is UI only).
    const user = await User.findById(userId).select('role status');
    if (!user || user.role !== 'CLIENT') return res.status(400).json({ error: 'Target user must be an existing CRM client' });
    if (user.status && user.status !== 'active') return res.status(400).json({ error: 'This client account is not active' });
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
      ...(isClaude ? { tokenLimit: tokenLimit ?? null, weeklyTokenLimit: weeklyTokenLimit ?? null, pinnedAccountId: pin.value ?? null } : {}),
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
      if (req.body.weeklyTokenLimit !== undefined) pc.weeklyTokenLimit = req.body.weeklyTokenLimit ?? null;
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
    const account = await displayAccountFor(pc, accounts);
    const u = await claudeUsage.readUsage(account, pc);
    const decision = claudeUsage.resolveDecision({
      account, client: pc, clientUsed: u.clientUsed, accountUsed: u.accountUsed,
      weeklyClientUsed: u.weeklyClientUsed, weeklyAccountUsed: u.weeklyAccountUsed, estIncoming: 0,
    });
    // Weekly reset time is only "synced" when the official weeklyResetAt is set on the account —
    // otherwise we never fabricate a reset time (per requirement). Usage sync = the DB read.
    const weeklySynced = !!u.synced && !!(account && account.weeklyResetAt);
    return res.json({
      success: true,
      quota: Object.assign(claudeQuota.presentDecision(decision), {
        accountLabel: account ? account.label : null,       // operator label only — never identity
        pinned: !!pc.pinnedAccountId,
        synced: !!u.synced,
        resetInSeconds: claudeQuota.secondsUntilReset(u.keys.fiveWindow),
        fiveHourResetOfficial: !!(account && account.cycleResetAt),
        weeklyResetAt: (account && account.weeklyResetAt) || null,
        weeklyResetInSeconds: claudeQuota.secondsUntilReset(u.keys.weekWindow),
        weeklySynced,
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
    clientTokenLimit: account.tool === 'claude' ? (account.clientTokenLimit ?? null) : null,
    weeklyClientTokenLimit: account.tool === 'claude' ? (account.weeklyClientTokenLimit ?? null) : null,
    estimatedCapacity: account.tool === 'claude' ? claudeQuota.accountCapacity(account.plan) : null,
    estimatedWeeklyCapacity: account.tool === 'claude' ? claudeQuota.accountWeeklyCapacity(account.plan) : null,
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
        clientTokenLimit: req.body.clientTokenLimit ?? null,
        weeklyClientTokenLimit: req.body.weeklyClientTokenLimit ?? null,
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
      if (req.body.clientTokenLimit !== undefined) account.clientTokenLimit = req.body.clientTokenLimit ?? null;
      if (req.body.weeklyClientTokenLimit !== undefined) account.weeklyClientTokenLimit = req.body.weeklyClientTokenLimit ?? null;
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

// CSRF-gated (admin cookie auth, SameSite=None) and launch-code aware: without this the
// URL lease flow could never actually be switched off, because "Capture via proxy" would
// still be putting a capture lease — the most privileged lease there is — in an address bar.
router.post('/:tool/accounts/:id/capture-lease', requireCsrf, async (req, res) => {
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
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CAPTURE_LEASE', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');

    if (launchCode.postFlowEnabled('proxy', req.proxyTool)) {
      const issued = await launchStore.issue({
        module: 'proxy', tool: req.proxyTool, userId: req.userId,
        accountId: account._id, leaseId: leaseRow._id, capture: true,
        ip: getClientIp(req), userAgent: req.headers['user-agent'] || '',
      });
      return res.json({
        success: true,
        launch: { method: 'POST', url: tools.gatewayLaunchUrl(req.proxyTool), field: 'code', code: issued.code, expiresInSeconds: issued.ttlSeconds },
        expiresAt, ttlMinutes: captureMinutes,
      });
    }

    const token = leaseUtil.signLease({ jti: leaseRow._id, userId: req.userId, tool: req.proxyTool, accountId: account._id, ttlMinutes: captureMinutes, capture: true });
    leaseRow.tokenHash = leaseUtil.hashToken(token);
    await leaseRow.save();
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
// How old the stored cookie bundle may get before cookie sync is reported as behind. Separate from
// AGENT_STALE_MIN (agent liveness) on purpose — see the note where syncStale is computed.
const SYNC_STALE_MIN = Number(process.env.PROXY_SYNC_STALE_MIN || 90);
// How old a successful verification may get before the page says a re-check is DUE. Comfortably
// wider than the scheduler's 7-minute cadence, so a normally-running system reads "recent" and the
// word "due" keeps meaning something. This is freshness of the CHECK — never session health.
const VERIFY_DUE_MIN = Number(process.env.PROXY_VERIFY_DUE_MIN || 20);
// Update management: the version the RDP Cookie Sync Agent SHOULD be running. The dashboard flags
// when the reporting agent is behind so an operator knows to update it.
const EXPECTED_AGENT_VERSION = process.env.PROXY_EXPECTED_AGENT_VERSION || '3.5.0';
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
    if (!account) return res.json({ ...base, account: null, agent: null, pendingCommands: [], health: 'unknown' });
    // MULTI-DEVICE liveness. `lastSyncedAt` keeps its original meaning (last SUCCESSFUL cookie
    // write) for backwards compatibility, but freshness is now a property of the FLEET: as long as
    // any paired device is reporting, the sync pipeline is alive. A device going offline must not
    // by itself mark the service stale — the last verified bundle keeps working.
    const staleMsThreshold = AGENT_STALE_MIN * 60000;
    const devices = deviceSync.getDevices(account);
    const activeSource = account.activeSource || null;
    const activeDeviceId = activeSource && activeSource.deviceId;
    const deviceViewsAll = devices.map(d => deviceSync.publicDevice(d, activeDeviceId, staleMsThreshold));
    // Auto-supersede a stale duplicate: reinstalling the agent enrols a NEW device id, so the same
    // machine can show twice. A device is superseded when another NON-revoked device shares its name,
    // was seen more recently, and this one is offline and not the active source. Superseded rows are
    // kept for history but hidden from the default list, so the operator sees one row per machine.
    // One shared definition (deviceSync.isSupersededDevice) so the COMMAND ROUTER and this page
    // agree on which rows are dead duplicates. It used to be computed only here, which is why a
    // superseded row could still be handed a command.
    // Every row carries its ONE canonical operational state, from the same function the command
    // router and the promotion policy use. The dashboard can no longer show a device as available
    // while the router considers it unaddressable — they are literally reading the same answer.
    deviceViewsAll.forEach(dv => {
      if (!dv) return;
      const raw = deviceSync.findDevice(account, dv.deviceId);
      const st = deviceState.stateOf(account, raw, { staleMs: staleMsThreshold });
      dv.state = st.state;
      dv.stateReason = st.reason;
      dv.terminal = st.terminal;
      dv.canActivate = deviceState.canActivate(st.state);
      dv.superseded = st.state === 'SUPERSEDED';
    });
    const deviceViews = deviceViewsAll.filter(dv => dv && !dv.superseded);
    const supersededDevices = deviceViewsAll.filter(dv => dv && dv.superseded);
    const onlineDevices = deviceViews.filter(d => d && !d.revoked && d.online);
    const activeDeviceView = deviceViews.find(d => d && d.deviceId === activeDeviceId) || null;

    const lastSyncedAt = account.lastSyncSuccessAt || account.lastSyncedAt || null;
    const staleMs = lastSyncedAt ? (Date.now() - new Date(lastSyncedAt).getTime()) : null;
    const lastAgentSeenAt = account.lastAgentSeenAt
      || deviceViews.reduce((acc, d) => (d && d.lastSeenAt && (!acc || new Date(d.lastSeenAt) > new Date(acc)) ? d.lastSeenAt : acc), null);
    const agentSeenMs = lastAgentSeenAt ? (Date.now() - new Date(lastAgentSeenAt).getTime()) : null;
    // "Stale" now means NO paired device has reported recently — not merely that cookies have not
    // changed. A healthy idle session legitimately produces no new bundle for hours.
    const agentStale = devices.length ? (agentSeenMs == null || agentSeenMs > staleMsThreshold) : (lastSyncedAt ? staleMs > staleMsThreshold : null);
    // Cookie freshness is a SEPARATE fact from agent liveness, and conflating them is what made the
    // old dashboard lie in both directions: a live agent implied "cookies fresh", and cookies that
    // had not changed implied "agent stale". A browser rotates its Supabase token about hourly, so
    // a bundle older than SYNC_STALE_MIN means cookies are genuinely behind even if agents are up.
    const syncStale = lastSyncedAt ? (staleMs > SYNC_STALE_MIN * 60000) : null;

    // Is the ingest endpoint able to accept a push at all? Nothing used to surface this, which is
    // exactly how a hard ingest outage stayed invisible for 38 days.
    const ingestConfigured = devices.some(d => d && !d.revoked) || !!process.env.PROXY_AGENT_SYNC_KEY;

    // Access-token age — decode the JWT exp SERVER-SIDE only; the token itself is NEVER returned.
    // Gives the admin an "attention ETA" (how long the current session's access token is valid).
    // `refreshTokenPresent` is decoded at the same time and matters far more: it is the difference
    // between "the short-lived half aged out, which is routine" and "this bundle can never renew
    // itself", and only the second is a login problem.
    let accessTokenExpiresInSec = null;
    let refreshTokenPresent = null;
    try {
      if (account.sessionEncrypted) {
        const b = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted));
        const ref = (tools.supabaseConfig(tool) || {}).projectRef;
        const { accessToken, refreshToken } = extractSupabaseSession(buildCookieHeader(b, tools.targetHost(tool)), ref);
        const exp = jwtExp(accessToken);
        if (exp) accessTokenExpiresInSec = Math.round(exp - Date.now() / 1000);
        refreshTokenPresent = !!refreshToken;
      }
    } catch (_) { /* best-effort; never expose or log the token */ }

    // COHERENT health + reason — the single source of truth for the dashboard. Reconciles ALL
    // signals so cards can no longer contradict each other:
    //  - browserAuthCookies (agent report) = ground truth for "is the browser logged in RIGHT NOW";
    //    0 means the RDP browser has no auth cookie -> it is logged out (even if the stored status
    //    still reads 'working', because read-only verify won't downgrade a not-yet-expired JWT).
    //  - agentStale = the agent isn't reporting, so freshness/liveness can't be trusted.
    //
    // THE ONE THING THIS NO LONGER DOES: degrade on `tokenExpired`. WriteHuman's access token lives
    // ~1h and the dedicated Chrome rotates it LATE (measured: 63-86 min apart on a 60-minute
    // token, because Chrome throttles timers in a backgrounded window), so for part of EVERY hour
    // the stored token is expired while the refresh session is perfectly alive. Treating that as
    // "degraded / unverified" is what turned five cards amber every hour and sent the operator to
    // refresh the RDP browser by hand. It is verification FRESHNESS, and it lives there now.
    const ss = account.session_status;
    // Device telemetry is only ground truth while it is FRESH. The pre-multi-device dashboard read
    // `account.agentReport` unconditionally, so after the ingest outage it kept rendering a
    // 38-day-old snapshot as "Chrome/CDP connected · logged in" — the single most misleading thing
    // on the page, and the reason the outage was diagnosed as a local-agent fault. A frozen report
    // now reports nothing at all rather than something stale.
    const activeRep = activeDeviceView && activeDeviceView.online ? activeDeviceView : null;
    const legacyRep = account.agentReport || null;
    const legacyFresh = legacyRep && legacyRep.receivedAt && (Date.now() - new Date(legacyRep.receivedAt).getTime()) <= staleMsThreshold;
    const browserAuthCookies = activeRep && typeof activeRep.authCookies === 'number'
      ? activeRep.authCookies
      : (legacyFresh && typeof legacyRep.authCookies === 'number' ? legacyRep.authCookies : null);
    const telemetryFrozen = !activeRep && !legacyFresh && !!(activeDeviceView || legacyRep);
    const tokenExpired = accessTokenExpiresInSec != null && accessTokenExpiresInSec <= 0;

    // ── The FIVE separate health signals ───────────────────────────────────────
    // Session / verification / agent / Chrome / cookie-sync are computed independently and are
    // allowed to disagree, because in reality they do. "Session HEALTHY · Agent OFFLINE · Cookie
    // sync BEHIND · using the last verified bundle" is a correct, non-alarming state, and the old
    // single `stale` value could not express it.
    const cdpConnected = activeRep ? String(activeRep.cdp) === '200' : null;
    const lastVerifyResult = (account.verification && account.verification.result) || null;
    const verifiedAt = account.lastVerifiedAt ? new Date(account.lastVerifiedAt).getTime() : null;
    const verificationAgeSec = verifiedAt ? Math.round((Date.now() - verifiedAt) / 1000) : null;
    const lastSyncFailed = !!(account.lastSyncResultCode
      && !['PROMOTED', 'COOKIE_BUNDLE_UNCHANGED', 'HEARTBEAT', 'STANDBY_ROUTINE_REFRESH', 'OK'].includes(account.lastSyncResultCode));

    const signals = {
      hasBundle: !!account.sessionEncrypted,
      sessionStatus: ss,
      browserAuthCookies,
      tokenExpired,
      refreshTokenPresent,
      lastVerifyResult,
      verificationAgeSec,
      verificationDueSec: VERIFY_DUE_MIN * 60,
      agentStale,
      agentSeenSec: agentSeenMs != null ? Math.round(agentSeenMs / 1000) : null,
      agentStaleSec: AGENT_STALE_MIN * 60,
      devicesPaired: deviceViews.filter(d => d && !d.revoked).length,
      onlineDeviceCount: onlineDevices.length,
      cdpConnected,
      ingestConfigured,
      cookieSyncAgeSec: staleMs != null ? Math.round(staleMs / 1000) : null,
      cookieSyncStaleSec: SYNC_STALE_MIN * 60,
      lastSyncFailed,
    };
    const hs = deriveHealth(signals);
    const lc = deriveLifecycle(signals);
    const lifecycleState = lc.state, lifecycleReason = lc.reason, loginRequired = lc.loginRequired;

    // Legacy tri-state, kept for the embedded Proxy-Tools view and any cached bundle that still
    // reads it. Derived from the same signals so it can never contradict them — and, critically,
    // an aged access token is no longer a reason to degrade.
    let health, statusReason;
    if (hs.session.state === 'ERROR') { health = 'down'; statusReason = hs.session.reason; }
    else if (hs.session.state === 'LOGIN_REQUIRED') { health = 'down'; statusReason = hs.session.reason; }
    else if (!ingestConfigured) { health = 'degraded'; statusReason = 'Working, but no device is paired — nothing can refresh this session when it ages out. Pair a device to restore automatic sync.'; }
    else if (hs.verification.state === 'failed') { health = 'degraded'; statusReason = hs.verification.reason; }
    else if (hs.agent.state === 'OFFLINE') { health = 'degraded'; statusReason = 'Working from the last verified bundle, but no paired device is reporting — it cannot refresh until one comes back online.'; }
    else if (hs.cookieSync.state === 'BEHIND' || hs.cookieSync.state === 'FAILED') { health = 'degraded'; statusReason = 'Working — cookie sync is behind. The stored session is still valid.'; }
    else { health = 'up'; statusReason = hs.summary; }

    // Retained for API compatibility. It now means what its name says — the session is working but
    // the last check could not CONFIRM it — and is no longer set merely because a token aged.
    const working = ss === 'working';
    const workingUnverified = working && hs.verification.state === 'failed';

    const reportedVersion = (activeDeviceView && activeDeviceView.agentVersion) || (legacyRep && legacyRep.version) || null;
    const agentOutdated = reportedVersion ? (reportedVersion !== EXPECTED_AGENT_VERSION) : null;
    const cand = account.candidate || null;
    return res.json({
      ...base,
      health,
      statusReason,
      lifecycleState,
      lifecycleReason,
      loginRequired,
      // THE five separate signals the dashboard renders. Each carries its own state and its own
      // human reason, so the page never has to invent one label that covers all of them.
      healthSignals: hs,
      accessTokenExpiresInSec,
      refreshTokenPresent,
      serverRefreshEnabled: process.env.WRITEHUMAN_SERVER_REFRESH === '1',
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
      agentOutdated,
      ingestConfigured,
      telemetryFrozen,
      // Multi-device view: who is paired, who is online, and who is currently supplying cookies.
      devices: deviceViews,
      supersededDevices,
      deviceCount: deviceViews.filter(d => d && !d.revoked).length,
      onlineDeviceCount: onlineDevices.length,
      activeSource: activeSource ? {
        deviceId: activeSource.deviceId,
        name: activeSource.name || (activeDeviceView && activeDeviceView.name) || null,
        promotedAt: activeSource.promotedAt || null,
        bundleVersion: activeSource.bundleVersion || 0,
        online: !!(activeDeviceView && activeDeviceView.online),
      } : null,
      // Candidate state carries NO cookie values — only who sent it, when, and how it was judged.
      candidate: cand ? {
        deviceId: cand.deviceId || null,
        deviceName: cand.deviceName || null,
        receivedAt: cand.receivedAt || null,
        status: cand.status || null,
        code: cand.code || null,
        hashPrefix: cand.hash || null,
        observedMaskedId: cand.observedMaskedId || null,
        expectedMaskedId: cand.expectedMaskedId || null,
      } : null,
      bundleVersion: account.bundleVersion || 0,
      // The live Mark Active transaction with its REAL stage, so the page never has to render an
      // open-ended "syncing". Terminal transactions stay visible briefly with their outcome.
      activation: (() => {
        const live = activation.current(account);
        const target = live ? deviceViewsAll.find(d => d && d.deviceId === live.targetDeviceId) : null;
        return activation.publicView(account, { deviceOffline: target ? !target.online : false });
      })(),
      activationLog: activation.publicLog(account),
      // Retained for API compatibility with an older bundle that reads these two; they now derive
      // from the transaction rather than from the removed intent field.
      pendingActiveDeviceId: (() => { const a = activation.inFlight(account); return a ? a.targetDeviceId : null; })(),
      pendingActiveExpiresAt: (() => { const a = activation.inFlight(account); return a ? a.expiresAt : null; })(),
      // The invariant, checked on every read rather than assumed: at most one ACTIVE device.
      activeConflicts: deviceState.activeConflicts(account, { staleMs: staleMsThreshold }),
      rollbackAvailable: Array.isArray(account.rollbackBundles) ? account.rollbackBundles.length : 0,
      lastAgentSeenAt,
      lastSyncAttemptAt: account.lastSyncAttemptAt || null,
      lastSyncResultCode: account.lastSyncResultCode || null,
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
        lastSyncSuccessAt: account.lastSyncSuccessAt || null,
        syncCount: account.syncCount || 0,
        staleSec: staleMs != null ? Math.round(staleMs / 1000) : null,
        agentSeenSec: agentSeenMs != null ? Math.round(agentSeenMs / 1000) : null,
        agentStale,
        syncStale,
        accessTokenExpiresInSec,
        tokenExpired,
        browserAuthCookies,
        telemetryFrozen,
      },
      // The active source's telemetry (falls back to the legacy single-agent report). Held back
      // when frozen so the UI can render "last seen" instead of a stale "connected".
      agent: activeRep || (legacyFresh ? legacyRep : null),
      agentFrozenReport: telemetryFrozen ? (activeDeviceView || legacyRep) : null,
      // ADDRESSED command queue — every entry names the one device allowed to run it. The old
      // untargeted `pendingCommand` string is gone; it was handed to whichever agent polled first.
      pendingCommands: agentCommands.publicCommands(account),
      commandLog: (Array.isArray(account.commandLog) ? account.commandLog : []).slice(-8),
      commandMinAgentVersion: agentCommands.MIN_AGENT_VERSION,
    });
  } catch (err) {
    console.error('Proxy agent-state error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load agent state' });
  }
});

// ── Verify Session — PURELY SERVER-SIDE ───────────────────────────────────────
// Reads the active stored bundle, checks it still carries the cookies a session needs, and proves
// it with ONE real authenticated WriteHuman/Supabase call. It does NOT open Chrome, does NOT start
// or message any agent, does NOT pick a device, does NOT require the active source to be online,
// and does NOT alter which device is the active source. A stored session must be verifiable while
// the source RDP is switched off — that is the whole point of storing it.
router.post('/:tool/verify-session', async (req, res) => {
  try {
    const tool = req.proxyTool;
    const account = primaryAccount(await ProxyAccount.find({ tool }));
    if (!account) return res.status(404).json({ ok: false, code: 'NO_ACCOUNT', error: 'No account' });
    if (!account.sessionEncrypted) return res.status(400).json({ ok: false, code: 'NO_BUNDLE', error: 'No cookie bundle saved for this account' });

    const isLive = tools.hasLiveAgent(tool);
    // Live-agent tools stay read-only: the browser is the rotator. `canary` is what makes this a
    // REAL check rather than a local JWT decode — it authenticates against Supabase without
    // touching the refresh token. `allowServerRefresh` only does anything when the operator has
    // switched WRITEHUMAN_SERVER_REFRESH on AND the token has already expired.
    const opts = isLive
      ? { readOnly: true, canary: true, allowServerRefresh: req.body && req.body.allowRefresh === true }
      : { forceLive: true };
    const r = await verifyAndApply(account, tool, opts);

    console.log('[proxy] ' + JSON.stringify({
      evt: 'verify_session', tool, account_id: account._id, result: r.result,
      upstream_status: r.v ? r.v.httpStatus : 0, canary: r.v ? (r.v.canary || null) : null,
      refresh_persisted: !!r.refreshPersisted, chrome_launched: false,
    }));
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_SESSION_VERIFIED', { tool, accountId: account._id, result: r.result, serverSide: true, ip: getClientIp(req) });

    return res.json({
      ok: true,
      result: r.result,
      canary: r.v ? (r.v.canary || null) : null,
      httpStatus: r.v ? r.v.httpStatus : 0,
      maskedId: r.v ? (r.v.maskedId || null) : null,
      cookieCount: r.cookieCount,
      refreshed: !!r.refreshPersisted,
      bundleVersion: account.bundleVersion || 0,
      sessionStatus: account.session_status,
      lastVerifiedAt: account.lastVerifiedAt,
      // Stated explicitly in the response so the UI can never imply otherwise.
      chromeLaunched: false,
      deviceContacted: null,
    });
  } catch (err) {
    console.error('Proxy verify-session error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to verify the stored session' });
  }
});

// ── Open WriteHuman Chrome on the ACTIVE SOURCE ───────────────────────────────
// The ONLY action that may launch a browser, and it is addressed to exactly one device:
// `account.activeSource.deviceId`. There is no fallback. A revoked, superseded, inactive, standby
// or merely more-recently-seen device is never chosen, and if the active source is offline the
// operator is told so rather than having Chrome opened somewhere else.
router.post('/:tool/open-chrome', requireCsrf, async (req, res) => {
  try {
    const tool = req.proxyTool;
    const account = primaryAccount(await ProxyAccount.find({ tool }));
    if (!account) return res.status(404).json({ ok: false, code: 'NO_ACCOUNT', error: 'No account' });

    const activeId = account.activeSource && account.activeSource.deviceId;
    if (!activeId) {
      return res.status(409).json({
        ok: false, code: agentCommands.CODES.NO_ACTIVE_SOURCE,
        error: 'No device is the active source yet, so there is nowhere to open Chrome.',
      });
    }
    const staleMs = AGENT_STALE_MIN * 60000;
    const t = agentCommands.validateTarget(account, activeId, {
      requireActiveSource: true, requireOnline: true, requireCommandSupport: true, staleMs,
    });
    if (!t.ok) {
      // The message is the operator-facing sentence, including the two exact wordings required
      // when the active source is offline.
      const loginRequired = !!(req.body && req.body.loginRequired);
      const message = (t.code === agentCommands.CODES.ACTIVE_SOURCE_OFFLINE && loginRequired)
        ? 'Login required, but the active source is currently offline.'
        : t.message;
      return res.status(409).json({ ok: false, code: t.code, error: message, activeSourceDeviceId: activeId, chromeLaunched: false });
    }

    const q = agentCommands.enqueue(account, {
      type: 'open-chrome', tool, device: t.device, issuedBy: String(req.userId || ''),
      reason: (req.body && req.body.reason) ? String(req.body.reason).slice(0, 80) : 'admin_open_chrome',
    });
    if (!q.ok) return res.status(400).json({ ok: false, code: q.code });
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_OPEN_CHROME_QUEUED', {
      tool, accountId: account._id, deviceId: t.device.deviceId, commandId: q.command.id, ip: getClientIp(req),
    });
    return res.json({
      ok: true, commandId: q.command.id, targetDeviceId: t.device.deviceId,
      targetDeviceName: t.device.name || null, expiresAt: q.command.expiresAt,
      note: 'Queued for ' + (t.device.name || t.device.deviceId) + ' only. No other machine can pick this up.',
    });
  } catch (err) {
    console.error('Proxy open-chrome error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to queue the Chrome launch' });
  }
});

// ── Addressed agent command ───────────────────────────────────────────────────
// Replaces the old `account.pendingCommand` string, which carried no target and was consumed by
// whichever agent POSTed first — the reason actions landed on the wrong computer. `deviceId` is
// REQUIRED; there is deliberately no "pick a sensible device" branch to fall into.
router.post('/:tool/agent-command', requireCsrf, async (req, res) => {
  try {
    const tool = req.proxyTool;
    const body = req.body || {};
    const command = body.command;
    if (!agentCommands.TYPES.includes(command)) {
      return res.status(400).json({ ok: false, code: agentCommands.CODES.UNKNOWN_COMMAND, error: 'Unknown command' });
    }
    if (agentCommands.LAUNCHES_BROWSER.includes(command)) {
      return res.status(400).json({
        ok: false, code: 'USE_OPEN_CHROME',
        error: 'Launching Chrome has its own action so it can never happen by accident. Use Open WriteHuman Chrome on Active Source.',
      });
    }
    const account = primaryAccount(await ProxyAccount.find({ tool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });

    // Default the target to the ACTIVE SOURCE — the only sensible default — but validate it like
    // any other, and let the caller name a device explicitly.
    const deviceId = body.deviceId || (account.activeSource && account.activeSource.deviceId);
    if (!deviceId) return res.status(409).json({ ok: false, code: agentCommands.CODES.NO_ACTIVE_SOURCE, error: 'No active source to send this to.' });
    const t = agentCommands.validateTarget(account, deviceId, {
      requireActiveSource: !body.deviceId, requireOnline: true, requireCommandSupport: true,
      staleMs: AGENT_STALE_MIN * 60000,
    });
    if (!t.ok) return res.status(409).json({ ok: false, code: t.code, error: t.message });

    const q = agentCommands.enqueue(account, { type: command, tool, device: t.device, issuedBy: String(req.userId || '') });
    if (!q.ok) return res.status(400).json({ ok: false, code: q.code });
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_AGENT_COMMAND_QUEUED', {
      tool, accountId: account._id, command, deviceId: t.device.deviceId, commandId: q.command.id, ip: getClientIp(req),
    });
    return res.json({ ok: true, queued: command, commandId: q.command.id, targetDeviceId: t.device.deviceId, targetDeviceName: t.device.name || null });
  } catch (err) {
    console.error('Proxy agent-command error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to queue command' });
  }
});

// ── Paired sync devices ───────────────────────────────────────────────────────
// The operator can keep the SAME authorized account signed in on several machines (local PC,
// RDP-01, ...). Each runs the agent; whichever supplies the newest VERIFIED bundle becomes the
// active source on its own. These routes only manage pairing — they never expose cookies, keys,
// or the full account email.
router.get('/:tool/devices', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.json({ ok: true, devices: [], activeSource: null });
    const staleMs = AGENT_STALE_MIN * 60000;
    const activeId = account.activeSource && account.activeSource.deviceId;
    return res.json({
      ok: true,
      devices: deviceSync.getDevices(account).map((d) => {
        const st = deviceState.stateOf(account, d, { staleMs });
        return Object.assign(deviceSync.publicDevice(d, activeId, staleMs), {
          state: st.state, stateReason: st.reason, terminal: st.terminal,
          canActivate: deviceState.canActivate(st.state),
        });
      }),
      activeSource: account.activeSource || null,
      maxDevices: deviceSync.MAX_DEVICES,
      states: deviceState.STATES,
    });
  } catch (err) {
    console.error('Proxy devices list error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load devices' });
  }
});

// Create a single-use pairing code. The code is returned ONCE, in this response only; the server
// stores just its hash. The agent redeems it at POST /api/crm/proxy/agent/:tool/pair and receives
// its own device key, which likewise is never stored in readable form.
router.post('/:tool/devices/pair-code', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });
    const active = deviceSync.getDevices(account).filter(d => d && !d.revoked).length;
    if (active >= deviceSync.MAX_DEVICES) return res.status(400).json({ ok: false, code: deviceSync.CODES.DEVICE_LIMIT_REACHED, error: 'Device limit reached — revoke a device first.' });
    const r = deviceSync.createPairingCode(account, req.body && req.body.name);
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_DEVICE_PAIR_CODE_CREATED', { tool: req.proxyTool, accountId: account._id, name: r.name, ip: getClientIp(req) });
    return res.json({ ok: true, code: r.code, name: r.name, expiresAt: r.expiresAt, ttlMinutes: Math.round(deviceSync.PAIRING_TTL_MS / 60000) });
  } catch (err) {
    console.error('Proxy pair-code error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to create pairing code' });
  }
});

// -- Agent enrolment: the browser half ---------------------------------------
// The agent starts a request and shows the operator a URL; these routes are what an authenticated
// admin uses to look at that request and approve it. All inherit requireAuth + requireAdmin from
// the router; the mutation additionally takes CSRF, because it is a state change driven from a
// browser and that is precisely the shape CSRF exists to protect.
//
// None of them ever returns the credential. The agent collects it by polling with its PKCE
// verifier, so the secret never travels through a browser, a URL, or an admin's screen.
router.get('/:tool/enrollments', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.json({ ok: true, enrollments: [] });
    const now = Date.now();
    return res.json({
      ok: true,
      enrollments: agentEnroll.list(account).map(r => agentEnroll.publicEnrollment(r, now)),
      ttlMinutes: Math.round(agentEnroll.ENROLL_TTL_MS / 60000),
    });
  } catch (err) {
    console.error('Proxy enrollments list error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load enrolment requests' });
  }
});

router.get('/:tool/enrollments/:enrollId', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });
    const rec = agentEnroll.find(account, req.params.enrollId);
    if (!rec) return res.status(404).json({ ok: false, code: 'ENROLLMENT_UNKNOWN' });
    return res.json({ ok: true, enrollment: agentEnroll.publicEnrollment(rec) });
  } catch (err) {
    console.error('Proxy enrollment get error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load the enrolment request' });
  }
});

router.post('/:tool/enrollments/:enrollId/authorize', requireCsrf, async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });
    const r = agentEnroll.authorize(account, req.params.enrollId, req.userId);
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code });
    await account.save();
    // Audited without secrets: which request, which machine, approved by whom.
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_AGENT_ENROLLMENT_AUTHORIZED', {
      tool: req.proxyTool, accountId: account._id, enrollId: req.params.enrollId,
      name: r.record.name, hostname: r.record.hostname, ip: getClientIp(req),
    });
    return res.json({
      ok: true, code: r.code,
      enrollment: agentEnroll.publicEnrollment(r.record),
      note: 'The agent picks up its credential within a few seconds. Nothing needs to be copied.',
    });
  } catch (err) {
    console.error('Proxy enrollment authorize error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to authorize the device' });
  }
});

// ── "Mark active" — ONE transaction that actually moves the session ───────────
//
// WHAT THIS USED TO BE, AND WHY IT DID NOTHING
// --------------------------------------------
// It set a single field, `account.activeSourceIntent`, and returned. Nothing was ever sent to the
// device. The server then waited for that machine to push cookies of its own accord and, if it
// ever did, spent the intent. Two failures followed directly from that design:
//
//   • On a newly installed RDP the click had no visible effect whatsoever, and the request expired
//     15 minutes later. The UI, having no stage to show, showed "syncing" indefinitely.
//   • In the commonest case of all — the same WriteHuman login already signed in on the new
//     machine — it could NEVER work: the candidate's cookie hash equalled the live bundle's, so the
//     ingest answered COOKIE_BUNDLE_UNCHANGED before the intent was consulted at all.
//
// WHAT IT IS NOW
// --------------
// A transaction with an id, a one-time nonce, an expiry and observable stages. It validates the
// target, opens the transaction, and mints a `capture-and-activate` command addressed to that ONE
// device — which is what makes the device go and capture its own session instead of the server
// hoping it will. The switch still only happens after that capture VERIFIES against the expected
// account, so an offline or signed-out machine can never become active in name only.
//
// CSRF-gated, like every other state change driven from a browser. It was not, which was an
// inconsistency with open-chrome and agent-command rather than a deliberate exemption.
router.post('/:tool/devices/:deviceId/make-active', requireCsrf, async (req, res) => {
  try {
    const tool = req.proxyTool;
    const account = primaryAccount(await ProxyAccount.find({ tool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });

    const staleMs = AGENT_STALE_MIN * 60000;
    const dev = deviceSync.findDevice(account, req.params.deviceId);
    if (!dev) return res.status(404).json({ ok: false, code: deviceSync.CODES.DEVICE_UNKNOWN, error: 'That device is not paired with this account.' });

    // 1. The device must be in a state that can BE activated: READY or STANDBY. Every other state
    //    gets its own reason rather than a generic refusal, because "why can I not activate this"
    //    is the question the operator is actually asking.
    const st = deviceState.stateOf(account, dev, { staleMs });
    if (st.state === 'ACTIVE') {
      return res.status(409).json({ ok: false, code: 'ALREADY_ACTIVE', error: (dev.name || 'That device') + ' is already the active source.' });
    }
    if (!deviceState.canActivate(st.state)) {
      return res.status(409).json({ ok: false, code: 'DEVICE_' + st.state, state: st.state, error: st.reason });
    }

    // 2. …and it must be addressable: online, holding a per-agent credential, not superseded, and
    //    running an agent new enough to actually run the capture. `validateTarget` deliberately
    //    does NOT require the active source here — activating a non-active device is the point.
    const t = agentCommands.validateTarget(account, dev.deviceId, {
      requireActiveSource: false, requireOnline: true, requireCommandSupport: true,
      requireActivationSupport: true, staleMs,
    });
    if (!t.ok) return res.status(409).json({ ok: false, code: t.code, error: t.message, state: st.state });

    // 3. Open the transaction, then address the capture command to that device and nobody else.
    const act = activation.create(account, {
      device: t.device, issuedBy: String(req.userId || ''),
    });
    if (!act.ok) return res.status(409).json({ ok: false, code: act.code, error: 'Could not start the activation.' });

    const q = agentCommands.enqueue(account, {
      type: 'capture-and-activate', tool, device: t.device, issuedBy: String(req.userId || ''),
      reason: 'admin_mark_active',
      activationId: act.activation.activationId,
      activationNonce: act.activation.nonce,
      // The command must outlive a slow Chrome start, so it shares the activation's window rather
      // than the shorter default command TTL.
      ttlMs: Math.max(60000, new Date(act.activation.expiresAt).getTime() - Date.now()),
    });
    if (!q.ok) {
      activation.fail(account, { activationId: act.activation.activationId, code: q.code, message: 'Could not queue the capture command.' });
      await account.save();
      return res.status(400).json({ ok: false, code: q.code, error: 'Could not queue the capture command.' });
    }
    activation.attachCommand(account, act.activation.activationId, q.command.id);
    await account.save();

    await ActivityLog.log('ADMIN', req.userId, 'PROXY_DEVICE_MAKE_ACTIVE', {
      tool, accountId: account._id, deviceId: dev.deviceId,
      activationId: act.activation.activationId, commandId: q.command.id,
      previousDeviceId: act.activation.previousDeviceId, ip: getClientIp(req),
    });

    return res.json({
      ok: true,
      activation: activation.publicView(account, { deviceOffline: false }),
      targetDeviceId: dev.deviceId,
      targetDeviceName: dev.name || null,
      commandId: q.command.id,
      note: 'Queued for ' + (dev.name || dev.deviceId) + ' only. That machine captures and verifies its own WriteHuman session; the current session keeps serving until the capture passes.',
    });
  } catch (err) {
    console.error('Proxy make-active error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to start the activation' });
  }
});

// Live activation progress. The dashboard polls this so it can render the REAL stage — waiting for
// the agent, opening Chrome, waiting for a signed-in session, capturing, verifying, promoting —
// instead of an indefinite "syncing".
router.get('/:tool/activation', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.json({ ok: true, activation: null, log: [] });
    const staleMs = AGENT_STALE_MIN * 60000;
    const live = activation.current(account);
    const target = live ? deviceSync.findDevice(account, live.targetDeviceId) : null;
    const view = activation.publicView(account, { deviceOffline: target ? !deviceSync.isOnline(target, staleMs) : false });
    // `current()` expires a stale transaction in place, so a read can legitimately need to persist.
    if (live && live.stage === 'EXPIRED' && !live.persisted) { live.persisted = true; await account.save(); }
    return res.json({ ok: true, activation: view, log: activation.publicLog(account) });
  } catch (err) {
    console.error('Proxy activation status error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load the activation status' });
  }
});

// Abandon a running activation. Nothing is promoted, the previous source keeps the session, and the
// queued capture command is dropped so the target machine does not act on it later.
router.post('/:tool/activation/cancel', requireCsrf, async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });
    const live = activation.inFlight(account);
    if (!live) return res.status(409).json({ ok: false, code: activation.CODES.NO_ACTIVATION, error: 'No activation is running.' });
    agentCommands.purgeForDevice(account, live.targetDeviceId, 'activation_cancelled');
    activation.fail(account, { activationId: live.activationId, code: 'CANCELLED_BY_ADMIN', message: 'Cancelled by an admin. The previous active source and session are unchanged.' });
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACTIVATION_CANCELLED', { tool: req.proxyTool, accountId: account._id, activationId: live.activationId, ip: getClientIp(req) });
    return res.json({ ok: true, activation: activation.publicView(account) });
  } catch (err) {
    console.error('Proxy activation cancel error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to cancel the activation' });
  }
});

// Revoke a device's right to WRITE. This never deletes the stored cookie bundle: a revoked device
// loses its key, not the session it previously supplied. Revoking the CURRENT active source is
// refused unless another paired device could take over, or `force` is passed explicitly.
router.delete('/:tool/devices/:deviceId', async (req, res) => {
  try {
    const account = primaryAccount(await ProxyAccount.find({ tool: req.proxyTool }));
    if (!account) return res.status(404).json({ ok: false, error: 'No account' });
    const force = req.query.force === '1' || req.query.force === 'true';
    const r = deviceSync.revokeDevice(account, req.params.deviceId, { force });
    if (!r.ok) return res.status(r.code === deviceSync.CODES.DEVICE_UNKNOWN ? 404 : 409).json({ ok: false, code: r.code, error: r.message || r.code });
    // A machine that has just lost the right to write must not still be holding an instruction —
    // drop its queued commands in the same breath as the revoke. That includes a live
    // capture-and-activate: a revoked device sitting on an activation capability could otherwise
    // still promote a bundle after losing the right to write anything at all.
    const purged = agentCommands.purgeForDevice(account, req.params.deviceId, 'device_revoked');
    const activationCancelled = activation.cancelForDevice(account, req.params.deviceId, 'The target device was revoked.');
    // ...and the account must not go on naming it as the active source. That contradiction is
    // exactly what happened when an operator revoked the source to switch machines: the pointer
    // stayed, so the dashboard showed a revoked device as "active source" while its heartbeats
    // 403'd. The stored BUNDLE is untouched — revoking a device never signs anyone out.
    let activeSourceCleared = false;
    if (account.activeSource && account.activeSource.deviceId === req.params.deviceId) {
      account.activeSource = Object.assign({}, account.activeSource, { revokedAt: new Date(), stale: true });
      activeSourceCleared = true;
    }
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_DEVICE_REVOKED', { tool: req.proxyTool, accountId: account._id, deviceId: req.params.deviceId, force, purgedCommands: purged, activeSourceCleared, activationCancelled, ip: getClientIp(req) });
    return res.json({ ok: true, code: r.code, bundlePreserved: true, purgedCommands: purged, activeSourceCleared, activationCancelled });
  } catch (err) {
    console.error('Proxy device revoke error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to revoke device' });
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

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
const { verifyAccountCookies, maskEmail, applySupabaseRefresh } = require('../../utils/proxy/verify');
const { normalizeCookieBundle, buildCookieHeader, countCookies, cookieNames, hasSessionCookie } = require('../../utils/proxy/cookies');
const { unavailableReason, selectAccount } = require('../../utils/proxy/accountSelect');

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
  }),
  updateClient: Joi.object({
    planName: Joi.string().max(120).allow('', null),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled'),
    notes: Joi.string().max(500).allow('', null),
    leaseMinutes: Joi.number().integer().min(1).max(1440).allow(null),
  }).min(1),
  createAccount: Joi.object({
    label: Joi.string().min(1).max(120).required(),
    sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).allow(null),
    expectedIdentifier: Joi.string().max(160).allow('', null),
    status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked').default('active'),
    priority: Joi.number().integer().min(0).max(100000).default(100),
    isPrimary: Joi.boolean().default(false),
    notes: Joi.string().max(500).allow('', null),
  }),
  updateAccount: Joi.object({
    label: Joi.string().min(1).max(120),
    expectedIdentifier: Joi.string().max(160).allow('', null),
    status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked'),
    priority: Joi.number().integer().min(0).max(100000),
    isPrimary: Joi.boolean(),
    notes: Joi.string().max(500).allow('', null),
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
    const { userId, planName, expiryDate, status, notes, leaseMinutes } = req.body;
    const user = await User.findById(userId).select('role');
    if (!user || user.role !== 'CLIENT') return res.status(400).json({ error: 'Target user must be an existing CRM client' });
    const existing = await ProxyClient.findOne({ userId, tool: req.proxyTool });
    if (existing) return res.status(400).json({ error: 'This client already has access to this tool' });

    const pc = await ProxyClient.create({
      tool: req.proxyTool, userId,
      planName: planName || (tools.publicInfo(req.proxyTool) || {}).name || '',
      expiryDate: expiryDate || null,
      status: status || 'active',
      notes: notes || '',
      leaseMinutes: leaseMinutes ?? null,
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
function buildSessionMeta(tool, bundle) {
  const host = tools.targetHost(tool);
  const ls = bundle && bundle.localStorage;
  return {
    cookieCount: Array.isArray(bundle && bundle.cookies) ? bundle.cookies.length : 0,
    attachableCount: countCookies(bundle, host),
    hasSessionCookie: hasSessionCookie(bundle),
    hasLocalStorage: !!(ls && typeof ls === 'object' && Object.keys(ls).length > 0),
    origin: (bundle && bundle.origin) || '',
    updatedAt: new Date(),
  };
}

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
    // Remember who the vault thought this account was BEFORE the update so we can warn if
    // the "new" cookies resolve to the very same (old) account — the #1 real-world cause of
    // "I updated the cookies but the client still shows the old account": the cookies were
    // exported from a browser still logged into the old account.
    const prevMaskedId = account.verification?.maskedId || null;

    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
    account.sessionMeta = buildSessionMeta(req.proxyTool, bundle);
    if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
    account.session_status = 'pending_verification';
    await account.save();

    // Cookies were just REPLACED. Any in-flight lease bound to this account is still
    // serving the OLD session (the gateway caches the decrypted bundle per-lease for up
    // to 60s, and an open lease keeps the old account until it expires). Revoke those
    // leases so the next open mints a FRESH lease (new jti → gateway cache miss → re-fetch
    // of the new bundle) and re-runs account selection. This is what makes the new account
    // take effect immediately instead of after the lease/cache window. No gateway restart
    // needed; the gateway re-validates leases on navigation and blocks revoked ones.
    let revokedLeases = 0;
    try {
      const r = await ProxyLease.updateMany(
        { accountId: account._id, revoked: false },
        { $set: { revoked: true, revokedReason: 'session_refreshed', revokedAt: new Date() } }
      );
      revokedLeases = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
    } catch (_) { /* non-fatal: cookies are saved; stale lease self-heals within ~60s */ }

    // ── Auto-verify the just-saved cookies (immediate, safe feedback) ──────────
    // Hit the tool live with ONLY the new bundle and report whose account it actually is
    // (masked) so the admin sees at save time "this is still the OLD account" instead of
    // discovering it on the client. Best-effort; cookies are saved regardless. No secrets.
    let verifyResult = null, warning = null;
    const host = tools.targetHost(req.proxyTool);
    const names = cookieNames(bundle, host);
    try {
      const cookieHeader = buildCookieHeader(bundle, host);
      // A bundle with no attachable cookie, or no recognizable session/auth cookie at all,
      // cannot log in — this is the "missing httpOnly session cookie" case (a manual export
      // that dropped the httpOnly session cookie). Never mark it working/available; tell the
      // admin exactly what's wrong and steer them to capture-via-proxy (which DOES grab
      // httpOnly cookies). No upstream call needed.
      if (!cookieHeader || !hasSessionCookie(bundle)) {
        account.verification = { result: 'missing_required_session_cookie', maskedId: null, httpStatus: 0, checkedAt: new Date() };
        account.status = 'session_expired'; account.session_status = 'missing_required_session_cookie';
        verifyResult = 'missing_required_session_cookie'; warning = 'missing_required_session_cookie';
      } else {
        const v = await verifyAccountCookies(req.proxyTool, cookieHeader, account.expectedIdentifier);
        account.verification = { result: v.result, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: new Date() };
        account.lastVerifiedAt = new Date();
        if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = v.loggedOut ? 'needs_login' : 'session_expired'; }
        else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
        else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
        else if (v.result === 'unsupported') { account.status = 'blocked'; account.session_status = 'cookies_invalid'; }
        verifyResult = v.result;
        if (v.maskedId && prevMaskedId && v.maskedId === prevMaskedId) warning = 'cookies_match_previous_account';
        else if (v.result === 'wrong_account') warning = 'cookies_wrong_account';
        else if (v.result === 'session_expired') warning = v.loggedOut ? 'needs_login' : 'session_expired';
      }
      await account.save();
    } catch (_) { /* verify is best-effort; the cookies are already saved + leases revoked */ }

    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_SESSION_REFRESHED', { tool: req.proxyTool, accountId: account._id, label: account.label, revokedLeases, verifyResult, warning, cookieCount: names.length, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account), revokedLeases, verifyResult, warning, sessionStatus: account.session_status, maskedIdentifier: account.verification?.maskedId || null, cookieNames: names });
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

    const host = tools.targetHost(req.proxyTool);
    let bundle = null, cookieHeader = '';
    try { bundle = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)); cookieHeader = buildCookieHeader(bundle, host); } catch (_) {}
    const cookie_count = countCookies(bundle, host);
    const names = cookieNames(bundle, host);

    // No attachable cookie, or no recognizable session/auth cookie → can't log in.
    // Distinguish "missing required session cookie" from a generic expiry so the admin
    // knows the bundle is incomplete (httpOnly session cookie was not captured).
    if (!cookieHeader || !hasSessionCookie(bundle)) {
      const code = 'missing_required_session_cookie';
      account.verification = { result: code, maskedId: null, httpStatus: 0, checkedAt: new Date() };
      account.status = 'session_expired';
      account.session_status = code;
      account.lastVerifiedAt = new Date();
      await account.save();
      console.log('[proxy] ' + JSON.stringify({ evt: 'verify', tool: req.proxyTool, account_id: account._id, cookie_count, has_session_cookie: false, upstream_status: 0 }));
      return res.json({ success: true, account: presentAccount(account), result: code, cookieNames: names });
    }

    const v = await verifyAccountCookies(req.proxyTool, cookieHeader, account.expectedIdentifier);
    console.log('[proxy] ' + JSON.stringify({ evt: 'verify', tool: req.proxyTool, account_id: account._id, cookie_count, upstream_status: v.httpStatus, final_path: v.finalPath, redirected_to_sign_in: v.redirectedToSignIn, logged_out: !!v.loggedOut }));

    // session_expired splits into needs_login (a logged-out shell loaded) vs plain expiry.
    const effResult = (v.result === 'session_expired' && v.loggedOut) ? 'needs_login' : v.result;
    account.verification = { result: effResult, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: new Date() };
    account.lastVerifiedAt = new Date();
    if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = v.loggedOut ? 'needs_login' : 'session_expired'; }
    else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
    else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
    // The tool is behind an anti-bot challenge a proxy can't pass → mark blocked so it is
    // never auto-selected for a client (who would just hit the "unsupported" page); the
    // recorded verification.result='unsupported' tells the admin exactly why.
    else if (v.result === 'unsupported') { account.status = 'blocked'; }
    else if (v.result === 'unknown') { if (account.session_status === 'session_expired') account.session_status = 'pending_verification'; }

    // WriteHuman (supabase_refresh): a successful verify ROTATED the session. Persist the
    // refreshed tokens back into the stored cookie bundle so the account stays live and the
    // admin never has to re-export — exactly "auto-refresh/update the stored session and keep
    // Working". Fail-safe: only when the cookie round-trips cleanly (else leave it untouched).
    // refreshedSession is only ever set for supabase_refresh, so no other tool is affected.
    if (v.result === 'working' && v.refreshedSession && bundle) {
      try {
        const ref = (tools.supabaseConfig(req.proxyTool) || {}).projectRef;
        const updated = applySupabaseRefresh(bundle, ref, v.refreshedSession);
        if (updated) {
          account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(updated));
          account.sessionMeta = Object.assign({}, account.sessionMeta || {}, { updatedAt: new Date() });
        }
      } catch (_) { /* persist is best-effort; verify result still stands */ }
    }

    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_VERIFIED', { tool: req.proxyTool, accountId: account._id, label: account.label, result: effResult, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account), result: effResult, cookieNames: names });
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

module.exports = router;

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
const { verifyAccountCookies, maskEmail } = require('../../utils/proxy/verify');
const { normalizeCookieBundle, buildCookieHeader, countCookies, hasSessionCookie } = require('../../utils/proxy/cookies');
const { unavailableReason } = require('../../utils/proxy/accountSelect');

const LEASE_MINUTES = 30;

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
  }),
  updateClient: Joi.object({
    planName: Joi.string().max(120).allow('', null),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled'),
    notes: Joi.string().max(500).allow('', null),
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
    const { userId, planName, expiryDate, status, notes } = req.body;
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
    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
    account.sessionMeta = buildSessionMeta(req.proxyTool, bundle);
    if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
    account.session_status = 'pending_verification';
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_SESSION_REFRESHED', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
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

    if (!cookieHeader) {
      account.verification = { result: 'session_expired', maskedId: null, httpStatus: 0, checkedAt: new Date() };
      account.status = 'session_expired';
      account.session_status = 'session_expired';
      account.lastVerifiedAt = new Date();
      await account.save();
      console.log('[proxy] ' + JSON.stringify({ evt: 'verify', tool: req.proxyTool, account_id: account._id, cookie_count, has_session_cookie: false, upstream_status: 0, redirected_to_sign_in: true }));
      return res.json({ success: true, account: presentAccount(account), result: 'session_expired' });
    }

    const v = await verifyAccountCookies(req.proxyTool, cookieHeader, account.expectedIdentifier);
    console.log('[proxy] ' + JSON.stringify({ evt: 'verify', tool: req.proxyTool, account_id: account._id, cookie_count, upstream_status: v.httpStatus, final_path: v.finalPath, redirected_to_sign_in: v.redirectedToSignIn }));

    account.verification = { result: v.result, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: new Date() };
    account.lastVerifiedAt = new Date();
    if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = 'session_expired'; }
    else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
    else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
    else if (v.result === 'unknown') { if (account.session_status === 'session_expired') account.session_status = 'pending_verification'; }

    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_ACCOUNT_VERIFIED', { tool: req.proxyTool, accountId: account._id, label: account.label, result: v.result, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account), result: v.result });
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
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + LEASE_MINUTES * 60 * 1000);
    const leaseRow = await ProxyLease.create({
      tool: req.proxyTool, userId: req.userId, proxyClientId: null, accountId: account._id, accountLabel: account.label,
      issuedAt, expiresAt, revoked: false, capture: true, ip: getClientIp(req), userAgent: req.headers['user-agent'] || '',
    });
    const token = leaseUtil.signLease({ jti: leaseRow._id, userId: req.userId, tool: req.proxyTool, accountId: account._id, ttlMinutes: LEASE_MINUTES, capture: true });
    leaseRow.tokenHash = leaseUtil.hashToken(token);
    await leaseRow.save();
    await ActivityLog.log('ADMIN', req.userId, 'PROXY_CAPTURE_LEASE', { tool: req.proxyTool, accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, url: leaseUtil.gatewayUrl(req.proxyTool, token), expiresAt, ttlMinutes: LEASE_MINUTES });
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

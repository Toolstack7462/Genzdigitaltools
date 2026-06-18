'use strict';
/**
 * Admin routes for the StealthWriter Proxy Gateway module.
 * Mounted at /api/crm/admin/stealth — isolated from core admin routes.
 *
 * Capabilities: manage StealthWriter clients (plan, daily humanizer / AI-detector
 * limits, expiry, status), reset usage, view usage logs, view active 30-minute
 * leases, revoke leases, and configure the module (lease duration, fixed-lease toggle).
 */
const express = require('express');
const Joi = require('joi');
const router = express.Router();

const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const StealthClient = require('../../models/stealth/StealthClient');
const StealthLease = require('../../models/stealth/StealthLease');
const StealthUsageLog = require('../../models/stealth/StealthUsageLog');
const StealthAccount = require('../../models/stealth/StealthAccount');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate } = require('../../middleware/validation');
const access = require('../../utils/stealth/access');
const config = require('../../utils/stealth/config');
const vaultCrypto = require('../../utils/stealth/vaultCrypto');
const { verifyAccountCookies, maskEmail } = require('../../utils/stealth/verify');
const { normalizeCookieBundle, buildCookieHeader, countCookies, hasSessionCookie } = require('../../utils/stealth/cookies');
const { unavailableReason } = require('../../utils/stealth/accountSelect');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');

const TARGET_HOST = (() => {
  try { return new URL(process.env.STEALTH_TARGET_ORIGIN || 'https://stealthwriter.ai').hostname; }
  catch (_) { return 'stealthwriter.ai'; }
})();

router.use(requireAuth);
router.use(requireAdmin);

// ─── Validation schemas (isolated; not added to the shared schema bag) ──────────
const schemas = {
  createClient: Joi.object({
    userId: Joi.string().required(),
    planName: Joi.string().max(120).allow('', null),
    dailyHumanizerLimit: Joi.number().integer().min(-1).max(1000000).default(50),
    dailyDetectorLimit: Joi.number().integer().min(-1).max(1000000).default(50),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled').default('active'),
    notes: Joi.string().max(500).allow('', null),
  }),
  updateClient: Joi.object({
    planName: Joi.string().max(120).allow('', null),
    dailyHumanizerLimit: Joi.number().integer().min(-1).max(1000000),
    dailyDetectorLimit: Joi.number().integer().min(-1).max(1000000),
    expiryDate: Joi.date().iso().allow(null),
    status: Joi.string().valid('active', 'disabled'),
    notes: Joi.string().max(500).allow('', null),
  }).min(1),
  settings: Joi.object({
    leaseDurationMinutes: Joi.number().integer().min(1).max(720),
    fixedLeaseEnabled: Joi.boolean(),
    maxSessionMinutes: Joi.number().integer().min(5).max(1440),
    accountSelectionMode: Joi.string().valid('manual_primary', 'auto_failover', 'round_robin', 'least_used'),
  }).min(1),
  createAccount: Joi.object({
    label: Joi.string().min(1).max(120).required(),
    // The cookie bundle is accepted as a JSON object or a JSON string; it is
    // encrypted at rest immediately and never returned. Optional at create time.
    sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).allow(null),
    // Optional expected login (e.g. email) used only to flag "wrong account" on verify.
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
  accountSession: Joi.object({
    sessionBundle: Joi.alternatives(Joi.object(), Joi.string()).required(),
  }),
  accountStatus: Joi.object({
    status: Joi.string().valid('active', 'standby', 'limit_reached', 'session_expired', 'blocked').required(),
  }),
};

function safePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Build the admin-facing view of a StealthClient: snapshot + linked user info.
async function presentClient(client) {
  const snap = await access.snapshot(client);
  const user = await User.findById(client.userId).select('fullName email status');
  const activeLeases = (await StealthLease.find({ stealthClientId: client._id, revoked: false }))
    .filter(l => l.isActive());
  return {
    id: client._id,
    userId: client.userId,
    user: user ? { id: user._id, fullName: user.fullName, email: user.email, status: user.status } : null,
    planName: client.planName,
    status: client.status,
    expiryDate: client.expiryDate || null,
    notes: client.notes || '',
    limits: snap.limits,
    used: snap.used,
    remaining: snap.remaining,
    expired: snap.expired,
    activeLeaseCount: activeLeases.length,
    resetLabel: RESET_LABEL,
    nextResetAt: nextResetAt(),
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

// ─── Settings ───────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    return res.json({ success: true, settings: await config.getSettingsObject(), resetLabel: RESET_LABEL });
  } catch (err) {
    console.error('Stealth get settings error:', err.message);
    return res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/settings', validate(schemas.settings), async (req, res) => {
  try {
    const settings = await config.updateSettings(req.body, req.userId);
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_SETTINGS_UPDATED', { changes: req.body, ip: getClientIp(req) });
    return res.json({ success: true, settings });
  } catch (err) {
    console.error('Stealth update settings error:', err.message);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const clients = await StealthClient.find({});
    const activeLeases = (await StealthLease.find({ revoked: false })).filter(l => l.isActive());
    const totalClients = clients.length;
    const activeClients = clients.filter(c => c.status === 'active').length;
    const expiredClients = clients.filter(c => c.expiryDate && new Date(c.expiryDate).getTime() <= Date.now()).length;
    return res.json({
      success: true,
      stats: { totalClients, activeClients, expiredClients, activeLeases: activeLeases.length },
    });
  } catch (err) {
    console.error('Stealth stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── List clients ───────────────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = safePagination(req.query);
    const query = {};
    if (status === 'active' || status === 'disabled') query.status = status;

    const all = await StealthClient.find(query).sort({ createdAt: -1 });
    const totalCount = all.length;
    const pageItems = all.slice(skip, skip + limit);
    const clients = await Promise.all(pageItems.map(presentClient));

    // Optional text search across linked user fields (post-presentation).
    let filtered = clients;
    if (req.query.search) {
      const term = String(req.query.search).toLowerCase().slice(0, 100);
      filtered = clients.filter(c =>
        (c.user?.email || '').toLowerCase().includes(term) ||
        (c.user?.fullName || '').toLowerCase().includes(term) ||
        (c.planName || '').toLowerCase().includes(term));
    }

    return res.json({
      success: true,
      clients: filtered,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + pageItems.length < totalCount },
    });
  } catch (err) {
    console.error('Stealth list clients error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch StealthWriter clients' });
  }
});

// ─── Get one client (detail + recent usage + leases) ────────────────────────
router.get('/clients/:id', async (req, res) => {
  try {
    const client = await StealthClient.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'StealthWriter client not found' });

    const [presented, usageLogs, leases] = await Promise.all([
      presentClient(client),
      StealthUsageLog.find({ stealthClientId: client._id }).sort({ createdAt: -1 }).limit(50),
      StealthLease.find({ stealthClientId: client._id }).sort({ createdAt: -1 }).limit(20),
    ]);
    const now = Date.now();
    const leaseView = leases.map(l => ({
      id: l._id, issuedAt: l.issuedAt, expiresAt: l.expiresAt, revoked: l.revoked,
      revokedReason: l.revokedReason || null, fixedLease: l.fixedLease,
      active: !l.revoked && new Date(l.expiresAt).getTime() > now,
      accountLabel: l.accountLabel || null, // which internal account this lease used (label only)
      ip: l.ip || null, userAgent: l.userAgent || null,
    }));
    return res.json({ success: true, client: presented, usageLogs, leases: leaseView });
  } catch (err) {
    console.error('Stealth get client error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch StealthWriter client' });
  }
});

// ─── Create client (link an existing CRM client) ────────────────────────────
router.post('/clients', validate(schemas.createClient), async (req, res) => {
  try {
    const { userId, planName, dailyHumanizerLimit, dailyDetectorLimit, expiryDate, status, notes } = req.body;

    const user = await User.findById(userId).select('fullName email role');
    if (!user || user.role !== 'CLIENT') return res.status(400).json({ error: 'Target user must be an existing CRM client' });

    const existing = await StealthClient.findOne({ userId });
    if (existing) return res.status(400).json({ error: 'This client already has a StealthWriter plan' });

    const client = await StealthClient.create({
      userId,
      planName: planName || 'StealthWriter',
      dailyHumanizerLimit, dailyDetectorLimit,
      expiryDate: expiryDate || null,
      status: status || 'active',
      notes: notes || '',
      createdBy: req.userId,
      usage: { humanizerUsed: 0, detectorUsed: 0, lastResetAt: new Date() },
    });

    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_CLIENT_CREATED', { stealthClientId: client._id, userId, ip: getClientIp(req) });
    return res.status(201).json({ success: true, client: await presentClient(client) });
  } catch (err) {
    console.error('Stealth create client error:', err.message);
    return res.status(500).json({ error: 'Failed to create StealthWriter client' });
  }
});

// ─── Update client ───────────────────────────────────────────────────────────
router.put('/clients/:id', validate(schemas.updateClient), async (req, res) => {
  try {
    const client = await StealthClient.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'StealthWriter client not found' });

    const fields = ['planName', 'dailyHumanizerLimit', 'dailyDetectorLimit', 'status', 'notes'];
    for (const f of fields) if (req.body[f] !== undefined) client[f] = req.body[f];
    if (req.body.expiryDate !== undefined) client.expiryDate = req.body.expiryDate || null;

    await client.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_CLIENT_UPDATED', { stealthClientId: client._id, changes: req.body, ip: getClientIp(req) });
    return res.json({ success: true, client: await presentClient(client) });
  } catch (err) {
    console.error('Stealth update client error:', err.message);
    return res.status(500).json({ error: 'Failed to update StealthWriter client' });
  }
});

// ─── Reset usage now ─────────────────────────────────────────────────────────
router.post('/clients/:id/reset-usage', async (req, res) => {
  try {
    const client = await StealthClient.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'StealthWriter client not found' });
    client.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: new Date() };
    await client.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_USAGE_RESET', { stealthClientId: client._id, ip: getClientIp(req) });
    return res.json({ success: true, client: await presentClient(client), message: 'Usage reset' });
  } catch (err) {
    console.error('Stealth reset usage error:', err.message);
    return res.status(500).json({ error: 'Failed to reset usage' });
  }
});

// ─── Revoke all active leases for a client ───────────────────────────────────
router.post('/clients/:id/revoke-leases', async (req, res) => {
  try {
    const client = await StealthClient.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'StealthWriter client not found' });
    const { modifiedCount } = await StealthLease.updateMany(
      { stealthClientId: client._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'admin_revoked', revokedAt: new Date() } }
    );
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_LEASES_REVOKED', { stealthClientId: client._id, count: modifiedCount, ip: getClientIp(req) });
    return res.json({ success: true, revoked: modifiedCount });
  } catch (err) {
    console.error('Stealth revoke leases error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke leases' });
  }
});

// ─── Revoke a single lease ───────────────────────────────────────────────────
router.post('/leases/:leaseId/revoke', async (req, res) => {
  try {
    const lease = await StealthLease.findById(req.params.leaseId);
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    if (!lease.revoked) {
      lease.revoked = true;
      lease.revokedReason = 'admin_revoked';
      lease.revokedAt = new Date();
      await lease.save();
    }
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_LEASE_REVOKED', { leaseId: lease._id, ip: getClientIp(req) });
    return res.json({ success: true });
  } catch (err) {
    console.error('Stealth revoke lease error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke lease' });
  }
});

// ─── Delete client ───────────────────────────────────────────────────────────
router.delete('/clients/:id', async (req, res) => {
  try {
    const client = await StealthClient.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'StealthWriter client not found' });
    await StealthLease.deleteMany({ stealthClientId: client._id });
    await client.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_CLIENT_DELETED', { stealthClientId: client._id, ip: getClientIp(req) });
    return res.json({ success: true, message: 'StealthWriter client deleted' });
  } catch (err) {
    console.error('Stealth delete client error:', err.message);
    return res.status(500).json({ error: 'Failed to delete StealthWriter client' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STEALTHWRITER ACCOUNT VAULT (admin-only, multi-account)
// Stores the operator's OWN StealthWriter account sessions, encrypted at rest.
// Never returns or logs raw cookies/sessions/tokens.
// ════════════════════════════════════════════════════════════════════════════

// Normalize any pasted format into a canonical cookie bundle (see utils/stealth/cookies).
function normalizeBundle(input) {
  return normalizeCookieBundle(input);
}

function buildSessionMeta(bundle) {
  const ls = bundle && bundle.localStorage;
  return {
    cookieCount: Array.isArray(bundle && bundle.cookies) ? bundle.cookies.length : 0,
    attachableCount: countCookies(bundle, TARGET_HOST), // cookies that match the target host
    hasSessionCookie: hasSessionCookie(bundle),         // 1 valid session cookie is enough
    hasLocalStorage: !!(ls && typeof ls === 'object' && Object.keys(ls).length > 0),
    origin: (bundle && bundle.origin) || '',
    updatedAt: new Date(),
  };
}

function presentAccount(account, activeLeaseCount = 0) {
  return {
    id: account._id,
    label: account.label,
    status: account.status,
    isPrimary: !!account.isPrimary,
    priority: account.priority,
    usageCount: account.usageCount || 0,
    lastUsedAt: account.lastUsedAt || null,
    notes: account.notes || '',
    hasSession: !!account.sessionEncrypted,        // boolean only — never the secret
    hasSessionCookie: account.sessionMeta?.hasSessionCookie ?? !!account.sessionEncrypted,
    sessionStatus: account.session_status || 'pending_verification',
    lastVerifiedAt: account.lastVerifiedAt || null,
    sessionMeta: account.sessionMeta || { cookieCount: 0, hasSessionCookie: false, hasLocalStorage: false, origin: '', updatedAt: null },
    // Verification: safe result + masked identifier only (no cookies ever).
    verification: account.verification || null,
    maskedIdentifier: account.verification?.maskedId || (account.expectedIdentifier ? maskEmail(account.expectedIdentifier) : null),
    hasExpectedIdentifier: !!account.expectedIdentifier,
    available: unavailableReason(account) === null,
    unavailableReason: unavailableReason(account), // safe reason (no secrets) or null
    activeLeaseCount,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function activeLeaseCountsByAccount() {
  const now = Date.now();
  const leases = await StealthLease.find({ revoked: false });
  const map = {};
  for (const l of leases) {
    if (l.accountId && new Date(l.expiresAt).getTime() > now) {
      const k = String(l.accountId);
      map[k] = (map[k] || 0) + 1;
    }
  }
  return map;
}

async function clearOtherPrimaries(exceptId) {
  await StealthAccount.updateMany(
    { isPrimary: true, _id: { $ne: exceptId } },
    { $set: { isPrimary: false } }
  );
}

// ─── List accounts ────────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const accounts = (await StealthAccount.find({})).sort((a, b) =>
      (a.priority - b.priority) || (new Date(a.createdAt) - new Date(b.createdAt)));
    const counts = await activeLeaseCountsByAccount();
    return res.json({
      success: true,
      accounts: accounts.map(a => presentAccount(a, counts[String(a._id)] || 0)),
      statuses: StealthAccount.STATUSES(),
    });
  } catch (err) {
    console.error('Stealth list accounts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// ─── Create account ─────────────────────────────────────────────────────────
router.post('/accounts', validate(schemas.createAccount), async (req, res) => {
  try {
    const { label, sessionBundle, expectedIdentifier, status, priority, isPrimary, notes } = req.body;
    let sessionEncrypted, sessionMeta;
    if (sessionBundle !== undefined && sessionBundle !== null) {
      const bundle = normalizeBundle(sessionBundle);
      if (!bundle) return res.status(400).json({ error: 'Invalid session bundle' });
      sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
      sessionMeta = buildSessionMeta(bundle);
    }
    const account = await StealthAccount.create({
      label, status: status || 'active', priority: priority ?? 100, isPrimary: !!isPrimary,
      expectedIdentifier: expectedIdentifier || '',
      notes: notes || '', usageCount: 0,
      sessionEncrypted: sessionEncrypted || null,
      sessionMeta: sessionMeta || { cookieCount: 0, hasLocalStorage: false, origin: '', updatedAt: null },
      createdBy: req.userId,
    });
    if (account.isPrimary) await clearOtherPrimaries(account._id);
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_CREATED', { accountId: account._id, label, ip: getClientIp(req) });
    return res.status(201).json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Stealth create account error:', err.message);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

// ─── Update account (label / status / priority / primary / notes) ────────────
router.put('/accounts/:id', validate(schemas.updateAccount), async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    for (const f of ['label', 'status', 'priority', 'notes', 'expectedIdentifier']) if (req.body[f] !== undefined) account[f] = req.body[f];
    if (req.body.isPrimary !== undefined) account.isPrimary = !!req.body.isPrimary;
    await account.save();
    if (account.isPrimary) await clearOtherPrimaries(account._id);
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_UPDATED', { accountId: account._id, changes: { ...req.body, sessionBundle: undefined }, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Stealth update account error:', err.message);
    return res.status(500).json({ error: 'Failed to update account' });
  }
});

// ─── Refresh session (re-upload bundle, mark active) ─────────────────────────
router.post('/accounts/:id/session', validate(schemas.accountSession), async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const bundle = normalizeBundle(req.body.sessionBundle);
    if (!bundle) return res.status(400).json({ error: 'Invalid session bundle' });
    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(bundle));
    account.sessionMeta = buildSessionMeta(bundle);
    // Clear stale bad states on a fresh cookie; require re-verification.
    if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active';
    account.session_status = 'pending_verification';
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_SESSION_REFRESHED', { accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Stealth refresh session error:', err.message);
    return res.status(500).json({ error: 'Failed to refresh session' });
  }
});

// ─── Refresh Cookies Through Proxy — mint a capture lease ────────────────────
// Returns a gateway URL the admin opens to log into StealthWriter THROUGH the
// proxy; the gateway then captures the session in the proxy context and saves it
// back to this account (so cookies always work from the proxy IP/context).
router.post('/accounts/:id/capture-lease', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const settings = await config.getSettingsObject();
    const ttlMinutes = Math.min(60, settings.leaseDurationMinutes || 30);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000);
    const leaseRow = await StealthLease.create({
      userId: req.userId, stealthClientId: null, accountId: account._id, accountLabel: account.label,
      issuedAt, expiresAt, fixedLease: true, revoked: false, capture: true,
      ip: getClientIp(req), userAgent: req.headers['user-agent'] || '',
    });
    const lease = require('../../utils/stealth/lease');
    const token = lease.signLease({ jti: leaseRow._id, userId: req.userId, accountId: account._id, fixed: true, ttlMinutes, capture: true });
    leaseRow.tokenHash = lease.hashToken(token);
    await leaseRow.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_CAPTURE_LEASE', { accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, url: lease.gatewayUrl(token), expiresAt, ttlMinutes });
  } catch (err) {
    console.error('Stealth capture-lease error:', err.message);
    return res.status(500).json({ error: 'Failed to create capture lease' });
  }
});

// ─── Verify account cookies ──────────────────────────────────────────────────
// Decrypts the cookie bundle server-side, asks the StealthWriter origin whether it
// is logged in, and stores ONLY a safe result + masked identifier. Optionally syncs
// the account status. Never logs cookies.
router.post('/accounts/:id/verify', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!account.sessionEncrypted) return res.status(400).json({ error: 'No cookie bundle saved for this account' });

    let bundle = null, cookieHeader = '';
    try { bundle = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)); cookieHeader = buildCookieHeader(bundle, TARGET_HOST); } catch (_) {}
    const cookie_count = countCookies(bundle, TARGET_HOST);
    const has_session_cookie = hasSessionCookie(bundle);

    if (!cookieHeader) {
      // No attachable cookie at all → genuinely no session to test.
      account.verification = { result: 'session_expired', maskedId: null, httpStatus: 0, checkedAt: new Date() };
      account.status = 'session_expired';
      account.session_status = 'session_expired';
      account.lastVerifiedAt = new Date();
      await account.save();
      console.log('[stealth] ' + JSON.stringify({ evt: 'verify', account_id: account._id, cookie_count, has_session_cookie: false, checked_path: process.env.STEALTH_VERIFY_PATH || '/dashboard/humanizer', upstream_status: 0, final_path: null, redirected_to_sign_in: true }));
      return res.json({ success: true, account: presentAccount(account), result: 'session_expired' });
    }

    const v = await verifyAccountCookies(cookieHeader, account.expectedIdentifier);
    // Safe debug (no cookie values).
    console.log('[stealth] ' + JSON.stringify({
      evt: 'verify', account_id: account._id, cookie_count, has_session_cookie,
      checked_path: process.env.STEALTH_VERIFY_PATH || '/dashboard/humanizer',
      upstream_status: v.httpStatus, final_path: v.finalPath, redirected_to_sign_in: v.redirectedToSignIn,
    }));

    account.verification = { result: v.result, maskedId: v.maskedId || null, httpStatus: v.httpStatus, checkedAt: new Date() };
    account.lastVerifiedAt = new Date();

    // Mark expired ONLY when the dashboard actually redirected to /sign-in.
    if (v.result === 'session_expired') { account.status = 'session_expired'; account.session_status = 'session_expired'; }
    else if (v.result === 'wrong_account') { account.status = 'standby'; account.session_status = 'working'; }
    else if (v.result === 'working') { account.session_status = 'working'; if (['session_expired', 'limit_reached'].includes(account.status)) account.status = 'active'; }
    // 'unknown' (upstream unreachable/blocked): do NOT penalize — leave status as-is.
    else if (v.result === 'unknown') { if (account.session_status === 'session_expired') account.session_status = 'pending_verification'; }

    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_VERIFIED', { accountId: account._id, label: account.label, result: v.result, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account), result: v.result });
  } catch (err) {
    console.error('Stealth verify account error:', err.message);
    return res.status(500).json({ error: 'Failed to verify account' });
  }
});

// ─── Leases using this account ───────────────────────────────────────────────
router.get('/accounts/:id/leases', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const leases = (await StealthLease.find({ accountId: account._id })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    const now = Date.now();
    // Resolve client labels (no secrets) for display.
    const clientIds = [...new Set(leases.map(l => String(l.stealthClientId)))];
    const clientsById = {};
    for (const cid of clientIds) {
      const sc = await StealthClient.findById(cid);
      if (sc) { const u = await User.findById(sc.userId).select('fullName email'); clientsById[cid] = u ? (u.fullName || u.email) : cid; }
    }
    const view = leases.map(l => ({
      id: l._id, issuedAt: l.issuedAt, expiresAt: l.expiresAt, revoked: l.revoked,
      active: !l.revoked && new Date(l.expiresAt).getTime() > now,
      client: clientsById[String(l.stealthClientId)] || null,
    }));
    return res.json({ success: true, account: presentAccount(account), leases: view });
  } catch (err) {
    console.error('Stealth account leases error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch account leases' });
  }
});

// ─── Set as primary ───────────────────────────────────────────────────────────
router.post('/accounts/:id/primary', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    account.isPrimary = true;
    await account.save();
    await clearOtherPrimaries(account._id);
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_PRIMARY_SET', { accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Stealth set primary error:', err.message);
    return res.status(500).json({ error: 'Failed to set primary' });
  }
});

// ─── Set status (Mark Limit Reached / Mark Active / standby / blocked) ───────
router.post('/accounts/:id/status', validate(schemas.accountStatus), async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    account.status = req.body.status;
    await account.save();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_STATUS_SET', { accountId: account._id, label: account.label, status: account.status, ip: getClientIp(req) });
    return res.json({ success: true, account: presentAccount(account) });
  } catch (err) {
    console.error('Stealth set status error:', err.message);
    return res.status(500).json({ error: 'Failed to set status' });
  }
});

// ─── Revoke active leases bound to this account ──────────────────────────────
router.post('/accounts/:id/revoke-leases', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const { modifiedCount } = await StealthLease.updateMany(
      { accountId: account._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'account_revoked', revokedAt: new Date() } }
    );
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_LEASES_REVOKED', { accountId: account._id, label: account.label, count: modifiedCount, ip: getClientIp(req) });
    return res.json({ success: true, revoked: modifiedCount });
  } catch (err) {
    console.error('Stealth revoke account leases error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke account leases' });
  }
});

// ─── Delete account ───────────────────────────────────────────────────────────
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = await StealthAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await StealthLease.updateMany(
      { accountId: account._id, revoked: false },
      { $set: { revoked: true, revokedReason: 'account_deleted', revokedAt: new Date() } }
    );
    await account.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'STEALTH_ACCOUNT_DELETED', { accountId: account._id, label: account.label, ip: getClientIp(req) });
    return res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('Stealth delete account error:', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;

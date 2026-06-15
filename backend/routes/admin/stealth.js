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
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate } = require('../../middleware/validation');
const access = require('../../utils/stealth/access');
const config = require('../../utils/stealth/config');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');

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
  }).min(1),
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

module.exports = router;

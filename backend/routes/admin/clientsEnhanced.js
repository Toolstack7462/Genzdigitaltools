const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const ToolAssignment = require('../../models/ToolAssignment');
const DeviceBinding = require('../../models/DeviceBinding');
const RefreshToken = require('../../models/RefreshToken');
const ExtensionToken = require('../../models/ExtensionToken');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate, schemas } = require('../../middleware/validation');

router.use(requireAuth);
router.use(requireAdmin);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// FIX3: Escape regex special chars
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FIX17: Safe pagination
function safePagination(query) {
  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// ─── GET / — list clients ──────────────────────────────────────────────────────
// FIX9: Aggregation instead of N+1 queries
// FIX10: deviceLocked filter applied BEFORE pagination so totalCount is accurate
router.get('/', async (req, res) => {
  try {
    const { search, status, deviceLocked, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const { page, limit, skip } = safePagination(req.query);

    const query = { role: 'CLIENT' };

    // FIX3: Escaped search
    if (search) {
      if (String(search).length > 100) return res.status(400).json({ error: 'Search term too long (max 100 chars)' });
      const escaped = escapeRegex(search.trim());
      query.$or = [
        { fullName: { $regex: escaped, $options: 'i' } },
        { email:    { $regex: escaped, $options: 'i' } }
      ];
    }
    if (status) query.status = status;

    // FIX10: Apply deviceLocked filter BEFORE pagination using DB-level lookup
    if (deviceLocked === 'true' || deviceLocked === 'false') {
      const boundIds = await DeviceBinding.distinct('clientId');
      if (deviceLocked === 'true') {
        query._id = { $in: boundIds };
      } else {
        query._id = { $nin: boundIds };
      }
    }

    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [clients, totalCount] = await Promise.all([
      User.find(query).select('-passwordHash').sort(sort).skip(skip).limit(limit),
      User.countDocuments(query)  // FIX10: totalCount now reflects filtered results
    ]);

    if (clients.length === 0) {
      return res.json({ success: true, clients: [], pagination: { page, limit, totalCount: 0, totalPages: 0, hasMore: false } });
    }

    // FIX9: Single aggregation for assignment counts
    const clientIds = clients.map(c => c._id);
    const [assignmentAgg, deviceBindings] = await Promise.all([
      ToolAssignment.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: {
            _id: '$clientId',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }
        }}
      ]),
      DeviceBinding.find({ clientId: { $in: clientIds } }).select('clientId lastSeenAt userAgent')
    ]);

    const assignMap = Object.fromEntries(assignmentAgg.map(a => [a._id.toString(), a]));
    const deviceMap = Object.fromEntries(deviceBindings.map(d => [d.clientId.toString(), d]));

    const clientsWithData = clients.map(client => {
      const id = client._id.toString();
      const agg = assignMap[id] || { total: 0, active: 0 };
      const binding = deviceMap[id];
      return {
        ...client.toObject(),
        assignmentCount:   agg.total,
        activeAssignments: agg.active,
        isDeviceLocked: !!binding && client.devicePolicy.enabled,
        deviceInfo: binding ? { lastSeen: binding.lastSeenAt, userAgent: binding.userAgent } : null
      };
    });

    return res.json({
      success: true,
      clients: clientsWithData,
      pagination: {
        page, limit, totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: skip + clients.length < totalCount
      }
    });
  } catch (err) {
    console.error('Get clients error:', err);
    return res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// ─── GET /stats ─────────────────────────────────────────────────────────────────
// FIX16: Added recentClients and deviceLockedClients
router.get('/stats', async (req, res) => {
  try {
    const [totalClients, activeClients, disabledClients, deviceLockedCount, recentClients] = await Promise.all([
      User.countDocuments({ role: 'CLIENT' }),
      User.countDocuments({ role: 'CLIENT', status: 'active' }),
      User.countDocuments({ role: 'CLIENT', status: 'disabled' }),
      DeviceBinding.countDocuments(),
      User.find({ role: 'CLIENT' }).sort({ createdAt: -1 }).limit(5)
        .select('fullName email createdAt status')
    ]);

    return res.json({
      success: true,
      stats: {
        totalClients,
        activeClients,
        disabledClients,
        deviceLockedClients: deviceLockedCount,
        recentClients
      }
    });
  } catch (err) {
    console.error('Get client stats error:', err);
    return res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const client = await User.findById(req.params.id).select('-passwordHash');
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    const [assignments, deviceBinding, activityLogs] = await Promise.all([
      ToolAssignment.find({ clientId: client._id }).populate('toolId', 'name category status targetUrl').sort({ createdAt: -1 }),
      DeviceBinding.findOne({ clientId: client._id }),
      ActivityLog.find({ actorId: client._id }).sort({ createdAt: -1 }).limit(20)
    ]);

    return res.json({ success: true, client: client.toObject(), assignments, deviceBinding, activityLogs });
  } catch (err) {
    console.error('Get client error:', err);
    return res.status(500).json({ error: 'Failed to fetch client' });
  }
});

// ─── POST / — create client ───────────────────────────────────────────────────
router.post('/', validate(schemas.createClient), async (req, res) => {
  try {
    const { fullName, email, password, status, devicePolicyEnabled, notes } = req.body;
    const ip = getClientIp(req);

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const client = await User.create({
      fullName, email, passwordHash: password,
      role: 'CLIENT', status: status || 'active',
      devicePolicy: { enabled: devicePolicyEnabled !== false, maxDevices: 1 },
      notes
    });

    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_CREATED', { clientId: client._id, clientEmail: client.email, ip });
    return res.status(201).json({ success: true, client: client.toJSON(), message: 'Client created' });
  } catch (err) {
    console.error('Create client error:', err);
    return res.status(500).json({ error: 'Failed to create client' });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────
router.put('/:id', validate(schemas.updateClient), async (req, res) => {
  try {
    const { fullName, email, password, status, devicePolicyEnabled, notes } = req.body;
    const ip = getClientIp(req);

    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    const changes = {};
    if (fullName && fullName !== client.fullName) { changes.fullName = { from: client.fullName, to: fullName }; client.fullName = fullName; }
    if (email && email !== client.email) {
      const dup = await User.findOne({ email, _id: { $ne: client._id } });
      if (dup) return res.status(400).json({ error: 'Email already exists' });
      changes.email = { from: client.email, to: email }; client.email = email;
    }
    if (password) { changes.password = 'changed'; client.passwordHash = password; }
    if (status && status !== client.status) { changes.status = { from: client.status, to: status }; client.status = status; }
    if (devicePolicyEnabled !== undefined) {
      // Guard against legacy/partial records missing devicePolicy so toggling
      // device binding OFF/ON can never throw.
      if (!client.devicePolicy || typeof client.devicePolicy !== 'object') client.devicePolicy = { enabled: true, maxDevices: 1 };
      changes.devicePolicy = { from: client.devicePolicy.enabled, to: devicePolicyEnabled };
      client.devicePolicy.enabled = devicePolicyEnabled;
    }
    if (notes !== undefined) client.notes = notes;

    await client.save();
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_UPDATED', { clientId: client._id, clientEmail: client.email, changes, ip });
    return res.json({ success: true, client: client.toJSON(), message: 'Client updated' });
  } catch (err) {
    console.error('Update client error:', err);
    return res.status(500).json({ error: 'Failed to update client' });
  }
});

// ─── POST /:id/device-reset ───────────────────────────────────────────────────
router.post('/:id/device-reset', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    const { deletedCount } = await DeviceBinding.deleteMany({ clientId: client._id });
    const { modifiedCount: extensionTokensRevoked } = await ExtensionToken.updateMany(
      { clientId: client._id, isRevoked: false },
      { $set: { isRevoked: true } }
    );
    await ActivityLog.log('ADMIN', req.userId, 'DEVICE_RESET', {
      clientId: client._id,
      clientEmail: client.email,
      devicesRemoved: deletedCount,
      extensionTokensRevoked,
      ip
    });
    return res.json({
      success: true,
      message: `Device binding reset. ${deletedCount} device(s) removed and ${extensionTokensRevoked} extension token(s) revoked.`,
      extensionTokensRevoked
    });
  } catch (err) {
    console.error('Device reset error:', err);
    return res.status(500).json({ error: 'Failed to reset device' });
  }
});

// ─── POST /:id/force-logout ───────────────────────────────────────────────────
router.post('/:id/force-logout', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    await client.forceLogout();
    const refreshResult = await RefreshToken.updateMany(
      { userId: client._id, revokedAt: null },
      { revokedAt: new Date(), revokedByIp: ip }
    );
    const extensionResult = await ExtensionToken.updateMany(
      { clientId: client._id, isRevoked: false },
      { $set: { isRevoked: true } }
    );

    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_FORCE_LOGOUT', {
      clientId: client._id,
      clientEmail: client.email,
      refreshTokensRevoked: refreshResult.modifiedCount,
      extensionTokensRevoked: extensionResult.modifiedCount,
      ip
    });
    return res.json({
      success: true,
      message: 'Client web sessions and extension sessions revoked',
      refreshTokensRevoked: refreshResult.modifiedCount,
      extensionTokensRevoked: extensionResult.modifiedCount
    });
  } catch (err) {
    console.error('Force logout error:', err);
    return res.status(500).json({ error: 'Failed to force logout' });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    await Promise.all([
      ToolAssignment.deleteMany({ clientId: client._id }),
      DeviceBinding.deleteMany({ clientId: client._id }),
      RefreshToken.deleteMany({ userId: client._id }),
      ExtensionToken.deleteMany({ clientId: client._id })
    ]);

    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_DELETED', { clientId: client._id, clientEmail: client.email, ip });
    await client.deleteOne();
    return res.json({ success: true, message: 'Client deleted' });
  } catch (err) {
    console.error('Delete client error:', err);
    return res.status(500).json({ error: 'Failed to delete client' });
  }
});

module.exports = router;

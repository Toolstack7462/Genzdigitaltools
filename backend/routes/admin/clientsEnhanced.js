const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const ToolAssignment = require('../../models/ToolAssignment');
const DeviceBinding = require('../../models/DeviceBinding');
const RefreshToken = require('../../models/RefreshToken');
const ExtensionToken = require('../../models/ExtensionToken');
const ActivityLog = require('../../models/ActivityLog');
const ExtensionScan = require('../../models/ExtensionScan');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate, schemas } = require('../../middleware/validation');
const { buildProxyAssignmentDTOs } = require('../../utils/proxyAssignments');
const { normalizeWhatsAppNumber, isValidWhatsAppNumber } = require('../../utils/phone');

const INVALID_PHONE_MSG = 'Please enter a valid WhatsApp number (8–15 digits, including country code).';

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

// Normalise CRM tags: trim, cap length, de-dupe (case-insensitive), cap count.
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return undefined;
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const s = String(t || '').trim().slice(0, 24);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    if (out.length >= 12) break;
  }
  return out;
}

// ─── GET / — list clients ──────────────────────────────────────────────────────
// FIX9: Aggregation instead of N+1 queries
// FIX10: deviceLocked filter applied BEFORE pagination so totalCount is accurate
router.get('/', async (req, res) => {
  try {
    const { search, status, deviceLocked, tag, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
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
    // CRM tag filter — $in matches clients whose tags array CONTAINS the tag.
    if (tag) query.tags = { $in: [String(tag)] };

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

    // Flip any past-expiry rows to 'expired' first, so the status-based active
    // count below never includes a stale-but-unswept assignment.
    await ToolAssignment.updateExpiredAssignments().catch(() => {});

    // FIX9: Single aggregation for catalog (extension/direct) assignment counts.
    const clientIds = clients.map(c => c._id);
    const [assignmentAgg, deviceBindings, proxyDTOs] = await Promise.all([
      ToolAssignment.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: {
            _id: '$clientId',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }
        }}
      ]),
      DeviceBinding.find({ clientId: { $in: clientIds } }).select('clientId lastSeenAt userAgent'),
      // Proxy-gateway tools (HIX / BypassGPT / ChatGPT / Ryne / WriteHuman) and
      // StealthWriter live in separate models, so they were missing from the count.
      // Reuse the shared read-model (same end-of-day expiry rule) so the Members
      // count matches the Assignments list and the dashboards. Fail-safe → [].
      buildProxyAssignmentDTOs().then(r => r || []).catch(() => []),
    ]);

    const assignMap = Object.fromEntries(assignmentAgg.map(a => [a._id.toString(), a]));
    const deviceMap = Object.fromEntries(deviceBindings.map(d => [d.clientId.toString(), d]));

    // Per-client proxy/stealth tallies. DTO.status is 'active' only when not
    // expired and not revoked/disabled, so it already means "active access".
    const proxyTotalMap = {};
    const proxyActiveMap = {};
    for (const dto of proxyDTOs) {
      const cid = dto && dto.clientId != null ? String(dto.clientId) : null;
      if (!cid) continue;
      proxyTotalMap[cid] = (proxyTotalMap[cid] || 0) + 1;
      if (dto.status === 'active') proxyActiveMap[cid] = (proxyActiveMap[cid] || 0) + 1;
    }

    const clientsWithData = clients.map(client => {
      const id = client._id.toString();
      const agg = assignMap[id] || { total: 0, active: 0 };
      const binding = deviceMap[id];
      return {
        ...client.toObject(),
        assignmentCount:   agg.total  + (proxyTotalMap[id]  || 0),
        activeAssignments: agg.active + (proxyActiveMap[id] || 0),
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

// ─── POST /bulk — bulk action on multiple clients ─────────────────────────────
// Actions: enable | disable (status) · addTag | removeTag (CRM tags). Declared
// before /:id so it is never captured as an id param.
router.post('/bulk', async (req, res) => {
  try {
    const { clientIds, action, value } = req.body;
    if (!Array.isArray(clientIds) || clientIds.length === 0) return res.status(400).json({ error: 'clientIds are required' });
    const ACTIONS = ['enable', 'disable', 'addTag', 'removeTag'];
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const tag = (action === 'addTag' || action === 'removeTag') ? String(value || '').trim().slice(0, 24) : null;
    if ((action === 'addTag' || action === 'removeTag') && !tag) return res.status(400).json({ error: 'A tag value is required' });

    let updated = 0;
    for (const id of clientIds.slice(0, 500)) {
      try {
        const c = await User.findById(id);
        if (!c || c.role !== 'CLIENT') continue;
        if (action === 'enable') c.status = 'active';
        else if (action === 'disable') c.status = 'disabled';
        else if (action === 'addTag') {
          const t = Array.isArray(c.tags) ? c.tags : [];
          if (t.length < 12 && !t.some(x => String(x).toLowerCase() === tag.toLowerCase())) c.tags = [...t, tag];
        } else if (action === 'removeTag') {
          c.tags = (Array.isArray(c.tags) ? c.tags : []).filter(x => String(x).toLowerCase() !== tag.toLowerCase());
        }
        await c.save();
        updated++;
      } catch (_) { /* skip individual failures */ }
    }
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_BULK_ACTION', { action, value: tag || undefined, count: updated, ip: getClientIp(req) });
    return res.json({ success: true, updated });
  } catch (err) {
    console.error('Bulk client action error:', err);
    return res.status(500).json({ error: 'Failed to apply bulk action' });
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const client = await User.findById(req.params.id).select('-passwordHash');
    if (!client || client.role !== 'CLIENT') return res.status(404).json({ error: 'Client not found' });

    const [assignments, deviceBinding, activityLogs, extensionScan] = await Promise.all([
      ToolAssignment.find({ clientId: client._id }).populate('toolId', 'name category status targetUrl').sort({ createdAt: -1 }),
      DeviceBinding.findOne({ clientId: client._id }),
      ActivityLog.find({ actorId: client._id }).sort({ createdAt: -1 }).limit(20),
      // Latest browser-extension scan (one row per client) — powers the health card's
      // extension version / last-sync. Never exposes secrets. Fail-safe.
      ExtensionScan.findOne({ clientId: client._id }).catch(() => null),
    ]);

    const ext = extensionScan
      ? { extensionVersion: extensionScan.extensionVersion || null, scannedAt: extensionScan.scannedAt || extensionScan.updatedAt || null, scannerStatus: extensionScan.scannerStatus || null }
      : null;

    // Fold this client's proxy + StealthWriter assignments into the list so the
    // profile health summary (active/expired) matches the Members list count.
    // Read-only DTOs; same shape the detail panel already tolerates. Fail-safe.
    let mergedAssignments = assignments;
    try {
      const proxyDTOs = await buildProxyAssignmentDTOs({ clientId: client._id });
      if (Array.isArray(proxyDTOs) && proxyDTOs.length) mergedAssignments = [...assignments, ...proxyDTOs];
    } catch (_) { /* keep catalog assignments only */ }

    return res.json({ success: true, client: client.toObject(), assignments: mergedAssignments, deviceBinding, activityLogs, extensionScan: ext });
  } catch (err) {
    console.error('Get client error:', err);
    return res.status(500).json({ error: 'Failed to fetch client' });
  }
});

// ─── POST / — create client ───────────────────────────────────────────────────
router.post('/', validate(schemas.createClient), async (req, res) => {
  try {
    const { fullName, email, password, phone, status, devicePolicyEnabled, devicePolicy, notes, tags } = req.body;
    const ip = getClientIp(req);

    // Accept either the flat flag or a nested { enabled } object; default ON.
    const deviceEnabled = devicePolicyEnabled !== undefined
      ? devicePolicyEnabled
      : (devicePolicy && typeof devicePolicy === 'object' && devicePolicy.enabled !== undefined ? devicePolicy.enabled : true);

    // Optional WhatsApp/phone number — normalize + validate when provided.
    let normalizedPhone = '';
    if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
      normalizedPhone = normalizeWhatsAppNumber(phone);
      if (!isValidWhatsAppNumber(normalizedPhone)) return res.status(400).json({ error: INVALID_PHONE_MSG });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const client = await User.create({
      fullName, email, passwordHash: password,
      role: 'CLIENT', status: status || 'active',
      phone: normalizedPhone,
      devicePolicy: { enabled: deviceEnabled !== false, maxDevices: 1 },
      notes,
      tags: sanitizeTags(tags) || []
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
    const { fullName, email, password, phone, status, devicePolicyEnabled, devicePolicy, notes, tags } = req.body;
    const ip = getClientIp(req);

    // Accept either the flat flag or a nested { enabled } object.
    const deviceEnabled = devicePolicyEnabled !== undefined
      ? devicePolicyEnabled
      : (devicePolicy && typeof devicePolicy === 'object' && devicePolicy.enabled !== undefined ? devicePolicy.enabled : undefined);

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
    if (deviceEnabled !== undefined) {
      // Guard against legacy/partial records missing devicePolicy so toggling
      // device binding OFF/ON can never throw.
      if (!client.devicePolicy || typeof client.devicePolicy !== 'object') client.devicePolicy = { enabled: true, maxDevices: 1 };
      changes.devicePolicy = { from: client.devicePolicy.enabled, to: deviceEnabled };
      client.devicePolicy.enabled = deviceEnabled;
    }
    if (notes !== undefined) client.notes = notes;
    if (tags !== undefined) { client.tags = sanitizeTags(tags) || []; changes.tags = true; }
    if (phone !== undefined) {
      // Empty string clears the saved number; otherwise normalize + validate.
      const trimmed = String(phone == null ? '' : phone).trim();
      if (trimmed === '') { client.phone = ''; changes.phone = 'cleared'; }
      else {
        const np = normalizeWhatsAppNumber(trimmed);
        if (!isValidWhatsAppNumber(np)) return res.status(400).json({ error: INVALID_PHONE_MSG });
        client.phone = np; changes.phone = 'updated';
      }
    }

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

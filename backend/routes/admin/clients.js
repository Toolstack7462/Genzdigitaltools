// ============================================================
// DEPRECATED: This file is superseded by its Enhanced version.
// DO NOT IMPORT this file in new code. It will be deleted.
// See the corresponding *Enhanced.js or server-crm.js file.
// ============================================================

const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const ToolAssignment = require('../../models/ToolAssignment');
const DeviceBinding = require('../../models/DeviceBinding');
const RefreshToken = require('../../models/RefreshToken');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate, schemas } = require('../../middleware/validation');

// Apply auth middleware
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/crm/admin/clients - List clients with pagination and search
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      status, 
      deviceLocked, 
      page = 1, 
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const query = { role: 'CLIENT' };
    
    // Search filter
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Status filter
    if (status) query.status = status;
    
    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    
    // Get clients
    const [clients, totalCount] = await Promise.all([
      User.find(query)
        .select('-passwordHash')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query)
    ]);
    
    // Enrich with additional data
    const clientsWithData = await Promise.all(
      clients.map(async (client) => {
        const [assignmentCount, activeAssignments, deviceBinding] = await Promise.all([
          ToolAssignment.countDocuments({ clientId: client._id }),
          ToolAssignment.countDocuments({ clientId: client._id, status: 'active' }),
          DeviceBinding.findOne({ clientId: client._id })
        ]);
        
        const isDeviceLocked = !!deviceBinding && client.devicePolicy.enabled;
        
        return {
          ...client.toObject(),
          assignmentCount,
          activeAssignments,
          isDeviceLocked,
          deviceInfo: deviceBinding ? {
            lastSeen: deviceBinding.lastSeenAt,
            userAgent: deviceBinding.userAgent
          } : null
        };
      })
    );
    
    // Filter by device locked if specified
    let filteredClients = clientsWithData;
    if (deviceLocked === 'true') {
      filteredClients = clientsWithData.filter(c => c.isDeviceLocked);
    } else if (deviceLocked === 'false') {
      filteredClients = clientsWithData.filter(c => !c.isDeviceLocked);
    }
    
    res.json({ 
      success: true,
      clients: filteredClients,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: skip + clients.length < totalCount
      }
    });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// GET /api/crm/admin/clients/stats - Get client statistics
router.get('/stats', async (req, res) => {
  try {
    const [
      totalClients,
      activeClients,
      disabledClients,
      clientsWithDeviceBinding,
      recentClients
    ] = await Promise.all([
      User.countDocuments({ role: 'CLIENT' }),
      User.countDocuments({ role: 'CLIENT', status: 'active' }),
      User.countDocuments({ role: 'CLIENT', status: 'disabled' }),
      DeviceBinding.countDocuments(),
      User.find({ role: 'CLIENT' }).sort({ createdAt: -1 }).limit(5).select('-passwordHash')
    ]);
    
    res.json({
      success: true,
      stats: {
        totalClients,
        activeClients,
        disabledClients,
        clientsWithDeviceBinding,
        recentClients
      }
    });
  } catch (error) {
    console.error('Get client stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/crm/admin/clients/:id - Get single client with details
router.get('/:id', async (req, res) => {
  try {
    const client = await User.findById(req.params.id).select('-passwordHash');
    
    if (!client || client.role !== 'CLIENT') {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    const [assignments, deviceBinding, activityLogs] = await Promise.all([
      ToolAssignment.find({ clientId: client._id })
        .populate('toolId', 'name category status targetUrl')
        .sort({ createdAt: -1 }),
      DeviceBinding.findOne({ clientId: client._id }),
      ActivityLog.find({ actorId: client._id })
        .sort({ createdAt: -1 })
        .limit(20)
    ]);
    
    res.json({ 
      success: true,
      client: client.toObject(),
      assignments,
      deviceBinding,
      activityLogs
    });
  } catch (error) {
    console.error('Get client error:', error);
    res.status(500).json({ error: 'Failed to fetch client' });
  }
});

// POST /api/crm/admin/clients - Create client
router.post('/', validate(schemas.createClient), async (req, res) => {
  try {
    const { fullName, email, password, status, devicePolicyEnabled, notes } = req.body;
    const ipAddress = getClientIp(req);
    
    // Check if email already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    const client = await User.create({
      fullName,
      email,
      passwordHash: password,
      role: 'CLIENT',
      status: status || 'active',
      devicePolicy: {
        enabled: devicePolicyEnabled !== false,
        maxDevices: 1
      },
      notes
    });
    
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_CREATED', {
      clientId: client._id,
      clientEmail: client.email,
      ipAddress
    });
    
    res.status(201).json({ 
      success: true, 
      client: client.toJSON(),
      message: 'Client created successfully'
    });
  } catch (error) {
    console.error('Create client error:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// PUT /api/crm/admin/clients/:id - Update client
router.put('/:id', validate(schemas.updateClient), async (req, res) => {
  try {
    const { fullName, email, password, status, devicePolicyEnabled, notes } = req.body;
    const ipAddress = getClientIp(req);
    
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    // Track changes
    const changes = {};
    
    if (fullName && fullName !== client.fullName) {
      changes.fullName = { from: client.fullName, to: fullName };
      client.fullName = fullName;
    }
    
    if (email && email !== client.email) {
      // Check email uniqueness
      const existing = await User.findOne({ email, _id: { $ne: client._id } });
      if (existing) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      changes.email = { from: client.email, to: email };
      client.email = email;
    }
    
    if (password) {
      changes.password = 'changed';
      client.passwordHash = password;
    }
    
    if (status && status !== client.status) {
      changes.status = { from: client.status, to: status };
      client.status = status;
    }
    
    if (devicePolicyEnabled !== undefined && devicePolicyEnabled !== client.devicePolicy.enabled) {
      changes.devicePolicy = { from: client.devicePolicy.enabled, to: devicePolicyEnabled };
      client.devicePolicy.enabled = devicePolicyEnabled;
    }
    
    if (notes !== undefined) {
      client.notes = notes;
    }
    
    await client.save();
    
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_UPDATED', {
      clientId: client._id,
      clientEmail: client.email,
      changes,
      ipAddress
    });
    
    res.json({ 
      success: true, 
      client: client.toJSON(),
      message: 'Client updated successfully'
    });
  } catch (error) {
    console.error('Update client error:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// POST /api/crm/admin/clients/:id/device-reset - Reset device binding
router.post('/:id/device-reset', async (req, res) => {
  try {
    const ipAddress = getClientIp(req);
    
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    const deletedCount = await DeviceBinding.deleteMany({ clientId: client._id });
    
    await ActivityLog.log('ADMIN', req.userId, 'DEVICE_RESET', {
      clientId: client._id,
      clientEmail: client.email,
      devicesRemoved: deletedCount.deletedCount,
      ipAddress
    });
    
    res.json({ 
      success: true,
      message: `Device binding reset successfully. ${deletedCount.deletedCount} device(s) removed.`
    });
  } catch (error) {
    console.error('Device reset error:', error);
    res.status(500).json({ error: 'Failed to reset device' });
  }
});

// POST /api/crm/admin/clients/:id/force-logout - Force logout client
router.post('/:id/force-logout', async (req, res) => {
  try {
    const ipAddress = getClientIp(req);
    
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    // Increment token version to invalidate all active tokens
    await client.forceLogout();
    
    // Revoke all refresh tokens
    await RefreshToken.updateMany(
      { userId: client._id, revokedAt: null },
      { revokedAt: new Date(), revokedByIp: ipAddress }
    );
    
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_FORCE_LOGOUT', {
      clientId: client._id,
      clientEmail: client.email,
      ipAddress
    });
    
    res.json({ 
      success: true,
      message: 'Client has been logged out from all devices'
    });
  } catch (error) {
    console.error('Force logout error:', error);
    res.status(500).json({ error: 'Failed to force logout' });
  }
});

// DELETE /api/crm/admin/clients/:id - Delete client
router.delete('/:id', async (req, res) => {
  try {
    const ipAddress = getClientIp(req);
    
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'CLIENT') {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    // Delete all related data
    await Promise.all([
      ToolAssignment.deleteMany({ clientId: client._id }),
      DeviceBinding.deleteMany({ clientId: client._id }),
      RefreshToken.deleteMany({ userId: client._id })
    ]);
    
    await ActivityLog.log('ADMIN', req.userId, 'CLIENT_DELETED', {
      clientId: client._id,
      clientEmail: client.email,
      ipAddress
    });
    
    await client.deleteOne();
    
    res.json({ 
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    console.error('Delete client error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

module.exports = router;

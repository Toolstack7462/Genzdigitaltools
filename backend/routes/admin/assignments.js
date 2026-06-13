const express = require('express');
const router = express.Router();
const ToolAssignment = require('../../models/ToolAssignment');
const Tool = require('../../models/Tool');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware - accept all admin roles
router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
});

// ============================================================================
// IMPORTANT: /bulk route MUST come BEFORE /:clientId routes
// Otherwise Express will match "bulk" as a clientId parameter
// ============================================================================

// POST /api/admin/assignments/bulk - Bulk assign tool to multiple clients
router.post('/bulk', async (req, res) => {
  try {
    const { toolId, clientIds, startDate, endDate, durationDays, notes } = req.body;
    
    if (!toolId || !clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
      return res.status(400).json({ error: 'Tool ID and client IDs array are required' });
    }
    
    // Verify tool exists
    const tool = await Tool.findById(toolId);
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Calculate end date from duration if provided
    let calculatedEndDate = endDate;
    if (durationDays && !endDate) {
      const start = startDate ? new Date(startDate) : new Date();
      calculatedEndDate = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
    }
    
    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };
    
    for (const clientId of clientIds) {
      try {
        // Verify client exists
        const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
        if (!client) {
          results.errors.push({ clientId, error: 'Client not found' });
          results.skipped++;
          continue;
        }
        
        // Check if assignment already exists
        const existing = await ToolAssignment.findOne({ clientId, toolId });
        
        const assignment = await ToolAssignment.findOneAndUpdate(
          { clientId, toolId },
          {
            $set: {
              startDate: startDate || null,
              endDate: calculatedEndDate || null,
              durationDays: durationDays || null,
              notes: notes || null,
              status: 'active',
              createdBy: req.userId
            },
            $setOnInsert: {
              assignedAt: new Date()
            }
          },
          { upsert: true, new: true }
        );
        
        if (existing) {
          results.updated++;
        } else {
          results.created++;
        }
      } catch (error) {
        results.errors.push({ clientId, error: error.message });
        results.skipped++;
      }
    }
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_BULK_ASSIGNED', {
      toolId,
      toolName: tool.name,
      totalClients: clientIds.length,
      created: results.created,
      updated: results.updated,
      skipped: results.skipped
    });
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Bulk assign error:', error);
    res.status(500).json({ error: 'Failed to bulk assign tool' });
  }
});

// GET /:clientId - Get client assignments
router.get('/:clientId', async (req, res) => {
  try {
    const assignments = await ToolAssignment.find({ clientId: req.params.clientId })
      .populate('toolId', 'name category status targetUrl')
      .sort({ createdAt: -1 });
    
    res.json({ assignments });
  } catch (error) {
    console.error('Get assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// POST /:clientId - Assign tool to client
router.post('/:clientId', async (req, res) => {
  try {
    const { toolId, startDate, endDate, durationDays, notes } = req.body;
    const { clientId } = req.params;
    
    if (!toolId) {
      return res.status(400).json({ error: 'Tool ID is required' });
    }
    
    // Verify tool exists
    const tool = await Tool.findById(toolId);
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Verify client exists
    const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    // Calculate end date from duration if provided
    let calculatedEndDate = endDate;
    if (durationDays && !endDate) {
      const start = startDate ? new Date(startDate) : new Date();
      calculatedEndDate = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
    }
    
    // Upsert assignment
    const assignment = await ToolAssignment.findOneAndUpdate(
      { clientId, toolId },
      {
        $set: {
          startDate: startDate || null,
          endDate: calculatedEndDate || null,
          durationDays: durationDays || null,
          notes: notes || null,
          status: 'active',
          createdBy: req.userId
        },
        $setOnInsert: {
          assignedAt: new Date()
        }
      },
      { upsert: true, new: true }
    ).populate('toolId', 'name category status');
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_ASSIGNED', {
      clientId,
      toolId,
      toolName: tool.name
    });
    
    res.json({ success: true, assignment });
  } catch (error) {
    console.error('Assign tool error:', error);
    res.status(500).json({ error: 'Failed to assign tool' });
  }
});

// PUT /api/admin/assignments/:id - Update assignment
router.put('/:id', async (req, res) => {
  try {
    const { startDate, endDate, durationDays, status, notes } = req.body;
    
    const assignment = await ToolAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    if (startDate !== undefined) assignment.startDate = startDate;
    if (endDate !== undefined) assignment.endDate = endDate;
    if (durationDays !== undefined) assignment.durationDays = durationDays;
    if (status) assignment.status = status;
    if (notes !== undefined) assignment.notes = notes;
    
    await assignment.save();
    
    await ActivityLog.log('ADMIN', req.userId, 'ASSIGNMENT_UPDATED', {
      assignmentId: assignment._id,
      clientId: assignment.clientId,
      toolId: assignment.toolId
    });
    
    res.json({ success: true, assignment });
  } catch (error) {
    console.error('Update assignment error:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// DELETE /api/admin/assignments/:id - Unassign tool
router.delete('/:id', async (req, res) => {
  try {
    const assignment = await ToolAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_UNASSIGNED', {
      assignmentId: assignment._id,
      clientId: assignment.clientId,
      toolId: assignment.toolId
    });
    
    await assignment.deleteOne();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete assignment error:', error);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

module.exports = router;

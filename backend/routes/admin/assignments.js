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

// ---------------------------------------------------------------------------
// Helper: derive the human-facing assignment status + remaining days from the
// stored row. Uses the SAME inclusive end-of-day boundary as access validation
// (ToolAssignment.effectiveEndBoundary) so what admins see matches what clients
// actually get. Returns: 'active' | 'expiring' | 'expired' | 'revoked'.
// "expiring" = active and within EXPIRING_SOON_DAYS of expiry.
// ---------------------------------------------------------------------------
const EXPIRING_SOON_DAYS = 7;

function computeAssignmentStatus(a, now = new Date()) {
  const boundary = ToolAssignment.effectiveEndBoundary(a.endDate);
  const remainingDays = boundary
    ? Math.ceil((boundary.getTime() - now.getTime()) / 86400000)
    : null;

  let effectiveStatus;
  if (a.status === 'revoked') {
    effectiveStatus = 'revoked';
  } else if (a.status === 'expired') {
    effectiveStatus = 'expired';
  } else if (boundary && boundary.getTime() < now.getTime()) {
    // Active in DB but the boundary has passed (lazy expiry — the sweep job may
    // not have run yet). Show it as expired so the admin view is never stale.
    effectiveStatus = 'expired';
  } else if (boundary && remainingDays <= EXPIRING_SOON_DAYS) {
    effectiveStatus = 'expiring';
  } else {
    effectiveStatus = 'active';
  }

  return { effectiveStatus, remainingDays };
}

// Shape a populated assignment row into a flat DTO for the admin UI.
function toAssignmentDTO(a) {
  const obj = typeof a.toObject === 'function' ? a.toObject() : a;
  const tool = obj.toolId && typeof obj.toolId === 'object' ? obj.toolId : null;
  const client = obj.clientId && typeof obj.clientId === 'object' ? obj.clientId : null;
  const { effectiveStatus, remainingDays } = computeAssignmentStatus(obj);

  return {
    _id: obj._id,
    status: obj.status,
    effectiveStatus,
    remainingDays,
    startDate: obj.startDate || null,
    endDate: obj.endDate || null,
    durationDays: obj.durationDays || null,
    notes: obj.notes || null,
    assignedAt: obj.assignedAt || obj.createdAt || null,
    revokedAt: obj.revokedAt || null,
    createdAt: obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
    tool: tool ? { _id: tool._id, name: tool.name, category: tool.category, status: tool.status, targetUrl: tool.targetUrl } : null,
    toolId: tool ? tool._id : obj.toolId,
    client: client ? { _id: client._id, fullName: client.fullName, email: client.email, status: client.status } : null,
    clientId: client ? client._id : obj.clientId
  };
}

// GET / - Central, filterable list of assignments (powers the Assignments page,
// the per-tool "Manage Assignments" modal, and the per-client tools modal).
// Query: toolId, clientId, status (active|expiring|expired|revoked), search.
router.get('/', async (req, res) => {
  try {
    const { toolId, clientId, status, search } = req.query;

    // Narrow at the DB level by the indexed foreign keys when provided.
    const query = {};
    if (clientId) query.clientId = clientId;
    if (toolId) query.toolId = toolId;

    const rows = await ToolAssignment.find(query)
      .populate('toolId', 'name category status targetUrl')
      .populate('clientId', 'fullName email status')
      .sort({ createdAt: -1 });

    let items = rows.map(toAssignmentDTO);

    // Status filter is computed (covers lazy expiry + "expiring soon"), so apply
    // it after enrichment.
    if (status && status !== 'all') {
      items = items.filter(i => i.effectiveStatus === status);
    }

    // Free-text search across client name/email and tool name.
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      items = items.filter(i =>
        (i.client?.fullName || '').toLowerCase().includes(q) ||
        (i.client?.email || '').toLowerCase().includes(q) ||
        (i.tool?.name || '').toLowerCase().includes(q)
      );
    }

    const counts = items.reduce((acc, i) => {
      acc[i.effectiveStatus] = (acc[i.effectiveStatus] || 0) + 1;
      return acc;
    }, {});

    res.json({ success: true, assignments: items, total: items.length, counts });
  } catch (error) {
    console.error('List assignments error:', error);
    res.status(500).json({ error: 'Failed to list assignments' });
  }
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

// POST /api/admin/assignments/:id/extend - Extend an assignment's expiry.
// Body: { durationDays } (added on top of the current expiry, or today if later)
//   or { endDate } (set an explicit new expiry). Re-activates an expired row.
router.post('/:id/extend', async (req, res) => {
  try {
    const { durationDays, endDate } = req.body;

    const assignment = await ToolAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    let newEndDate;
    if (endDate) {
      newEndDate = new Date(endDate);
    } else if (durationDays) {
      const days = parseInt(durationDays, 10);
      if (!days || days <= 0) {
        return res.status(400).json({ error: 'durationDays must be a positive number' });
      }
      // Extend from the current (still-future) expiry, otherwise from now.
      const now = new Date();
      const current = assignment.endDate ? new Date(assignment.endDate) : null;
      const base = current && current.getTime() > now.getTime() ? current : now;
      newEndDate = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    } else {
      return res.status(400).json({ error: 'Provide durationDays or endDate' });
    }

    if (isNaN(newEndDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    assignment.endDate = newEndDate;
    assignment.status = 'active'; // extending re-activates an expired/active row
    assignment.revokedAt = null;
    await assignment.save();

    await ActivityLog.log('ADMIN', req.userId, 'ASSIGNMENT_EXTENDED', {
      assignmentId: assignment._id,
      clientId: assignment.clientId,
      toolId: assignment.toolId,
      endDate: newEndDate
    });

    res.json({ success: true, assignment: toAssignmentDTO(assignment) });
  } catch (error) {
    console.error('Extend assignment error:', error);
    res.status(500).json({ error: 'Failed to extend assignment' });
  }
});

// POST /api/admin/assignments/:id/expire - Expire an assignment immediately.
router.post('/:id/expire', async (req, res) => {
  try {
    const assignment = await ToolAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    assignment.status = 'expired';
    assignment.endDate = new Date(); // boundary now in the past → access denied
    await assignment.save();

    await ActivityLog.log('ADMIN', req.userId, 'ASSIGNMENT_EXPIRED', {
      assignmentId: assignment._id,
      clientId: assignment.clientId,
      toolId: assignment.toolId
    });

    res.json({ success: true, assignment: toAssignmentDTO(assignment) });
  } catch (error) {
    console.error('Expire assignment error:', error);
    res.status(500).json({ error: 'Failed to expire assignment' });
  }
});

// POST /api/admin/assignments/:id/revoke - Revoke access (keeps the row for audit).
router.post('/:id/revoke', async (req, res) => {
  try {
    const assignment = await ToolAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    assignment.status = 'revoked';
    assignment.revokedAt = new Date();
    await assignment.save();

    await ActivityLog.log('ADMIN', req.userId, 'ASSIGNMENT_REVOKED', {
      assignmentId: assignment._id,
      clientId: assignment.clientId,
      toolId: assignment.toolId
    });

    res.json({ success: true, assignment: toAssignmentDTO(assignment) });
  } catch (error) {
    console.error('Revoke assignment error:', error);
    res.status(500).json({ error: 'Failed to revoke assignment' });
  }
});

module.exports = router;

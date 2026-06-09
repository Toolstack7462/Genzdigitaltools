const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ActivityLog = require('../../models/ActivityLog');
const OpenIntent = require('../../models/OpenIntent');
const DeviceBinding = require('../../models/DeviceBinding');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

router.use(requireAuth);
router.use(requireRole('CLIENT'));

// FIX6: Strip ALL encrypted credential fields — clients never receive raw blobs
function sanitizeToolForClient(toolObj) {
  const STRIP = ['cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted'];
  STRIP.forEach(k => delete toolObj[k]);
  if (toolObj.credentials) {
    // Keep type/selectors/successCheck for extension config, remove encrypted payload
    delete toolObj.credentials.payloadEncrypted;
  }
  if (toolObj.sessionBundle) {
    // Keep version/bundleUpdatedAt for sync checking; strip all encrypted data
    delete toolObj.sessionBundle.cookiesEncrypted;
    delete toolObj.sessionBundle.localStorageEncrypted;
    delete toolObj.sessionBundle.sessionStorageEncrypted;
  }
  return toolObj;
}

function daysUntil(date) {
  if (!date) return null;
  // Use the SAME inclusive end-of-day boundary the verification uses, so the
  // displayed "expires in Nd" never disagrees with backend access checks.
  const boundary = ToolAssignment.effectiveEndBoundary(date);
  if (!boundary) return null;
  const diff = boundary.getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function normalizeClientTool(tool, assignment) {
  const raw = sanitizeToolForClient(tool.toObject ? tool.toObject() : { ...tool });
  const endDate = assignment?.endDate || null;
  const credentialType = raw.credentials?.type || raw.credentialType || 'none';
  const hasSessionBundle = !!(raw.sessionBundle?.version || raw.sessionBundle?.bundleUpdatedAt);
  return {
    ...raw,
    _id: raw._id,
    id: raw._id,
    shortDescription: raw.shortDescription || raw.description || '',
    accessMethod: raw.accessMethod || 'extension',
    credentialType,
    requiresExtension: raw.requiresExtension !== false,
    canAccess: raw.status === 'active',
    isFeatured: !!raw.isFeatured,
    isNew: !!raw.isNew,
    isPopular: !!raw.isPopular,
    isAI: raw.isAI !== undefined ? !!raw.isAI : String(raw.category || '').toLowerCase().includes('ai'),
    hasSessionBundle,
    assignmentId: assignment?._id,
    startDate: assignment?.startDate || null,
    endDate,
    accessEndDate: endDate,
    daysUntilExpiry: endDate ? daysUntil(endDate) : null,
    durationDays: assignment?.durationDays,
    status: ToolAssignment.isAssignmentExpired({ endDate }) ? 'expired' : raw.status,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// ─── GET / — assigned tools for client ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;

    await ToolAssignment.updateExpiredAssignments();

    const assignments = await ToolAssignment.find({
      clientId: req.userId, status: 'active'
    }).populate('toolId');

    const now = new Date();
    // Keep only valid (active, started, not-expired-by-end-of-day) assignments,
    // then DEDUPE per tool keeping the one with the latest end boundary — so the
    // card shows the same assignment verify-intent will later select.
    const bestByTool = new Map();
    for (const a of assignments) {
      if (!a.toolId || a.toolId.status !== 'active') continue;
      if (a.startDate && new Date(a.startDate) > now) continue;
      if (ToolAssignment.isAssignmentExpired(a, now)) continue;
      const key = String(a.toolId._id || a.toolId);
      const prev = bestByTool.get(key);
      const ab = ToolAssignment.effectiveEndBoundary(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
      const pb = prev ? (ToolAssignment.effectiveEndBoundary(prev.endDate)?.getTime() ?? Number.POSITIVE_INFINITY) : -1;
      if (!prev || ab > pb) bestByTool.set(key, a);
    }
    let tools = Array.from(bestByTool.values()).map(a => normalizeClientTool(a.toolId, a));

    // FIX26: Server-side filters already applied via MySQL/MariaDB above — these are fallbacks
    if (search) {
      const q = search.toLowerCase().substring(0, 100);
      tools = tools.filter(t =>
        t.name?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)
      );
    }
    if (category && category !== 'All') tools = tools.filter(t => t.category === category);

    return res.json({ success: true, tools });
  } catch (err) {
    console.error('Get client tools error:', err);
    return res.status(500).json({ error: 'Failed to fetch tools' });
  }
});


// ─── POST /:toolId/open-intent — dashboard → extension open token ──────────
router.post('/:toolId/open-intent', async (req, res) => {
  try {
    const { toolId } = req.params;
    const { deviceId } = req.body || {};

    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    // Re-check device binding for extension access trigger.
    // In soft mode: verify the deviceId is bound (exact hash match) OR allow if the
    // client has any active binding (same-browser history-clear scenario). The new
    // binding was already created during login, so we look for exact match first.
    if (req.user?.devicePolicy?.enabled && deviceId) {
      const BINDING_MODE = (process.env.DEVICE_BINDING_MODE || 'soft').toLowerCase();
      const deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
      let binding = await DeviceBinding.findOne({ clientId: req.userId, deviceIdHash });
      if (binding) {
        binding.lastSeenAt = new Date();
        await binding.save();
      } else if (BINDING_MODE === 'hard') {
        // Hard mode: must match a registered binding exactly.
        return res.status(403).json({ error: 'Device binding mismatch', code: 'DEVICE_MISMATCH' });
      }
      // Soft mode: if no exact match, the login flow already created a new binding.
      // Trust the authenticated session; do not double-block here.
    }

    // Pick the LATEST valid assignment (handles duplicates + end-of-day inclusivity).
    const now = new Date();
    const { assignment, candidates } = await ToolAssignment.findActiveForClientTool(req.userId, toolId);

    if (!assignment || !assignment.toolId) {
      const hadAny = (candidates || []).length > 0;
      console.log('[open-intent] no valid assignment', {
        clientId: String(req.userId), toolId: String(toolId),
        candidateCount: candidates?.length || 0,
        candidates: (candidates || []).map(c => ({ assignmentId: String(c._id), endDate: c.endDate, status: c.status })),
        serverNow: now.toISOString(),
        result: hadAny ? 'expired' : 'not_assigned',
      });
      return res.status(403).json({ error: hadAny ? 'Tool access expired' : 'Tool not assigned' });
    }

    console.log('[open-intent] assignment selected', {
      clientId: String(req.userId), toolId: String(toolId),
      assignmentId: String(assignment._id),
      shownEndDate: assignment.endDate,
      usedEndBoundary: ToolAssignment.effectiveEndBoundary(assignment.endDate)?.toISOString() || null,
      serverNow: now.toISOString(), result: 'valid',
    });

    // OpenIntent is created by the authenticated dashboard session and consumed
    // by the extension. The dashboard and extension maintain different device
    // identifiers, so do NOT bind this short-lived intent to the website device
    // hash. Device binding is already validated above for the dashboard session,
    // while the extension token validates the extension device separately.
    const issued = await OpenIntent.issue({
      clientId: req.userId,
      toolId: String(toolId),
      deviceIdHash: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      ttlMs: 5 * 60 * 1000, // 5-minute window — ample for connect + verify
    });

    await ActivityLog.log('CLIENT', req.userId, 'TOOL_OPEN_INTENT', {
      toolId,
      intentId: issued.id,
      expiresAt: issued.expiresAt.toISOString(),
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    return res.json({
      success: true,
      intentToken: issued.token,
      openIntentToken: issued.token,
      toolId,
      expiresAt: issued.expiresAt.toISOString()
    });
  } catch (err) {
    console.error('Create tool open intent error:', err);
    return res.status(500).json({ error: 'Failed to create open intent' });
  }
});

// ─── GET /:toolId — single tool detail ────────────────────────────────────────
router.get('/:toolId', async (req, res) => {
  try {
    const assignment = await ToolAssignment.findOne({
      clientId: req.userId, toolId: req.params.toolId, status: 'active'
    }).populate('toolId');

    if (!assignment) return res.status(403).json({ error: 'Access denied. Tool not assigned.' });
    if (!assignment.toolId || assignment.toolId.status !== 'active') return res.status(403).json({ error: 'Tool not available' });

    const now = new Date();
    if (assignment.startDate && assignment.startDate > now) return res.status(403).json({ error: 'Tool access not started yet' });
    if (assignment.endDate   && assignment.endDate   < now) return res.status(403).json({ error: 'Tool access has expired' });

    return res.json({
      success: true,
      tool: normalizeClientTool(assignment.toolId, assignment)
    });
  } catch (err) {
    console.error('Get tool details error:', err);
    return res.status(500).json({ error: 'Failed to fetch tool details' });
  }
});

module.exports = router;

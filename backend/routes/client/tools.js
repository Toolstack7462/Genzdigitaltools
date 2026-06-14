const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ActivityLog = require('../../models/ActivityLog');
const DeviceBinding = require('../../models/DeviceBinding');
const { getClientAccessibleTool, listClientAccessibleTools } = require('../../utils/getClientAccessibleTool');
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
// Uses the SAME shared helper (`listClientAccessibleTools`) that the
// open-intent / verify-intent / credentials endpoints consult, so whatever is
// visible here is guaranteed to be openable via the extension.
router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;

    const pairs = await listClientAccessibleTools(req.userId);
    let tools = pairs.map(({ tool, assignment }) => normalizeClientTool(tool, assignment));

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


// ─── GET /:toolId — single tool detail ────────────────────────────────────────
router.get('/:toolId', async (req, res) => {
  try {
    // Use the SAME selector + inclusive end-of-day rule as the tools list and the
    // open-intent / verify-intent access checks. A raw `endDate < now` here was
    // treating a date-only endDate (stored midnight-UTC) as start-of-day, so a
    // same-day assignment 403'd on the detail page even though the dashboard list
    // (which uses effectiveEndBoundary) still showed it as valid — the exact
    // "dashboard says valid but access expired" mismatch.
    const now = new Date();
    const decision = await getClientAccessibleTool(req.userId, req.params.toolId);
    const candidates = decision.candidates || [];
    const assignment = decision.ok ? decision.assignment : null;

    if (!assignment || !assignment.toolId) {
      const hadAny = candidates.length > 0;
      console.log('[tool-detail] no valid assignment', {
        clientId: String(req.userId), toolId: String(req.params.toolId),
        candidateCount: candidates.length,
        candidates: candidates.map(c => ({
          assignmentId: String(c._id), endDate: c.endDate,
          usedEndBoundary: ToolAssignment.effectiveEndBoundary(c.endDate)?.toISOString() || null,
          status: c.status,
        })),
        serverNow: now.toISOString(),
        result: decision.code,
      });
      return res.status(403).json({
        error: hadAny ? 'Tool access has expired' : 'Access denied. Tool not assigned.',
        code: decision.code,
      });
    }

    console.log('[tool-detail] assignment selected', {
      clientId: String(req.userId), toolId: String(req.params.toolId),
      assignmentId: String(assignment._id),
      shownEndDate: assignment.endDate,
      usedEndBoundary: ToolAssignment.effectiveEndBoundary(assignment.endDate)?.toISOString() || null,
      serverNow: now.toISOString(), result: 'valid',
    });

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

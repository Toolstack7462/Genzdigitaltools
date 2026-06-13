'use strict';
/**
 * Single source of truth for "is this tool accessible to this client RIGHT NOW".
 *
 * Used by:
 *   - client dashboard tools list      (routes/client/tools.js GET /)
 *   - client tool detail               (routes/client/tools.js GET /:toolId)
 *   - dashboard open-intent route      (routes/client/tools.js POST /:toolId/open-intent)
 *   - extension credentials route      (routes/extension/index.js GET /tools/:toolId/credentials)
 *   - extension verify-intent route    (routes/extension/index.js POST /verify-intent)
 *
 * Guarantees:
 *   - If `getClientAccessibleTool(clientId, toolId)` returns { ok: true, ... },
 *     the EXACT same client+tool pair will be visible in the dashboard list.
 *   - If it returns { ok: false, code: 'assignment_expired' }, the dashboard
 *     will NOT show the tool either — never "dashboard shows tool, access says
 *     expired".
 *
 * Returns:
 *   { ok: true,  tool, assignment, candidates }
 *   { ok: false, code: 'assignment_not_found' | 'assignment_expired', candidates }
 */
const ToolAssignment = require('../models/ToolAssignment');

/**
 * Return the latest still-valid active assignment for a (clientId, toolId)
 * pair, or an explicit reason code when none is valid.
 *
 * `toolId` is normalised to a string before comparison — the database may
 * return either the populated ObjectId or a raw hex/number id.
 */
async function getClientAccessibleTool(clientId, toolId) {
  if (!clientId || toolId == null) {
    return { ok: false, code: 'assignment_not_found', candidates: [] };
  }
  const wantTool = String(toolId);
  const { assignment, candidates } =
    await ToolAssignment.findActiveForClientTool(clientId, wantTool);

  if (!assignment || !assignment.toolId) {
    const hadAny = (candidates || []).length > 0;
    return {
      ok: false,
      code: hadAny ? 'assignment_expired' : 'assignment_not_found',
      candidates,
    };
  }

  return {
    ok: true,
    tool: assignment.toolId,
    assignment,
    candidates,
  };
}

/**
 * Return ALL still-valid active assignments for a client, de-duplicated per
 * tool (latest end boundary wins). This is what the dashboard tools list
 * renders — and is exactly the set of (client, tool) pairs for which
 * `getClientAccessibleTool` will return ok:true.
 */
async function listClientAccessibleTools(clientId) {
  if (!clientId) return [];
  await ToolAssignment.updateExpiredAssignments();

  const rows = await ToolAssignment.find({
    clientId, status: 'active'
  }).populate('toolId');

  const now = new Date();
  const bestByTool = new Map();
  for (const a of rows || []) {
    if (!a.toolId || a.toolId.status !== 'active') continue;
    if (a.startDate && new Date(a.startDate) > now) continue;
    if (ToolAssignment.isAssignmentExpired(a, now)) continue;

    const key = String(a.toolId._id || a.toolId);
    const prev = bestByTool.get(key);
    const ab = ToolAssignment.effectiveEndBoundary(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
    const pb = prev ? (ToolAssignment.effectiveEndBoundary(prev.endDate)?.getTime() ?? Number.POSITIVE_INFINITY) : -1;
    if (!prev || ab > pb) bestByTool.set(key, a);
  }
  // Always return { tool, assignment } pairs so callers don't have to peek
  // into populated fields manually.
  return Array.from(bestByTool.values()).map(a => ({ tool: a.toolId, assignment: a }));
}

module.exports = { getClientAccessibleTool, listClientAccessibleTools };

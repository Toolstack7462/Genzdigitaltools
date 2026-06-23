'use strict';
/**
 * Admin Analytics — live, aggregated counts for the Analytics page.
 * Mounted at /api/crm/admin/analytics.
 *
 * Counts catalog tools (extension/direct), proxy tools (HIX/BypassGPT/ChatGPT/Ryne/
 * WriteHuman) + StealthWriter, assignments (normal + proxy, active/expired), clients,
 * and recent activity — all computed live from the data, not from a capped log scan.
 * Never returns or logs cookies/tokens/sessions/secrets.
 */
const express = require('express');
const router = express.Router();

const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const proxyTools = require('../../utils/proxy/tools');
const { buildProxyAssignmentDTOs } = require('../../utils/proxyAssignments');
const { requireAuth } = require('../../middleware/authEnhanced');

router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!adminRoles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
});

function isExtensionTool(t) {
  const es = t.extensionSettings || {};
  // Direct-open-only tools (no permission required) are "direct"; everything else
  // flows through the extension/cookie system.
  return !(es.directOpenEnabled === true && es.requirePermission === false);
}

router.get('/', async (req, res) => {
  try {
    const now = new Date();

    // ── Catalog tools ──────────────────────────────────────────────────────────
    const allTools = await Tool.find({});
    const totalTools = allTools.length;
    const activeTools = allTools.filter(t => t.status === 'active').length;
    const extensionTools = allTools.filter(t => t.status === 'active' && isExtensionTool(t)).length;
    const directTools = allTools.filter(t => t.status === 'active' && !isExtensionTool(t)).length;

    // ── Normal assignments ───────────────────────────────────────────────────────
    const normalAssignments = await ToolAssignment.find({});
    const normalActive = normalAssignments.filter(a => {
      if (a.status === 'revoked' || a.status === 'expired') return false;
      const b = ToolAssignment.effectiveEndBoundary(a.endDate);
      return !b || b.getTime() >= now.getTime();
    });

    // ── Proxy + StealthWriter (treated as assigned tools) ─────────────────────────
    const proxyItems = await buildProxyAssignmentDTOs({});
    const proxyActive = proxyItems.filter(i => i.effectiveStatus === 'active' || i.effectiveStatus === 'expiring');
    // Distinct proxy tool integrations currently in use (e.g. HIX, ChatGPT, StealthWriter).
    const proxyToolsInUse = new Set(proxyItems.map(i => i.tool && i.tool.name).filter(Boolean)).size;

    const totalAssignments = normalAssignments.length + proxyItems.length;
    const activeAssignments = normalActive.length + proxyActive.length;
    const expiredAssignments = totalAssignments - activeAssignments;

    // ── Clients ───────────────────────────────────────────────────────────────────
    // Case-insensitive role match: the JSON adapter compares `role` as an exact
    // string, so a migrated/legacy client stored as 'client'/'Client' would be
    // silently excluded from the count. Matches the same fix applied to login.
    const totalClients = await User.countDocuments({ role: { $regex: '^CLIENT$', $options: 'i' } });
    const activeClientIds = new Set();
    normalActive.forEach(a => a.clientId && activeClientIds.add(String(a.clientId._id || a.clientId)));
    proxyActive.forEach(i => i.clientId && activeClientIds.add(String(i.clientId)));
    const activeClients = activeClientIds.size;

    // ── Recent activity + top tools (last 200 logs, bounded) ──────────────────────
    const recent = await ActivityLog.find({}).sort({ createdAt: -1 }).limit(200);
    const recentActivity = recent.slice(0, 12).map(l => ({
      _id: l._id, action: l.action, actorRole: l.actorRole, createdAt: l.createdAt,
    }));
    // Resolve a friendly tool name per open/lease event. Catalog opens log a toolId
    // (resolve via the already-loaded tool list); proxy leases log a slug (map to the
    // public display name); stealth leases get a fixed label — so Top Tools shows
    // consistent names instead of slugs / "Unknown".
    const toolNameById = {};
    allTools.forEach(t => { toolNameById[String(t._id)] = t.name; });
    const toolMap = {};
    recent.filter(l => l.action === 'TOOL_OPENED' || l.action === 'PROXY_LEASE_ISSUED' || l.action === 'STEALTH_LEASE_ISSUED').forEach(l => {
      const m = l.meta || {};
      let name;
      if (l.action === 'STEALTH_LEASE_ISSUED') {
        name = m.toolName || 'StealthWriter';
      } else if (l.action === 'PROXY_LEASE_ISSUED') {
        name = m.toolName || (m.tool && proxyTools.publicInfo(m.tool) && proxyTools.publicInfo(m.tool).name) || m.tool || 'Proxy tool';
      } else {
        name = m.toolName || toolNameById[String(m.toolId)] || m.tool || 'Unknown';
      }
      toolMap[name] = (toolMap[name] || 0) + 1;
    });
    const topTools = Object.entries(toolMap).sort(([, a], [, b]) => b - a).slice(0, 8).map(([name, count]) => ({ name, count }));

    return res.json({
      success: true,
      stats: {
        totalTools, activeTools, extensionTools, directTools,
        proxyTools: proxyToolsInUse,
        totalAssignments, activeAssignments, expiredAssignments,
        totalClients, activeClients,
      },
      topTools,
      recentActivity,
    });
  } catch (err) {
    console.error('Admin analytics error:', err.message);
    return res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = router;

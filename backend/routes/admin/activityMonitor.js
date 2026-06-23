'use strict';
/**
 * Admin Client Activity Monitor — live presence + recent tool launches.
 * Mounted at /api/crm/admin/activity-monitor.
 *
 * Feeds three dashboard widgets (polled by the admin dashboard, no page refresh):
 *   - onlineNow            : clients seen within the ONLINE window (derived, so
 *                            stale sessions auto-drop with no write)
 *   - recentlyActive       : clients seen within the RECENT window, not online now
 *   - recentlyOpenedTools  : last tool launches, read from the EXISTING ActivityLog
 *                            (TOOL_OPENED / PROXY_LEASE_ISSUED / STEALTH_LEASE_ISSUED)
 *                            — no new writes, reuses the analytics name-resolution.
 *
 * Lightweight + production-safe: presence table is bounded (one row/client); the
 * activity scan is capped; a lazy stale-row purge runs at most once per hour.
 * Never returns or logs cookies/tokens/sessions/secrets.
 */
const express = require('express');
const router = express.Router();

const ClientPresence = require('../../models/ClientPresence');
const ActivityLog = require('../../models/ActivityLog');
const Tool = require('../../models/Tool');
const proxyTools = require('../../utils/proxy/tools');
const { requireAuth } = require('../../middleware/authEnhanced');
const {
  isOnline, isRecent, EVENT_LABELS,
  ONLINE_WINDOW_MS, RECENT_WINDOW_MS,
} = require('../../utils/presence');

const STALE_PURGE_DAYS = Number(process.env.PRESENCE_PURGE_DAYS || 30);
const TOOL_ACTIONS = ['TOOL_OPENED', 'PROXY_LEASE_ISSUED', 'STEALTH_LEASE_ISSUED'];

router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!adminRoles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
});

// Lazy housekeeping: presence rows are bounded already, but trim very old rows
// (clients who never come back) at most once per hour. Fire-and-forget.
let lastPurgeAt = 0;
function maybePurgeStale() {
  const now = Date.now();
  if (now - lastPurgeAt < 60 * 60 * 1000) return;
  lastPurgeAt = now;
  Promise.resolve().then(async () => {
    const cutoff = new Date(now - STALE_PURGE_DAYS * 86400000);
    const old = await ClientPresence.find({ lastSeenAt: { $lt: cutoff } });
    const ids = (old || []).map(r => r._id);
    if (ids.length) await ClientPresence.deleteMany({ _id: { $in: ids } });
  }).catch(() => {});
}

router.get('/', async (req, res) => {
  try {
    maybePurgeStale();
    const now = Date.now();

    // ── Presence: one row per client, latest-first ──────────────────────────────
    const rows = await ClientPresence.find({}).sort({ lastSeenAt: -1 });
    // Defensive de-dupe by clientId (latest wins) in case a rare concurrent
    // first-insert produced two rows for the same client.
    const seen = new Set();
    const presence = [];
    for (const r of rows) {
      const k = String(r.clientId);
      if (seen.has(k)) continue;
      seen.add(k);
      presence.push(r);
    }

    const mapRow = (r) => ({
      clientId: String(r.clientId),
      name: r.clientName || 'Unknown',
      email: r.clientEmail || '—',
      lastEvent: r.lastEvent || null,
      lastEventLabel: EVENT_LABELS[r.lastEvent] || 'Active',
      lastToolName: r.lastToolName || null,
      lastSeenAt: r.lastSeenAt || null,
    });

    const onlineNow = presence.filter(r => isOnline(r, now)).map(mapRow);
    const recentlyActive = presence
      .filter(r => !isOnline(r, now) && isRecent(r, now))
      .map(mapRow);

    // ── Recently opened tools: read the EXISTING activity log (no new writes) ────
    const logs = await ActivityLog.find({ action: { $in: TOOL_ACTIONS } })
      .populate('actorId', 'fullName email')
      .sort({ createdAt: -1 })
      .limit(60);
    const top = logs.slice(0, 15);

    const allTools = await Tool.find({}).catch(() => []);
    const toolNameById = {};
    (allTools || []).forEach(t => { toolNameById[String(t._id)] = t.name; });

    const recentlyOpenedTools = top.map(l => {
      const m = l.meta || {};
      let toolName;
      if (l.action === 'STEALTH_LEASE_ISSUED') {
        toolName = m.toolName || 'StealthWriter';
      } else if (l.action === 'PROXY_LEASE_ISSUED') {
        const info = m.tool && proxyTools.publicInfo ? proxyTools.publicInfo(m.tool) : null;
        toolName = m.toolName || (info && info.name) || m.tool || 'Proxy tool';
      } else {
        toolName = m.toolName || toolNameById[String(m.toolId)] || 'Tool';
      }
      const actor = (l.actorId && typeof l.actorId === 'object') ? l.actorId : null;
      return {
        clientName: (actor && actor.fullName) || 'Unknown',
        email: (actor && actor.email) || '—',
        toolName,
        at: l.createdAt,
      };
    });

    return res.json({
      success: true,
      serverTime: new Date().toISOString(),
      windows: { onlineMs: ONLINE_WINDOW_MS, recentMs: RECENT_WINDOW_MS },
      counts: { online: onlineNow.length, recentlyActive: recentlyActive.length },
      onlineNow,
      recentlyActive,
      recentlyOpenedTools,
    });
  } catch (err) {
    console.error('Activity monitor error:', err.message);
    return res.status(500).json({ error: 'Failed to load activity monitor' });
  }
});

module.exports = router;

'use strict';
/**
 * Admin Renewals — a per-client view of tool access that is expiring soon or
 * already expired, plus manual renewal-reminder sending (email / WhatsApp).
 * Mounted at /api/crm/admin/renewals. Admin-auth protected.
 *
 * Reuses EXISTING data and infra only:
 *   - ToolAssignment + ToolAssignment.effectiveEndBoundary (same inclusive
 *     end-of-day boundary clients actually get),
 *   - utils/email.sendRenewalReminderEmail (Resend; degrades gracefully if the
 *     mailer isn't configured),
 *   - RenewalReminderLog for "last reminded" history (avoids double-nagging),
 *   - ActivityLog for the audit trail.
 * No new tracking, no secrets. Reminders are always MANUAL (admin-triggered).
 */
const express = require('express');
const router = express.Router();
const ToolAssignment = require('../../models/ToolAssignment');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const RenewalReminderLog = require('../../models/RenewalReminderLog');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');
const { isEmailEnabled, sendRenewalReminderEmail } = require('../../utils/email');

router.use(requireAuth);
router.use(requireAdmin);

const DAY_MS = 86400000;

// Build the list of a client's tool assignments that are expiring within `days`
// or already expired. `rows` are populated ToolAssignment docs. Returns a flat
// array of { assignmentId, toolId, toolName, endDate, daysLeft, expired }.
function expiringToolsFromRows(rows, days, now = new Date()) {
  const out = [];
  for (const row of rows || []) {
    if (!row || row.status === 'revoked') continue;
    const boundary = ToolAssignment.effectiveEndBoundary(row.endDate);
    if (!boundary) continue; // no expiry (lifetime access) → nothing to renew
    const daysLeft = Math.ceil((boundary.getTime() - now.getTime()) / DAY_MS);
    const expired = boundary.getTime() < now.getTime();
    if (!expired && daysLeft > days) continue; // still comfortably active
    const tool = row.toolId && typeof row.toolId === 'object' ? row.toolId : null;
    out.push({
      assignmentId: row._id,
      toolId: tool ? tool._id : row.toolId,
      toolName: tool ? tool.name : 'Tool',
      endDate: row.endDate || null,
      daysLeft,
      expired,
    });
  }
  // Soonest / most-overdue first.
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

// GET / — clients with tools expiring within ?days (default 14) or already expired.
// Grouped by client, most urgent first, each annotated with its last reminder.
router.get('/', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const now = new Date();

    const rows = await ToolAssignment.find({})
      .populate('toolId', 'name category')
      .populate('clientId', 'fullName email status phone');

    // Group expiring/expired rows by client.
    const byClient = new Map();
    for (const row of rows || []) {
      if (!row || row.status === 'revoked') continue;
      const boundary = ToolAssignment.effectiveEndBoundary(row.endDate);
      if (!boundary) continue;
      const daysLeft = Math.ceil((boundary.getTime() - now.getTime()) / DAY_MS);
      const expired = boundary.getTime() < now.getTime();
      if (!expired && daysLeft > days) continue;

      const client = row.clientId && typeof row.clientId === 'object' ? row.clientId : null;
      const clientId = client ? String(client._id) : String(row.clientId || '');
      if (!clientId) continue;

      if (!byClient.has(clientId)) {
        byClient.set(clientId, {
          clientId,
          fullName: client ? client.fullName : null,
          email: client ? client.email : null,
          status: client ? client.status : null,
          phone: client ? (client.phone || null) : null,
          tools: [],
        });
      }
      const tool = row.toolId && typeof row.toolId === 'object' ? row.toolId : null;
      byClient.get(clientId).tools.push({
        assignmentId: row._id,
        toolId: tool ? tool._id : row.toolId,
        toolName: tool ? tool.name : 'Tool',
        endDate: row.endDate || null,
        daysLeft,
        expired,
      });
    }

    // Attach the latest reminder per client (single bounded read).
    const lastReminderByClient = {};
    try {
      const logs = await RenewalReminderLog.find({}).sort({ sentAt: -1 }).limit(500);
      for (const l of logs || []) {
        const cid = String(l.clientId || '');
        if (cid && !lastReminderByClient[cid]) {
          lastReminderByClient[cid] = { at: l.sentAt || l.createdAt || null, channel: l.channel || null };
        }
      }
    } catch (_) { /* best-effort; never breaks the list */ }

    const clients = Array.from(byClient.values()).map(c => {
      c.tools.sort((a, b) => a.daysLeft - b.daysLeft);
      const expiredCount = c.tools.filter(t => t.expired).length;
      const expiringCount = c.tools.length - expiredCount;
      const soonest = c.tools[0] || null;
      return {
        ...c,
        expiredCount,
        expiringCount,
        soonestDaysLeft: soonest ? soonest.daysLeft : null,
        soonestEndDate: soonest ? soonest.endDate : null,
        lastReminder: lastReminderByClient[c.clientId] || null,
      };
    });

    // Most urgent clients first (lowest/most-negative daysLeft).
    clients.sort((a, b) => (a.soonestDaysLeft ?? 9999) - (b.soonestDaysLeft ?? 9999));

    const counts = {
      clients: clients.length,
      expiring: clients.reduce((n, c) => n + c.expiringCount, 0),
      expired: clients.reduce((n, c) => n + c.expiredCount, 0),
    };

    res.json({ success: true, days, emailEnabled: isEmailEnabled(), clients, counts });
  } catch (error) {
    console.error('List renewals error:', error);
    res.status(500).json({ error: 'Failed to load renewals' });
  }
});

// POST /:clientId/remind — manually send a renewal reminder to one client.
// Body: { channel: 'email' | 'whatsapp', days?, toolIds? }.
//  - email: sends the branded renewal email (no-op-safe if mailer unconfigured).
//  - whatsapp: records that the admin reached out (the actual message is opened
//    client-side via wa.me); this just stamps "last reminded".
// Always records a RenewalReminderLog + ActivityLog entry.
router.post('/:clientId/remind', async (req, res) => {
  try {
    const { clientId } = req.params;
    const channel = req.body && req.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const days = Math.min(90, Math.max(1, parseInt(req.body && req.body.days, 10) || 14));
    const toolIds = Array.isArray(req.body && req.body.toolIds) ? req.body.toolIds.map(String) : null;

    const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const rows = await ToolAssignment.find({ clientId }).populate('toolId', 'name');
    let tools = expiringToolsFromRows(rows, days);
    if (toolIds && toolIds.length) {
      tools = tools.filter(t => toolIds.includes(String(t.assignmentId)) || toolIds.includes(String(t.toolId)));
    }
    if (!tools.length) {
      return res.status(400).json({ error: 'This client has no expiring or expired tools to remind about.' });
    }

    const record = async () => {
      await RenewalReminderLog.create({
        clientId: String(client._id),
        clientEmail: client.email || null,
        channel,
        toolCount: tools.length,
        tools: tools.map(t => ({ toolId: String(t.toolId || ''), toolName: t.toolName, endDate: t.endDate })),
        sentBy: req.userId,
        sentAt: new Date(),
      });
      await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_REMINDER_SENT', {
        clientId: String(client._id), channel, toolCount: tools.length,
      });
    };

    if (channel === 'whatsapp') {
      await record();
      return res.json({ success: true, channel, sentAt: new Date(), toolCount: tools.length });
    }

    // Email channel.
    if (!isEmailEnabled()) {
      return res.json({ success: false, emailEnabled: false, message: 'Email is not configured on the server. Use WhatsApp instead.' });
    }
    if (!client.email) {
      return res.status(400).json({ error: 'This client has no email address on file.' });
    }
    const r = await sendRenewalReminderEmail(client.email, {
      clientName: client.fullName,
      tools,
    });
    if (r && r.error) {
      return res.json({ success: false, error: r.error, domainNotVerified: !!r.domainNotVerified });
    }
    await record();
    res.json({ success: true, channel: 'email', sentAt: new Date(), toolCount: tools.length });
  } catch (error) {
    console.error('Send renewal reminder error:', error);
    res.status(500).json({ error: 'Failed to send renewal reminder' });
  }
});

module.exports = router;

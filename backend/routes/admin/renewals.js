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
const ProxyClient = require('../../models/proxy/ProxyClient');
const StealthClient = require('../../models/stealth/StealthClient');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const RenewalReminderLog = require('../../models/RenewalReminderLog');
const RenewalFollowup = require('../../models/RenewalFollowup');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');
const { isEmailEnabled, sendRenewalReminderEmail } = require('../../utils/email');
const proxyTools = require('../../utils/proxy/tools');

router.use(requireAuth);
router.use(requireAdmin);

const DAY_MS = 86400000;

const OFFERS = ['none', 'discount10', 'bonus2'];
const FOLLOWUP_STATUSES = ['open', 'snoozed', 'lost', 'recovered'];

// A service overdue by MORE than this is "old / archived" — it drops out of the upcoming windows and
// the default queue, and always sorts to the bottom. Env-overridable.
const ARCHIVE_AFTER_DAYS = Math.max(1, parseInt(process.env.RENEWAL_ARCHIVE_AFTER_DAYS, 10) || 30);
// Default (no explicit range) actionable horizon into the future.
const DEFAULT_HORIZON_DAYS = Math.max(1, parseInt(process.env.RENEWAL_DEFAULT_HORIZON_DAYS, 10) || 60);

// UTC day boundaries (the expiry boundary itself is computed in UTC via effectiveEndBoundary).
function startOfDay(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x; }
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
function parseYMD(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Resolve the query into an inclusive expiry window { start, end } (either may be null = unbounded)
// plus a `mode`. Presets are computed server-side so the date math is timezone-consistent.
//   range=today|tomorrow|next7|next14|next30|overdue|archived|all | (from[/to] for custom)
// Back-compat: ?days=N with no range → the default actionable window (recently overdue → +N days).
function resolveWindow(query, now) {
  const today = startOfDay(now);
  const range = String(query.range || '').toLowerCase();
  const from = parseYMD(query.from);
  const to = parseYMD(query.to);
  if (from || to) {                         // custom single date (from only) or range (from+to)
    return { start: from ? startOfDay(from) : null, end: to ? endOfDay(to) : (from ? endOfDay(from) : null), mode: 'custom' };
  }
  switch (range) {
    case 'today': return { start: today, end: endOfDay(today), mode: 'today' };
    case 'tomorrow': { const t = addDays(today, 1); return { start: t, end: endOfDay(t), mode: 'tomorrow' }; }
    case 'next7': return { start: today, end: endOfDay(addDays(today, 7)), mode: 'next7' };
    case 'next14': return { start: today, end: endOfDay(addDays(today, 14)), mode: 'next14' };
    case 'next30': return { start: today, end: endOfDay(addDays(today, 30)), mode: 'next30' };
    // Recently expired but still worth chasing (overdue within the archive grace).
    case 'overdue': return { start: startOfDay(addDays(today, -ARCHIVE_AFTER_DAYS)), end: endOfDay(addDays(today, -1)), mode: 'overdue' };
    // Old / long-expired only.
    case 'archived': return { start: null, end: endOfDay(addDays(today, -ARCHIVE_AFTER_DAYS - 1)), mode: 'archived' };
    case 'all': return { start: null, end: null, mode: 'all' };
    default: {
      const days = Math.min(90, Math.max(1, parseInt(query.days, 10) || DEFAULT_HORIZON_DAYS));
      // Actionable queue: recently overdue (within grace) through `days` ahead — excludes long-expired.
      return { start: startOfDay(addDays(today, -ARCHIVE_AFTER_DAYS)), end: endOfDay(addDays(today, days)), mode: 'default', days };
    }
  }
}

// Derive the recovery STAGE from how overdue the client's most-urgent tool is.
// Stages are computed (not stored) so they always reflect live expiry data.
function deriveStage(soonestDaysLeft) {
  if (soonestDaysLeft == null) return 'before_expiry';
  if (soonestDaysLeft >= 1) return 'before_expiry';
  if (soonestDaysLeft === 0) return 'expired_today';
  const overdue = -soonestDaysLeft;
  if (overdue <= 3) return 'day3';
  if (overdue <= 7) return 'day7';
  return 'final';
}

// Public-safe shape of a follow-up record (no internal/secret fields).
function followupDTO(f) {
  if (!f) return null;
  return {
    status: f.status || 'open',
    lastFollowupAt: f.lastFollowupAt || null,
    lastChannel: f.lastChannel || null,
    lastStage: f.lastStage || null,
    offer: OFFERS.includes(f.offer) ? f.offer : 'none',
    note: f.note || '',
    snoozeUntil: f.snoozeUntil || null,
    lostReason: f.lostReason || '',
  };
}

// Upsert (find-or-create) the single follow-up row for a client and merge `patch`.
async function upsertFollowup(clientId, patch, adminId) {
  const cid = String(clientId);
  let f = await RenewalFollowup.findOne({ clientId: cid });
  if (!f) {
    f = await RenewalFollowup.create({ clientId: cid, status: 'open', offer: 'none', ...patch, updatedBy: adminId });
  } else {
    Object.assign(f, patch, { updatedBy: adminId });
    await f.save();
  }
  return f;
}

// A service assignment counts as "access removed" (not a renewal candidate) when it's in one of
// these states — the same intent as ToolAssignment skipping 'revoked', extended to the dedicated
// modules (ProxyClient/StealthClient use 'disabled'). A swept 'expired' ToolAssignment is KEPT
// (that's exactly what Renewals surfaces).
const REMOVED_STATES = new Set(['revoked', 'disabled']);

// SINGLE renewal aggregator. Collects a client's expiring/expired services from ALL assignment
// stores — core tools (ToolAssignment), proxy tools (ProxyClient: HIX/BypassGPT/WriteHuman/…) and
// StealthWriter (StealthClient) — into ONE unified shape the engine already understands:
//   { assignmentId, toolId, toolName, endDate, daysLeft, expired, overdueDays, archived, module }
// Every store's expiry boundary is computed with the EXISTING ToolAssignment.effectiveEndBoundary()
// so the inclusive end-of-day rule is identical everywhere. `win` is the {start,end} expiry window
// from resolveWindow (either bound may be null = unbounded) — this bounds BOTH sides, so a service is
// included only if its expiry actually falls in the window (fixes long-expired leaking into upcoming
// filters). Pass `onlyClientId` to scope to one client. Returns flat entries { clientId, client, tool }.
async function collectServiceEntries(win, now, onlyClientId = null) {
  const entries = [];
  const nowT = now.getTime();
  const startT = win && win.start ? win.start.getTime() : null;
  const endT = win && win.end ? win.end.getTime() : null;
  const within = (endDate) => {
    const boundary = ToolAssignment.effectiveEndBoundary(endDate);
    if (!boundary) return null; // no expiry (lifetime access) → nothing to renew
    const t = boundary.getTime();
    if (startT != null && t < startT) return null; // expiry is before the window
    if (endT != null && t > endT) return null;     // expiry is after the window
    const daysLeft = Math.ceil((t - nowT) / DAY_MS);
    const expired = t < nowT;
    const overdueDays = expired ? Math.max(0, Math.floor((nowT - t) / DAY_MS)) : 0;
    const archived = expired && overdueDays > ARCHIVE_AFTER_DAYS; // long-expired
    return { daysLeft, expired, overdueDays, archived };
  };
  const push = (clientRef, tool) => {
    const client = clientRef && typeof clientRef === 'object' ? clientRef : null;
    const clientId = client ? String(client._id) : String(clientRef || '');
    if (!clientId) return;
    if (onlyClientId && clientId !== String(onlyClientId)) return;
    entries.push({
      clientId,
      client: client ? { fullName: client.fullName, email: client.email, status: client.status, phone: client.phone || null } : null,
      tool,
    });
  };

  // 1) Core tools (ToolAssignment) — behaviour identical to before.
  const taRows = await ToolAssignment.find(onlyClientId ? { clientId: onlyClientId } : {})
    .populate('toolId', 'name category')
    .populate('clientId', 'fullName email status phone');
  for (const row of taRows || []) {
    if (!row || REMOVED_STATES.has(row.status)) continue;
    const w = within(row.endDate); if (!w) continue;
    const tool = row.toolId && typeof row.toolId === 'object' ? row.toolId : null;
    push(row.clientId, {
      assignmentId: String(row._id), toolId: tool ? String(tool._id) : String(row.toolId || ''),
      toolName: tool ? tool.name : 'Tool', endDate: row.endDate || null,
      daysLeft: w.daysLeft, expired: w.expired, overdueDays: w.overdueDays, archived: w.archived, module: 'core',
    });
  }

  // 2) Proxy tools (ProxyClient) — HIX / BypassGPT / WriteHuman / …, keyed by userId + tool.
  // Wrapped so a problem reading this ADDITIVE store can never break the core-tool renewals above.
  try {
    const pxRows = await ProxyClient.find(onlyClientId ? { userId: onlyClientId } : {})
      .populate('userId', 'fullName email status phone');
    for (const row of pxRows || []) {
      if (!row || REMOVED_STATES.has(row.status)) continue;
      const w = within(row.expiryDate); if (!w) continue;
      const meta = proxyTools.getTool(row.tool);
      push(row.userId, {
        assignmentId: String(row._id), toolId: String(row.tool || ''),
        toolName: (meta && meta.name) || row.tool || 'Proxy tool', endDate: row.expiryDate || null,
        daysLeft: w.daysLeft, expired: w.expired, overdueDays: w.overdueDays, archived: w.archived, module: 'proxy',
      });
    }
  } catch (e) { console.error('Renewals: proxy source read failed:', e.message); }

  // 3) StealthWriter (StealthClient) — keyed by userId. Also wrapped (additive, non-fatal).
  try {
    const swRows = await StealthClient.find(onlyClientId ? { userId: onlyClientId } : {})
      .populate('userId', 'fullName email status phone');
    for (const row of swRows || []) {
      if (!row || REMOVED_STATES.has(row.status)) continue;
      const w = within(row.expiryDate); if (!w) continue;
      push(row.userId, {
        assignmentId: String(row._id), toolId: 'stealthwriter',
        toolName: row.planName || 'StealthWriter', endDate: row.expiryDate || null,
        daysLeft: w.daysLeft, expired: w.expired, overdueDays: w.overdueDays, archived: w.archived, module: 'stealth',
      });
    }
  } catch (e) { console.error('Renewals: stealth source read failed:', e.message); }

  return entries;
}

// GET / — clients with tools expiring within ?days (default 14) or already expired.
// Grouped by client, most urgent first, each annotated with its last reminder.
router.get('/', async (req, res) => {
  try {
    const now = new Date();
    const win = resolveWindow(req.query, now); // date-range window (presets / custom / default)

    // Unified across ALL assignment stores (core tools + proxy tools + StealthWriter).
    const entries = await collectServiceEntries(win, now);

    // Group expiring/expired services by client. A client with services in more than one module
    // gets a single card listing every expiring service.
    const byClient = new Map();
    for (const e of entries) {
      if (!byClient.has(e.clientId)) {
        byClient.set(e.clientId, {
          clientId: e.clientId,
          fullName: e.client ? e.client.fullName : null,
          email: e.client ? e.client.email : null,
          status: e.client ? e.client.status : null,
          phone: e.client ? (e.client.phone || null) : null,
          tools: [],
        });
      }
      const g = byClient.get(e.clientId);
      // Backfill client identity if the first entry for this client had no populated user.
      if (e.client && g.fullName == null && g.email == null) {
        g.fullName = e.client.fullName; g.email = e.client.email;
        g.status = e.client.status; g.phone = e.client.phone || null;
      }
      g.tools.push(e.tool);
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

    // Attach the recovery follow-up state per client (single bounded read).
    const followupByClient = {};
    try {
      const fups = await RenewalFollowup.find({}).limit(2000);
      for (const f of fups || []) {
        const cid = String(f.clientId || '');
        if (cid) followupByClient[cid] = f;
      }
    } catch (_) { /* best-effort; never breaks the list */ }

    const clients = Array.from(byClient.values()).map(c => {
      // Within a client: nearest expiry first (most-overdue → today → upcoming).
      c.tools.sort((a, b) => a.daysLeft - b.daysLeft);
      const archivedCount = c.tools.filter(t => t.archived).length;
      const expiredCount = c.tools.filter(t => t.expired && !t.archived).length; // recently expired
      const expiringCount = c.tools.filter(t => !t.expired).length;              // still upcoming
      const activeTools = c.tools.filter(t => !t.archived);
      // A client with NO actionable (non-archived) service is itself old/archived.
      const clientArchived = activeTools.length === 0;
      // Urgency reference = soonest ACTIONABLE service; fall back to the soonest archived one.
      const ref = activeTools[0] || c.tools[0] || null;
      const soonestDaysLeft = ref ? ref.daysLeft : null;
      return {
        ...c,
        expiredCount,
        expiringCount,
        archivedCount,
        archived: clientArchived,
        soonestDaysLeft,
        soonestEndDate: ref ? ref.endDate : null,
        overdueDays: soonestDaysLeft != null && soonestDaysLeft < 0 ? -soonestDaysLeft : 0,
        suggestedStage: deriveStage(clientArchived ? null : soonestDaysLeft),
        lastReminder: lastReminderByClient[c.clientId] || null,
        followup: followupDTO(followupByClient[c.clientId]),
      };
    });

    // Sort order (top → bottom):
    //   1) UPCOMING (not yet expired) — nearest expiry first (soonest at the very top),
    //   2) recently EXPIRED — most-recent first,
    //   3) OLD/archived expired — oldest at the very bottom.
    // The upcoming-above-expired split and the "oldest last" tiebreak are by daysLeft, NOT the
    // archive flag — so a long-dead record can NEVER surface at the top even if it isn't flagged.
    clients.sort((a, b) => {
      const aDl = a.soonestDaysLeft, bDl = b.soonestDaysLeft;
      const aExp = aDl != null && aDl < 0;
      const bExp = bDl != null && bDl < 0;
      if (aExp !== bExp) return aExp ? 1 : -1;            // upcoming (incl. today) above all expired
      if (!aExp) return (aDl ?? 9999) - (bDl ?? 9999);    // upcoming: soonest expiry first
      return (bDl ?? -99999) - (aDl ?? -99999);           // expired: most-recent first → oldest last
    });

    const counts = {
      clients: clients.length,
      expiring: clients.reduce((n, c) => n + c.expiringCount, 0),
      expired: clients.reduce((n, c) => n + c.expiredCount, 0),
      archived: clients.reduce((n, c) => n + c.archivedCount, 0),
    };

    res.json({ success: true, range: win.mode, days: win.days || null, archiveAfterDays: ARCHIVE_AFTER_DAYS, emailEnabled: isEmailEnabled(), clients, counts });
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
    // Optional retention offer + recovery stage (admin-controlled per send).
    const offer = OFFERS.includes(req.body && req.body.offer) ? req.body.offer : 'none';
    const stage = req.body && typeof req.body.stage === 'string' ? req.body.stage.slice(0, 24) : null;

    const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Gather ALL the client's expiring/expired services across every module (core + proxy + stealth),
    // unbounded window — a reminder should cover every renewable service the client has.
    let tools = (await collectServiceEntries({ start: null, end: null }, new Date(), clientId)).map(e => e.tool);
    tools.sort((a, b) => a.daysLeft - b.daysLeft); // soonest / most-overdue first
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
        offer,
        toolCount: tools.length,
        tools: tools.map(t => ({ toolId: String(t.toolId || ''), toolName: t.toolName, endDate: t.endDate })),
        sentBy: req.userId,
        sentAt: new Date(),
      });
      await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_REMINDER_SENT', {
        clientId: String(client._id), channel, toolCount: tools.length, offer,
      });
      // Advance the recovery follow-up state: stamp the touch, record the offer,
      // and clear any snooze (a fresh follow-up reopens the client).
      await upsertFollowup(String(client._id), {
        lastFollowupAt: new Date(),
        lastChannel: channel,
        lastStage: stage || deriveStage(tools[0] ? tools[0].daysLeft : null),
        offer,
        status: 'open',
        snoozeUntil: null,
      }, req.userId).catch(() => {});
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
      offer,
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

// POST /:clientId/followup — update the recovery follow-up state WITHOUT sending a
// message: snooze, mark lost (+reason), reactivate, set the offer, or save a note.
// Body: { status?, snoozeDays?, lostReason?, offer?, note? }. Admin-only, no secrets.
router.post('/:clientId/followup', async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const body = req.body || {};
    const patch = {};

    if (body.offer !== undefined) {
      if (!OFFERS.includes(body.offer)) return res.status(400).json({ error: 'Invalid offer' });
      patch.offer = body.offer;
    }
    if (body.note !== undefined) patch.note = String(body.note || '').slice(0, 500);
    if (body.lostReason !== undefined) patch.lostReason = String(body.lostReason || '').slice(0, 200);

    // Snooze: hide/deprioritise for N days (1–90) → status 'snoozed'.
    if (body.snoozeDays !== undefined) {
      const n = Math.min(90, Math.max(1, parseInt(body.snoozeDays, 10) || 0));
      if (!n) return res.status(400).json({ error: 'snoozeDays must be 1–90' });
      patch.snoozeUntil = new Date(Date.now() + n * DAY_MS);
      patch.status = 'snoozed';
    }

    if (body.status !== undefined) {
      if (!FOLLOWUP_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
      patch.status = body.status;
      // Reactivating clears the snooze; leaving 'lost' keeps any provided reason.
      if (body.status === 'open' || body.status === 'recovered') patch.snoozeUntil = null;
      if (body.status !== 'lost' && body.lostReason === undefined) patch.lostReason = '';
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const f = await upsertFollowup(String(client._id), patch, req.userId);
    await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_FOLLOWUP_UPDATED', {
      clientId: String(client._id), fields: Object.keys(patch),
    });
    res.json({ success: true, followup: followupDTO(f) });
  } catch (error) {
    console.error('Update renewal follow-up error:', error);
    res.status(500).json({ error: 'Failed to update follow-up' });
  }
});

// POST /:clientId/extend — one-click renew of a SINGLE expiring service, in whichever store owns
// it. Unifies the "+N days" action across the dedicated modules so Renewals can renew every service
// consistently. Body: { module: 'proxy'|'stealth'|'core', id, durationDays? }.
//   - Core tools are renewed via the existing /admin/assignments/:id/extend route (the frontend
//     calls that directly and it is left untouched); this handler also accepts 'core' as a safe
//     fallback. Proxy/StealthWriter extend their own expiryDate here.
// Extends from the current (still-future) expiry, else from today — same rule as assignments/extend.
router.post('/:clientId/extend', async (req, res) => {
  try {
    const { clientId } = req.params;
    const moduleName = ['proxy', 'stealth', 'core'].includes(req.body && req.body.module) ? req.body.module : 'core';
    const id = String((req.body && req.body.id) || '');
    const days = Math.min(3650, Math.max(1, parseInt(req.body && req.body.durationDays, 10) || 30));
    if (!id) return res.status(400).json({ error: 'Missing service id' });

    const now = new Date();
    const extendFrom = (cur) => {
      const c = cur ? new Date(cur) : null;
      const base = c && !isNaN(c.getTime()) && c.getTime() > now.getTime() ? c : now;
      return new Date(base.getTime() + days * DAY_MS);
    };

    if (moduleName === 'proxy') {
      const pc = await ProxyClient.findById(id);
      if (!pc || String(pc.userId) !== String(clientId)) return res.status(404).json({ error: 'Service not found for this client' });
      pc.expiryDate = extendFrom(pc.expiryDate);
      if (pc.status === 'disabled') pc.status = 'active'; // renewing re-activates a disabled grant
      await pc.save();
      await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_EXTENDED', { clientId: String(clientId), module: 'proxy', tool: pc.tool, days, endDate: pc.expiryDate });
      return res.json({ success: true, module: 'proxy', newEndDate: pc.expiryDate });
    }

    if (moduleName === 'stealth') {
      const sc = await StealthClient.findById(id);
      if (!sc || String(sc.userId) !== String(clientId)) return res.status(404).json({ error: 'Service not found for this client' });
      sc.expiryDate = extendFrom(sc.expiryDate);
      if (sc.status === 'disabled') sc.status = 'active';
      await sc.save();
      await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_EXTENDED', { clientId: String(clientId), module: 'stealth', days, endDate: sc.expiryDate });
      return res.json({ success: true, module: 'stealth', newEndDate: sc.expiryDate });
    }

    // core (ToolAssignment) — fallback path (frontend normally uses /admin/assignments/:id/extend).
    const a = await ToolAssignment.findById(id);
    if (!a || String(a.clientId) !== String(clientId)) return res.status(404).json({ error: 'Service not found for this client' });
    a.endDate = extendFrom(a.endDate);
    a.status = 'active';
    a.revokedAt = null;
    await a.save();
    await ActivityLog.log('ADMIN', req.userId, 'RENEWAL_EXTENDED', { clientId: String(clientId), module: 'core', toolId: String(a.toolId || ''), days, endDate: a.endDate });
    return res.json({ success: true, module: 'core', newEndDate: a.endDate });
  } catch (error) {
    console.error('Renewal extend error:', error);
    res.status(500).json({ error: 'Failed to renew this service' });
  }
});

module.exports = router;

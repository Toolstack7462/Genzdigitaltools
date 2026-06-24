'use strict';
/**
 * Admin Marketing / Offers hub — structured promotional offers (combo bundles,
 * renewal, upgrade, recovery). Mounted at /api/crm/admin/offers. Admin-auth only.
 *
 * Reuses existing infra: Tool (for included-tool names), utils/email.sendOfferEmail
 * (Resend; degrades gracefully), ActivityLog (audit). Distinct from Announcement
 * (plain notices) and the Renewals follow-up offers (per-client recovery) — no
 * duplication. No secrets are stored or returned.
 */
const express = require('express');
const router = express.Router();
const Offer = require('../../models/Offer');
const Tool = require('../../models/Tool');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');
const { isEmailEnabled, sendOfferEmail } = require('../../utils/email');

router.use(requireAuth);
router.use(requireAdmin);

const KINDS = ['combo', 'renewal', 'upgrade', 'recovery'];

function dto(o) {
  const x = typeof o.toObject === 'function' ? o.toObject() : o;
  return {
    _id: x._id,
    title: x.title || '',
    description: x.description || '',
    kind: KINDS.includes(x.kind) ? x.kind : 'combo',
    toolIds: Array.isArray(x.toolIds) ? x.toolIds : [],
    toolNames: Array.isArray(x.toolNames) ? x.toolNames : [],
    priceText: x.priceText || '',
    expiryDate: x.expiryDate || null,
    active: x.active !== false,
    showOnDashboard: !!x.showOnDashboard,
    clientId: x.clientId || null,
    clientLabel: x.clientLabel || null,
    createdAt: x.createdAt || null,
    updatedAt: x.updatedAt || null,
  };
}

// Resolve included tool ids → safe display names (denormalized so clients never
// query the tools collection). Caps at 12 tools. Fail-safe.
async function resolveToolNames(toolIds) {
  const ids = Array.isArray(toolIds) ? [...new Set(toolIds.map(String).filter(Boolean))].slice(0, 12) : [];
  if (!ids.length) return { toolIds: [], toolNames: [] };
  try {
    const tools = await Tool.find({ _id: { $in: ids } }).select('name');
    const nameById = {};
    (tools || []).forEach(t => { nameById[String(t._id)] = t.name; });
    const keep = ids.filter(id => nameById[id]);
    return { toolIds: keep, toolNames: keep.map(id => nameById[id]) };
  } catch (_) { return { toolIds: ids, toolNames: [] }; }
}

// Resolve an optional target client → { clientId, clientLabel } (or all-clients).
async function resolveTarget(clientId) {
  if (!clientId) return { clientId: null, clientLabel: null };
  const u = await User.findOne({ _id: clientId, role: 'CLIENT' }).select('fullName email');
  if (!u) return null;
  return { clientId: String(u._id), clientLabel: u.fullName || u.email || 'Client' };
}

// GET / — all offers, newest first.
router.get('/', async (req, res) => {
  try {
    const rows = await Offer.find({}).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, emailEnabled: isEmailEnabled(), offers: (rows || []).map(dto) });
  } catch (e) {
    console.error('List offers error:', e.message);
    res.status(500).json({ error: 'Failed to list offers' });
  }
});

// POST / — create.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Title is required' });
    const target = await resolveTarget(b.clientId);
    if (target === null) return res.status(400).json({ error: 'Target client not found' });
    const { toolIds, toolNames } = await resolveToolNames(b.toolIds);
    const o = await Offer.create({
      title: String(b.title).trim().slice(0, 160),
      description: String(b.description || '').trim().slice(0, 1000),
      kind: KINDS.includes(b.kind) ? b.kind : 'combo',
      toolIds, toolNames,
      priceText: String(b.priceText || '').trim().slice(0, 80),
      expiryDate: b.expiryDate || null,
      active: b.active !== false,
      showOnDashboard: !!b.showOnDashboard,
      clientId: target.clientId, clientLabel: target.clientLabel,
      createdBy: req.userId,
    });
    await ActivityLog.log('ADMIN', req.userId, 'OFFER_CREATED', { offerId: o._id, kind: o.kind });
    res.status(201).json({ success: true, offer: dto(o) });
  } catch (e) {
    console.error('Create offer error:', e.message);
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

// PATCH /:id — update fields and/or toggle active/showOnDashboard.
router.patch('/:id', async (req, res) => {
  try {
    const o = await Offer.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const b = req.body || {};
    if (b.title !== undefined) o.title = String(b.title).trim().slice(0, 160);
    if (b.description !== undefined) o.description = String(b.description).trim().slice(0, 1000);
    if (b.kind !== undefined && KINDS.includes(b.kind)) o.kind = b.kind;
    if (b.priceText !== undefined) o.priceText = String(b.priceText).trim().slice(0, 80);
    if (b.expiryDate !== undefined) o.expiryDate = b.expiryDate || null;
    if (b.active !== undefined) o.active = !!b.active;
    if (b.showOnDashboard !== undefined) o.showOnDashboard = !!b.showOnDashboard;
    if (b.toolIds !== undefined) { const r = await resolveToolNames(b.toolIds); o.toolIds = r.toolIds; o.toolNames = r.toolNames; }
    if (b.clientId !== undefined) {
      const target = await resolveTarget(b.clientId);
      if (target === null) return res.status(400).json({ error: 'Target client not found' });
      o.clientId = target.clientId; o.clientLabel = target.clientLabel;
    }
    await o.save();
    await ActivityLog.log('ADMIN', req.userId, 'OFFER_UPDATED', { offerId: o._id });
    res.json({ success: true, offer: dto(o) });
  } catch (e) {
    console.error('Update offer error:', e.message);
    res.status(500).json({ error: 'Failed to update offer' });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const o = await Offer.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    await o.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'OFFER_DELETED', { offerId: req.params.id });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete offer error:', e.message);
    res.status(500).json({ error: 'Failed to delete offer' });
  }
});

// POST /:id/email — email this offer to one client (manual; WhatsApp is client-side).
router.post('/:id/email', async (req, res) => {
  try {
    const o = await Offer.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const clientId = req.body && req.body.clientId;
    if (!clientId) return res.status(400).json({ error: 'Select a client to email' });
    const client = await User.findOne({ _id: clientId, role: 'CLIENT' });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!isEmailEnabled()) return res.json({ success: false, emailEnabled: false, message: 'Email is not configured on the server. Use WhatsApp instead.' });
    if (!client.email) return res.status(400).json({ error: 'This client has no email address on file.' });
    const r = await sendOfferEmail(client.email, { clientName: client.fullName, offer: dto(o) });
    if (r && r.error) return res.json({ success: false, error: r.error, domainNotVerified: !!r.domainNotVerified });
    await ActivityLog.log('ADMIN', req.userId, 'OFFER_SENT', { offerId: o._id, channel: 'email', clientId: String(client._id) });
    res.json({ success: true, channel: 'email', sentAt: new Date() });
  } catch (e) {
    console.error('Send offer email error:', e.message);
    res.status(500).json({ error: 'Failed to send offer email' });
  }
});

module.exports = router;

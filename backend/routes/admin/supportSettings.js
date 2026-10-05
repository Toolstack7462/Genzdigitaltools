'use strict';
/**
 * Admin → Support Contact. Mounted at /api/crm/admin/support-settings. Admin-auth protected.
 *
 * Edits ONLY the public support WhatsApp number + support email (utils/supportContact.js).
 * The website, client dashboard, emails and extension expired page read the change through
 * GET /api/crm/public/support-contact (cached ≤ 60 s per worker). No tool, session or
 * credential behaviour depends on these values.
 */
const express = require('express');
const router = express.Router();
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');
const { getAdminView, updateSupportContact } = require('../../utils/supportContact');

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/crm/admin/support-settings
router.get('/', async (req, res) => {
  try {
    res.json({ success: true, ...(await getAdminView()) });
  } catch (err) {
    console.error('[support-settings] get failed:', err.message);
    res.status(500).json({ error: 'Failed to load support settings' });
  }
});

// PUT /api/crm/admin/support-settings  { whatsappNumber?, supportEmail? }  ('' = use fallback)
router.put('/', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.whatsappNumber !== undefined) patch.whatsappNumber = body.whatsappNumber;
    if (body.supportEmail !== undefined) patch.supportEmail = body.supportEmail;
    const before = (await getAdminView()).contact;
    const contact = await updateSupportContact(patch, req.userId);
    await ActivityLog.log('ADMIN', req.userId, 'SUPPORT_CONTACT_UPDATED', {
      whatsappFrom: before.whatsappNumber, whatsappTo: contact.whatsappNumber,
      emailFrom: before.email, emailTo: contact.email,
    });
    res.json({ success: true, ...(await getAdminView()) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[support-settings] update failed:', err.message);
    res.status(500).json({ error: 'Failed to save support settings' });
  }
});

module.exports = router;

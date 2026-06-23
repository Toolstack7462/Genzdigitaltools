'use strict';
/**
 * Client presence heartbeat — feeds the admin Client Activity Monitor.
 * Mounted at /api/crm/client/presence.
 *
 * The client dashboard calls POST /ping on load and on its existing ~45s poll
 * cadence (and on tab focus). This is the "dashboard opened / still here" signal
 * for clients who are NOT using the extension. It is deliberately minimal: no
 * body required, records only a safe presence row, and responds immediately
 * (presence is written fire-and-forget so it adds no latency).
 */
const express = require('express');
const router = express.Router();
const { requireClientAuth, getClientIp } = require('../../middleware/authEnhanced');
const { recordPresence } = require('../../utils/presence');

router.post('/ping', requireClientAuth, async (req, res) => {
  // Respond first; never block on the presence write.
  res.json({ success: true, serverTime: new Date().toISOString() });
  recordPresence({
    clientId: req.userId,
    clientName: req.user && req.user.fullName,
    clientEmail: req.user && req.user.email,
    event: 'dashboard',
    ip: getClientIp(req),
  });
});

module.exports = router;

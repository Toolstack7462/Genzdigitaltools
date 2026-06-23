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
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireClientAuth, getClientIp } = require('../../middleware/authEnhanced');
const { recordPresence } = require('../../utils/presence');

// Defense-in-depth cap on the heartbeat. Keyed by the AUTHENTICATED clientId
// (requireClientAuth runs first) — NOT req.ip, which behind Hostinger's CDN is a
// rotating/shared edge IP that would lock unrelated clients out together. A 45s
// heartbeat needs ~2/min; 30/min leaves wide headroom while capping a flood. A
// 429 here is harmless: the client ignores ping failures.
const pingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.userId || getClientIp(req) || 'unknown'),
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many presence pings.' },
});

router.post('/ping', requireClientAuth, pingLimiter, async (req, res) => {
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

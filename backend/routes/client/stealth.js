'use strict';
/**
 * Client routes for the StealthWriter Proxy Gateway module.
 * Mounted at /api/crm/client/stealth.
 *
 *  GET  /          → dashboard data (plan, status, expiry, used/remaining, reset time)
 *  POST /open      → validate status/expiry/limits, mint a signed lease, return the
 *                    gateway open URL (https://stealth1.genzdigitalstore.com/gateway?lease=…)
 */
const express = require('express');
const router = express.Router();

const StealthClient = require('../../models/stealth/StealthClient');
const StealthLease = require('../../models/stealth/StealthLease');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole, getClientIp } = require('../../middleware/authEnhanced');
const access = require('../../utils/stealth/access');
const config = require('../../utils/stealth/config');
const lease = require('../../utils/stealth/lease');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');

router.use(requireAuth);
router.use(requireRole('CLIENT'));

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const client = await StealthClient.findOne({ userId: req.userId });
    if (!client) {
      return res.json({ success: true, hasPlan: false, resetLabel: RESET_LABEL });
    }
    const snap = await access.snapshot(client);
    return res.json({
      success: true,
      hasPlan: true,
      plan: {
        planName: client.planName,
        status: snap.status,
        active: snap.active,
        expired: snap.expired,
        expiryDate: snap.expiryDate,
        limits: snap.limits,
        used: snap.used,
        remaining: snap.remaining,
      },
      resetLabel: RESET_LABEL,
      nextResetAt: nextResetAt(),
    });
  } catch (err) {
    console.error('Stealth client dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load StealthWriter dashboard' });
  }
});

// ─── Open StealthWriter (mint a lease) ──────────────────────────────────────────
router.post('/open', async (req, res) => {
  try {
    const client = await StealthClient.findOne({ userId: req.userId });
    if (!client) return res.status(404).json({ error: 'No StealthWriter plan assigned', code: 'no_plan' });

    // Re-validate against the database (single source of truth) — never trust the client.
    const snap = await access.snapshot(client);
    if (!snap.active) {
      const code = snap.expired ? 'plan_expired' : 'client_disabled';
      return res.status(403).json({ error: snap.expired ? 'Your StealthWriter plan has expired' : 'Your StealthWriter access is disabled', code });
    }
    // Block opening only when there is no usable capacity at all today.
    const hRem = snap.remaining.humanizer; // null = unlimited
    const dRem = snap.remaining.detector;
    const noCapacity = (hRem !== null && hRem <= 0) && (dRem !== null && dRem <= 0);
    if (noCapacity) {
      return res.status(403).json({ error: 'Daily limit reached for both Humanizer and AI Detector', code: 'limit_reached' });
    }

    const settings = await config.getSettingsObject();
    const ttlMinutes = config.effectiveLeaseMinutes(settings);
    const fixed = settings.fixedLeaseEnabled;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000);

    // Create the lease row first so its id becomes the token's jti.
    const leaseRow = await StealthLease.create({
      userId: req.userId,
      stealthClientId: client._id,
      issuedAt, expiresAt,
      fixedLease: fixed,
      revoked: false,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
    });

    const token = lease.signLease({
      jti: leaseRow._id,
      userId: req.userId,
      stealthClientId: client._id,
      fixed,
      ttlMinutes,
    });
    // Store only the hash — never the raw token.
    leaseRow.tokenHash = lease.hashToken(token);
    await leaseRow.save();

    await ActivityLog.log('CLIENT', req.userId, 'STEALTH_LEASE_ISSUED', {
      stealthClientId: client._id, leaseId: leaseRow._id, ttlMinutes, fixed, ip: getClientIp(req),
    });

    return res.json({
      success: true,
      url: lease.gatewayUrl(token),
      lease: { id: leaseRow._id, expiresAt, durationMinutes: ttlMinutes, fixedLease: fixed },
    });
  } catch (err) {
    console.error('Stealth open error:', err.message);
    return res.status(500).json({ error: 'Failed to open StealthWriter' });
  }
});

module.exports = router;

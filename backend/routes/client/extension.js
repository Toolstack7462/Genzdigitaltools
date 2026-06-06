const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const DeviceBinding = require('../../models/DeviceBinding');
const ActivityLog = require('../../models/ActivityLog');
const ActivationToken = require('../../models/ActivationToken');
const { requireAuth, requireRole, getClientIp } = require('../../middleware/authEnhanced');

const TOKEN_TTL_MS = 2 * 60 * 1000;

router.use(requireAuth);
router.use(requireRole('CLIENT'));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * POST /api/crm/client/extension/activation-token
 * Issues a short-lived activation token from an already-authenticated website
 * session. The token lets the installed extension pair without asking the
 * client to login again inside the popup.
 */
router.post('/activation-token', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    const ip = getClientIp(req);

    let deviceIdHash = null;
    if (req.user?.devicePolicy?.enabled && deviceId) {
      // Soft mode: trust the already-authenticated session. Login already created
      // the binding if it was missing. Here we just record the device hash for
      // correlation; hard mode still requires an exact binding match.
      const BINDING_MODE = (process.env.DEVICE_BINDING_MODE || 'soft').toLowerCase();
      deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
      const binding = await DeviceBinding.findOne({ clientId: req.userId, deviceIdHash });
      if (binding) {
        binding.lastSeenAt = new Date();
        await binding.save();
      } else if (BINDING_MODE === 'hard') {
        return res.status(403).json({ error: 'Device binding mismatch', code: 'DEVICE_MISMATCH' });
      }
      // Soft mode: proceed — the session is already authenticated.
    } else if (deviceId) {
      deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
    }

    const issued = await ActivationToken.issue({
      clientId: req.userId,
      deviceIdHash,
      ip,
      userAgent: req.headers['user-agent'],
      ttlMs: TOKEN_TTL_MS,
    });

    await ActivityLog.log('CLIENT', req.userId, 'EXTENSION_ACTIVATION_TOKEN', {
      activationId: issued.id,
      deviceIdHash,
      expiresAt: issued.expiresAt.toISOString(),
      ip,
      userAgent: req.headers['user-agent']
    });

    return res.json({
      success: true,
      activationToken: issued.token,
      expiresAt: issued.expiresAt.toISOString()
    });
  } catch (err) {
    console.error('Create extension activation token error:', err);
    return res.status(500).json({ error: 'Failed to create extension activation token' });
  }
});

module.exports = router;

const express = require('express');
const crypto = require('crypto');

/** Hash refresh token before DB lookup */
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const router = express.Router();
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const DeviceBinding = require('../models/DeviceBinding');
const ActivityLog = require('../models/ActivityLog');
const {
  generateTokenPair,
  verifyRefreshToken,
  requireAuth,
  getClientIp
} = require('../middleware/authEnhanced');
const { validate, schemas } = require('../middleware/validation');
const { normalizeAuthInputs } = require('../middleware/normalize');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');

// ─── Cookie helper — keeps set/clear options in sync ────────────────────────
const COOKIE_OPTS = (maxAgeMs) => ({
  httpOnly: true,
  maxAge: maxAgeMs,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
});
const ACCESS_MAX   = 15 * 60 * 1000;
const REFRESH_MAX  = 7 * 24 * 60 * 60 * 1000;

// ─── POST /api/crm/auth/admin/login ─────────────────────────────────────────
// FIX1: Tokens no longer in JSON body  FIX2: Status check before bcrypt
router.post('/admin/login', authLimiter, normalizeAuthInputs, validate(schemas.adminLogin), async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);

    const admin = await User.findOne({ email, role: { $in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] } });

    if (!admin) {
      await ActivityLog.log('SYSTEM', null, 'ADMIN_LOGIN_FAILED', { email, reason: 'User not found', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // FIX2: Check disabled BEFORE bcrypt to avoid timing leak
    if (admin.status === 'disabled') {
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_BLOCKED', { reason: 'Account disabled', ip });
      return res.status(403).json({ error: 'Your account has been disabled' });
    }

    const isValid = await admin.comparePassword(password);
    if (!isValid) {
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_FAILED', { email, reason: 'Invalid password', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    admin.lastLoginAt = new Date();
    admin.lastLoginIp = ip;
    await admin.save();

    const { accessToken, refreshToken } = await generateTokenPair(admin, ip);
    await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN', { ip });

    // FIX1: httpOnly cookies only — no tokens in body
    res.cookie('accessToken', accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('refreshToken', refreshToken, COOKIE_OPTS(REFRESH_MAX));

    return res.json({ success: true, user: admin.toJSON() });
  } catch (err) {
    console.error('Admin login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /api/crm/auth/client/login ────────────────────────────────────────
router.post('/client/login', authLimiter, normalizeAuthInputs, validate(schemas.clientLogin), async (req, res) => {
  try {
    const { email, password, deviceId } = req.body;
    const ip = getClientIp(req);

    const client = await User.findOne({ email, role: 'CLIENT' });

    if (!client) {
      await ActivityLog.log('SYSTEM', null, 'CLIENT_LOGIN_FAILED', { email, reason: 'User not found', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // FIX2: Status check before bcrypt
    if (client.status === 'disabled') {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_BLOCKED', { reason: 'Account disabled', ip });
      return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
    }

    const isValid = await client.comparePassword(password);
    if (!isValid) {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_FAILED', { email, reason: 'Invalid password', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Device binding
    if (client.devicePolicy.enabled) {
      const deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
      const existing = await DeviceBinding.findOne({ clientId: client._id });

      if (!existing) {
        await DeviceBinding.create({ clientId: client._id, deviceIdHash, userAgent: req.headers['user-agent'] });
        await ActivityLog.log('CLIENT', client._id, 'DEVICE_BOUND', { deviceId: deviceIdHash.substring(0, 10) + '...', ip });
      } else if (existing.deviceIdHash !== deviceIdHash) {
        await ActivityLog.log('CLIENT', client._id, 'LOGIN_BLOCKED_DEVICE', { ip });
        return res.status(403).json({ error: 'Account is locked to another device. Contact admin.', code: 'DEVICE_MISMATCH' });
      } else {
        existing.lastSeenAt = new Date();
        await existing.save();
      }
    }

    client.lastLoginAt = new Date();
    client.lastLoginIp = ip;
    await client.save();

    const { accessToken, refreshToken } = await generateTokenPair(client, ip);
    await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN', { ip });

    // FIX1: httpOnly cookies only
    res.cookie('accessToken', accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('refreshToken', refreshToken, COOKIE_OPTS(REFRESH_MAX));

    return res.json({ success: true, user: client.toJSON() });
  } catch (err) {
    console.error('Client login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /api/crm/auth/refresh ──────────────────────────────────────────────
// FIX: Opaque refresh tokens are stored in DB — no JWT.verify() needed.
// DB lookup + isActive check (expiry + revoked) is the correct approach.
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const ip = getClientIp(req);

    if (!token) return res.status(401).json({ error: 'Refresh token required' });

    // Hash the incoming opaque token before DB lookup (DB stores only the hash)
    const tokenHash = hashToken(token);
    const stored = await RefreshToken.findOne({ token: tokenHash });
    if (!stored || !stored.isActive) return res.status(401).json({ error: 'Refresh token expired or revoked' });

    const user = await User.findById(stored.userId);
    if (!user || user.status === 'disabled') return res.status(401).json({ error: 'User not found or disabled' });

    const newTokens = await generateTokenPair(user, ip);

    stored.revokedAt = new Date();
    stored.revokedByIp = ip;
    stored.replacedByToken = hashToken(newTokens.refreshToken); // store hash, not raw
    await stored.save();

    await ActivityLog.log(user.role, user._id, 'TOKEN_REFRESHED', { ip });

    res.cookie('accessToken', newTokens.accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('refreshToken', newTokens.refreshToken, COOKIE_OPTS(REFRESH_MAX));

    // FIX1: No tokens in body
    return res.json({ success: true });
  } catch (err) {
    console.error('Token refresh error:', err);
    return res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// ─── POST /api/crm/auth/logout ───────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const ip = getClientIp(req);

    if (token) await RefreshToken.revokeToken(hashToken(token), ip);

    await ActivityLog.log(req.userRole, req.userId, 'LOGOUT', { ip });

    // FIX3: clearCookie must match set options
    const clearOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
    res.clearCookie('accessToken', clearOpts);
    res.clearCookie('refreshToken', clearOpts);

    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

// ─── GET /api/crm/auth/me ────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    return res.json({ success: true, user: req.user.toJSON() });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── POST /api/crm/auth/register ─────────────────────────────────────────────
router.post('/register', registerLimiter, validate(schemas.register), async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    const ip = getClientIp(req);

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'An account with this email already exists' });

    const client = await User.create({
      fullName, email, passwordHash: password,
      role: 'CLIENT', status: 'active',
      devicePolicy: { enabled: true, maxDevices: 1 }
    });

    await ActivityLog.log('SYSTEM', null, 'CLIENT_REGISTERED', { clientId: client._id.toString(), clientEmail: email, ip });

    return res.status(201).json({ success: true, message: 'Account created. You can now login.', user: client.toJSON() });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

module.exports = router;

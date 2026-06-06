const express = require('express');
const crypto = require('crypto');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const router = express.Router();
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const DeviceBinding = require('../models/DeviceBinding');
const ActivityLog = require('../models/ActivityLog');
const {
  generateTokenPair,
  requireAuth,
  requireAdminAuth,
  requireClientAuth,
  getClientIp
} = require('../middleware/authEnhanced');
const { validate, schemas } = require('../middleware/validation');
const { normalizeAuthInputs } = require('../middleware/normalize');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');

// ─── Cookie helpers ──────────────────────────────────────────────────────────
const COOKIE_OPTS = (maxAgeMs) => ({
  httpOnly: true,
  maxAge: maxAgeMs,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
});
const CLEAR_OPTS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
};
const ACCESS_MAX  = 15 * 60 * 1000;
const REFRESH_MAX = Number(process.env.DASHBOARD_SESSION_DAYS || 30) * 24 * 60 * 60 * 1000;

// ─── POST /api/crm/auth/admin/login ─────────────────────────────────────────
router.post('/admin/login', authLimiter, normalizeAuthInputs, validate(schemas.adminLogin), async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);

    const admin = await User.findOne({ email, role: { $in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] } });
    if (!admin) {
      await ActivityLog.log('SYSTEM', null, 'ADMIN_LOGIN_FAILED', { email, reason: 'User not found', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

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

    // Role-specific cookie names — isolated from client session cookies
    res.cookie('adminAccessToken', accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('adminRefreshToken', refreshToken, COOKIE_OPTS(REFRESH_MAX));

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

    if (client.status === 'disabled') {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_BLOCKED', { reason: 'Account disabled', ip });
      return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
    }

    const isValid = await client.comparePassword(password);
    if (!isValid) {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_FAILED', { email, reason: 'Invalid password', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (client.devicePolicy && client.devicePolicy.enabled) {
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

    // Role-specific cookie names — isolated from admin session cookies
    res.cookie('clientAccessToken', accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('clientRefreshToken', refreshToken, COOKIE_OPTS(REFRESH_MAX));

    return res.json({ success: true, user: client.toJSON() });
  } catch (err) {
    console.error('Client login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Shared refresh handler ───────────────────────────────────────────────────
async function handleRefresh(req, res, refreshCookieName, accessCookieName, newRefreshCookieName) {
  try {
    const token = req.cookies[refreshCookieName] || req.body.refreshToken;
    const ip = getClientIp(req);

    if (!token) return res.status(401).json({ error: 'Refresh token required' });

    const tokenHash = hashToken(token);
    const stored = await RefreshToken.findOne({ token: tokenHash });
    if (!stored || !stored.isActive) return res.status(401).json({ error: 'Refresh token expired or revoked' });

    const user = await User.findById(stored.userId);
    if (!user || user.status === 'disabled') return res.status(401).json({ error: 'User not found or disabled' });

    const newTokens = await generateTokenPair(user, ip);

    stored.revokedAt = new Date();
    stored.revokedByIp = ip;
    stored.replacedByToken = hashToken(newTokens.refreshToken);
    await stored.save();

    await ActivityLog.log(user.role, user._id, 'TOKEN_REFRESHED', { ip });

    res.cookie(accessCookieName, newTokens.accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie(newRefreshCookieName, newTokens.refreshToken, COOKIE_OPTS(REFRESH_MAX));

    return res.json({ success: true });
  } catch (err) {
    console.error('Token refresh error:', err);
    return res.status(500).json({ error: 'Failed to refresh token' });
  }
}

// ─── POST /api/crm/auth/admin/refresh ────────────────────────────────────────
router.post('/admin/refresh', (req, res) =>
  handleRefresh(req, res, 'adminRefreshToken', 'adminAccessToken', 'adminRefreshToken')
);

// ─── POST /api/crm/auth/client/refresh ───────────────────────────────────────
router.post('/client/refresh', (req, res) =>
  handleRefresh(req, res, 'clientRefreshToken', 'clientAccessToken', 'clientRefreshToken')
);

// ─── POST /api/crm/auth/refresh (backward compat) ────────────────────────────
router.post('/refresh', (req, res) => {
  if (req.cookies.adminRefreshToken) {
    return handleRefresh(req, res, 'adminRefreshToken', 'adminAccessToken', 'adminRefreshToken');
  }
  if (req.cookies.clientRefreshToken) {
    return handleRefresh(req, res, 'clientRefreshToken', 'clientAccessToken', 'clientRefreshToken');
  }
  // Legacy cookie name fallback
  return handleRefresh(req, res, 'refreshToken', 'accessToken', 'refreshToken');
});

// ─── Shared logout handler ───────────────────────────────────────────────────
async function handleLogout(req, res, refreshCookieName, accessCookieName) {
  try {
    const token = req.cookies[refreshCookieName] || req.body.refreshToken;
    const ip = getClientIp(req);

    if (token) await RefreshToken.revokeToken(hashToken(token), ip);

    await ActivityLog.log(req.userRole, req.userId, 'LOGOUT', { ip });

    res.clearCookie(accessCookieName, CLEAR_OPTS);
    res.clearCookie(refreshCookieName, CLEAR_OPTS);

    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
}

// ─── POST /api/crm/auth/admin/logout ─────────────────────────────────────────
router.post('/admin/logout', requireAdminAuth, (req, res) =>
  handleLogout(req, res, 'adminRefreshToken', 'adminAccessToken')
);

// ─── POST /api/crm/auth/client/logout ────────────────────────────────────────
router.post('/client/logout', requireClientAuth, (req, res) =>
  handleLogout(req, res, 'clientRefreshToken', 'clientAccessToken')
);

// ─── POST /api/crm/auth/logout (backward compat) ─────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  if (req.cookies.adminRefreshToken) {
    return handleLogout(req, res, 'adminRefreshToken', 'adminAccessToken');
  }
  if (req.cookies.clientRefreshToken) {
    return handleLogout(req, res, 'clientRefreshToken', 'clientAccessToken');
  }
  return handleLogout(req, res, 'refreshToken', 'accessToken');
});

// ─── GET /api/crm/auth/admin/me ───────────────────────────────────────────────
router.get('/admin/me', requireAdminAuth, async (req, res) => {
  try {
    return res.json({ success: true, user: req.user.toJSON() });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── GET /api/crm/auth/client/me ─────────────────────────────────────────────
router.get('/client/me', requireClientAuth, async (req, res) => {
  try {
    return res.json({ success: true, user: req.user.toJSON() });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── GET /api/crm/auth/me (backward compat) ──────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    return res.json({ success: true, user: req.user.toJSON() });
  } catch (err) {
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

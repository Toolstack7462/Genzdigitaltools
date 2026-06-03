// ============================================================
// DEPRECATED: This file is superseded by its Enhanced version.
// DO NOT IMPORT this file in new code. It will be deleted.
// See the corresponding *Enhanced.js or server-crm.js file.
// ============================================================

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
  verifyRefreshToken, 
  requireAuth,
  getClientIp 
} = require('../middleware/authEnhanced');
const { validate, schemas } = require('../middleware/validation');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');

// Cookie options helper — keeps set/clear options in sync
function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    maxAge: maxAgeMs,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production'
  };
}
const ACCESS_MAX_AGE  = 15 * 60 * 1000;       // 15 minutes
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// POST /api/crm/auth/admin/login
// FIX (Bug 2): Added authLimiter — admin endpoint was previously unprotected against brute-force.
router.post('/admin/login', authLimiter, validate(schemas.adminLogin), async (req, res) => {
  try {
    const { email, password } = req.body;
    const ipAddress = getClientIp(req);
    
    const admin = await User.findOne({ 
      email, 
      role: { $in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] }
    });
    
    if (!admin) {
      await ActivityLog.log('SYSTEM', null, 'ADMIN_LOGIN_FAILED', { email, reason: 'User not found', ipAddress });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // FIX (Bug 4): Check disabled status BEFORE running bcrypt compare.
    if (admin.status === 'disabled') {
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_BLOCKED', { reason: 'Account disabled', ipAddress });
      return res.status(403).json({ error: 'Your account has been disabled' });
    }
    
    const isValid = await admin.comparePassword(password);
    if (!isValid) {
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_FAILED', { email, reason: 'Invalid password', ipAddress });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    admin.lastLoginAt = new Date();
    admin.lastLoginIp = ipAddress;
    await admin.save();
    
    const { accessToken, refreshToken } = await generateTokenPair(admin, ipAddress);
    
    await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN', { ipAddress });
    
    // FIX (Bug 1): Set httpOnly cookies only — do NOT return tokens in response body.
    res.cookie('accessToken', accessToken, cookieOptions(ACCESS_MAX_AGE));
    res.cookie('refreshToken', refreshToken, cookieOptions(REFRESH_MAX_AGE));
    
    res.json({ success: true, user: admin.toJSON() });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/crm/auth/client/login
router.post('/client/login', authLimiter, validate(schemas.clientLogin), async (req, res) => {
  try {
    const { email, password, deviceId } = req.body;
    const ipAddress = getClientIp(req);
    
    const client = await User.findOne({ email, role: 'CLIENT' });
    if (!client) {
      await ActivityLog.log('SYSTEM', null, 'CLIENT_LOGIN_FAILED', { email, reason: 'User not found', ipAddress });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // FIX (Bug 4): Check disabled status BEFORE bcrypt compare.
    if (client.status === 'disabled') {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_BLOCKED', { reason: 'Account disabled', ipAddress });
      return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
    }
    
    const isValid = await client.comparePassword(password);
    if (!isValid) {
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_FAILED', { email, reason: 'Invalid password', ipAddress });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Device binding check
    if (client.devicePolicy.enabled) {
      const deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
      const existingBinding = await DeviceBinding.findOne({ clientId: client._id });
      
      if (!existingBinding) {
        await DeviceBinding.create({ clientId: client._id, deviceIdHash, userAgent: req.headers['user-agent'] });
        await ActivityLog.log('CLIENT', client._id, 'DEVICE_BOUND', { deviceId: deviceIdHash.substring(0, 10) + '...', ipAddress });
      } else if (existingBinding.deviceIdHash !== deviceIdHash) {
        await ActivityLog.log('CLIENT', client._id, 'LOGIN_BLOCKED_DEVICE', { attemptedDevice: deviceIdHash.substring(0, 10) + '...', ipAddress });
        return res.status(403).json({ 
          error: 'This account is locked to another device. Please contact admin to reset device access.',
          code: 'DEVICE_MISMATCH'
        });
      } else {
        existingBinding.lastSeenAt = new Date();
        await existingBinding.save();
      }
    }
    
    client.lastLoginAt = new Date();
    client.lastLoginIp = ipAddress;
    await client.save();
    
    const { accessToken, refreshToken } = await generateTokenPair(client, ipAddress);
    
    await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN', { ipAddress });
    
    // FIX (Bug 1): Set httpOnly cookies only — do NOT return tokens in response body.
    res.cookie('accessToken', accessToken, cookieOptions(ACCESS_MAX_AGE));
    res.cookie('refreshToken', refreshToken, cookieOptions(REFRESH_MAX_AGE));
    
    res.json({ success: true, user: client.toJSON() });
  } catch (error) {
    console.error('Client login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/crm/auth/refresh
// FIX (Bug 7): Read refresh token from cookie first, then fall back to body.
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const ipAddress = getClientIp(req);
    
    if (!token) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // FIXED: Use DB-only lookup (token is opaque hex, NOT a JWT)
    const refreshToken = await RefreshToken.findOne({ token: hashToken(token) });
    if (!refreshToken || !refreshToken.isActive) {
      return res.status(401).json({ error: 'Refresh token is invalid or expired' });
    }
    
    const user = await User.findById(refreshToken.userId);
    if (!user || user.status === 'disabled') {
      return res.status(401).json({ error: 'User not found or disabled' });
    }
    
    const newTokens = await generateTokenPair(user, ipAddress);
    
    refreshToken.revokedAt = new Date();
    refreshToken.revokedByIp = ipAddress;
    refreshToken.replacedByToken = newTokens.refreshToken;
    await refreshToken.save();
    
    await ActivityLog.log(user.role, user._id, 'TOKEN_REFRESHED', { ipAddress });
    
    // FIX (Bug 1): Set cookies only — no tokens in body.
    res.cookie('accessToken', newTokens.accessToken, cookieOptions(ACCESS_MAX_AGE));
    res.cookie('refreshToken', newTokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// POST /api/crm/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const ipAddress = getClientIp(req);
    
    if (token) {
      await RefreshToken.revokeToken(token, ipAddress);
    }
    
    await ActivityLog.log(req.userRole, req.userId, 'LOGOUT', { ipAddress });
    
    // FIX (Bug 3): clearCookie must use the same options as res.cookie() or the
    // browser treats it as a different cookie and ignores the expiry.
    const clearOpts = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' };
    res.clearCookie('accessToken', clearOpts);
    res.clearCookie('refreshToken', clearOpts);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/crm/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, user: req.user.toJSON() });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/crm/auth/register
router.post('/register', registerLimiter, validate(schemas.register), async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    const ipAddress = getClientIp(req);
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    
    const client = await User.create({
      fullName,
      email,
      passwordHash: password,
      role: 'CLIENT',
      status: 'active',
      devicePolicy: { enabled: true, maxDevices: 1 }
    });
    
    await ActivityLog.log('SYSTEM', null, 'CLIENT_REGISTERED', { 
      clientId: client._id.toString(), clientEmail: email, ipAddress
    });
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully. You can now login.',
      user: client.toJSON()
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

module.exports = router;

// NOTE: This file is deprecated. server-crm.js uses authEnhanced.js which 
// correctly handles opaque refresh tokens via DB lookup (not JWT verification).
// The refresh endpoint above has been patched to also use DB-only lookup.

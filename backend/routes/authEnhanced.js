const express = require('express');
const crypto = require('crypto');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const router = express.Router();
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const DeviceBinding = require('../models/DeviceBinding');
const DeviceProfile = require('../models/DeviceProfile');
const SecurityAlert = require('../models/SecurityAlert');
const ActivityLog = require('../models/ActivityLog');
const { recordPresence } = require('../utils/presence');
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

// ─── Email lookup helper ─────────────────────────────────────────────────────
// ROOT CAUSE of "valid credentials but Login failed" for SOME clients: the email
// field is lowercased on every NEW save (User preSave) and on every login request
// (normalizeAuthInputs), but the DB lookup itself was an exact, case-sensitive
// string compare. Any row whose stored email is NOT already lowercase or carries
// stray surrounding whitespace — i.e. accounts imported by the MySQL migration or
// created before email-normalisation existed — could never be found, so a correct
// email + password was rejected as "Invalid credentials". This builds an
// anchored, case-insensitive, whitespace-tolerant exact match so those accounts
// resolve correctly. It is strictly more permissive: any email that matched before
// still matches, so it cannot break a currently-working login.
function emailMatch(email) {
  const esc = String(email || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: `^\\s*${esc}\\s*$`, $options: 'i' };
}

// Mask an email for logs: keep the first char + domain, hide the local part.
//   user@gmail.com -> u***@gmail.com   (never log a full address)
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}

// Safe, structured auth logging. Pinpoints the exact failure stage without ever
// emitting passwords, tokens, cookies or password hashes. Any `email` field is masked.
function logAuth(tag, stage, info = {}) {
  try {
    const parts = Object.entries(info)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${k === 'email' ? maskEmail(v) : v}`)
      .join(' ');
    console.log(`[auth:${tag}] stage=${stage}${parts ? ' ' + parts : ''}`);
  } catch (_) { /* logging must never break the request */ }
}

// Verbose, ENV-GATED per-attempt diagnostics (DEBUG_LOGIN_DIAGNOSTICS=true). Logs ONE
// line on response 'finish', so it captures the FINAL status + timing without touching
// every return branch. Strictly non-sensitive: no body, no password/token/cookie — only
// method, path, status, ms, a derived error type, origin, truncated UA, ip, masked email
// and the correlation id. Off by default ⇒ no verbose logs are kept permanently.
const loginDebugOn = () => process.env.DEBUG_LOGIN_DIAGNOSTICS === 'true';
function attachLoginDiag(req, res, t0) {
  if (!loginDebugOn()) return;
  res.on('finish', () => {
    try {
      const sc = res.statusCode;
      const type = sc < 400 ? 'success'
        : sc === 400 ? 'validation'
        : sc === 401 ? 'invalid_credentials'
        : sc === 403 ? 'blocked'
        : sc === 429 ? 'rate_limited'
        : sc >= 500 ? 'server' : 'other';
      const ua = String(req.headers['user-agent'] || '').slice(0, 120);
      const line = [
        `rid=${req.requestId || ''}`,
        `method=${req.method}`,
        `path=${req.path}`,
        `status=${sc}`,
        `ms=${Date.now() - t0}`,
        `type=${type}`,
        `origin=${req.headers.origin || ''}`,
        `ip=${getClientIp(req)}`,
        `email=${maskEmail(req.body && req.body.email)}`,
        `ua="${ua}"`,
      ].join(' ');
      console.log(`[login-diag] ${line}`);
    } catch (_) { /* diagnostics must never break the request */ }
  });
}

// ─── POST /api/crm/auth/admin/login ─────────────────────────────────────────
router.post('/admin/login', authLimiter, normalizeAuthInputs, validate(schemas.adminLogin), async (req, res) => {
  attachLoginDiag(req, res, Date.now());
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);

    // Arrival marker — same diagnostic purpose as the client flow (see below).
    logAuth('admin', 'attempt', { rid: req.requestId, email, ip });

    const admin = await User.findOne({ email: emailMatch(email), role: { $in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] } });
    if (!admin) {
      logAuth('admin', 'user_not_found', { email, ip });
      await ActivityLog.log('SYSTEM', null, 'ADMIN_LOGIN_FAILED', { email, reason: 'User not found', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (admin.status === 'disabled') {
      logAuth('admin', 'account_disabled', { email, ip });
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_BLOCKED', { reason: 'Account disabled', ip });
      return res.status(403).json({ error: 'Your account has been disabled' });
    }

    const isValid = await admin.comparePassword(password);
    if (!isValid) {
      logAuth('admin', 'bad_password', { email, ip });
      await ActivityLog.log('ADMIN', admin._id, 'ADMIN_LOGIN_FAILED', { email, reason: 'Invalid password', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    logAuth('admin', 'success', { email, ip });

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
    // Log the FULL error server-side (stack included) so the exact failure point is
    // identifiable, but never leak internals to the client.
    logAuth('admin', 'server_error', { email: req.body && req.body.email, msg: err && err.message });
    console.error('[auth:admin] unhandled login error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Login failed. Please try again.', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/crm/auth/client/login ────────────────────────────────────────
router.post('/client/login', authLimiter, normalizeAuthInputs, validate(schemas.clientLogin), async (req, res) => {
  attachLoginDiag(req, res, Date.now());
  try {
    const { email, password, deviceId } = req.body;
    const ip = getClientIp(req);

    // Log arrival FIRST. If a "Login failed" report has NO matching `attempt` line in
    // the server log, the request never reached this handler (CORS / preflight /
    // proxy / timeout) rather than failing inside it — the single most useful split
    // for diagnosing cross-origin login failures. The rid ties it to the client Error ID.
    logAuth('client', 'attempt', { rid: req.requestId, email, ip });

    // Fetch ALL client rows matching this email (case-insensitive on both email and
    // role). Migrated/legacy data can contain DUPLICATE rows for the same address —
    // e.g. a legacy mixed-case row plus a newer lowercase one, because the create-time
    // uniqueness checks compare email case-sensitively. With a single findOne we would
    // arbitrarily pick the first row, which may be a stale duplicate whose password the
    // client never set — producing a permanent "bad password" even with valid
    // credentials. Checking every candidate fixes that. Role match is case-insensitive
    // too (the adapter compares strings exactly) but scoped to CLIENT variants only, so
    // it can never match an admin role.
    const candidates = await User.find({ email: emailMatch(email), role: { $regex: '^CLIENT$', $options: 'i' } });
    if (!candidates || candidates.length === 0) {
      // DIAGNOSTIC: distinguish "no account exists" from "account exists but is not
      // queryable as a CLIENT" (wrong/legacy role value). Logs metadata only.
      let existing = 'none';
      try {
        const any = await User.findOne({ email: emailMatch(email) });
        if (any) existing = `role=${JSON.stringify(any.role)},status=${any.status || 'unset'},verified=${any.emailVerified}`;
      } catch (_) {}
      logAuth('client', 'user_not_found', { email, ip, existing });
      await ActivityLog.log('SYSTEM', null, 'CLIENT_LOGIN_FAILED', { email, reason: 'User not found', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Pick the candidate whose password actually matches (across any duplicates).
    let client = null;
    for (const c of candidates) {
      try { if (await c.comparePassword(password)) { client = c; break; } } catch (_) {}
    }

    if (!client) {
      // No candidate matched the password. Log how many duplicate rows exist + each
      // hash FORMAT (first 7 chars = bcrypt header "$2b$12$" — no salt/secret) so a
      // genuine wrong-password is distinguishable from a duplicate/legacy-hash issue.
      const fmts = candidates.map(c => { const h = String(c.passwordHash || ''); return `${h.slice(0, 7)}:${h.length}`; }).join(',');
      logAuth('client', 'bad_password', { email, ip, candidates: candidates.length, roles: JSON.stringify(candidates.map(c => c.role)), hashFmts: fmts });
      await ActivityLog.log('CLIENT', candidates[0]._id, 'CLIENT_LOGIN_FAILED', { email, reason: 'Invalid password', ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (client.status === 'disabled') {
      logAuth('client', 'account_disabled', { email, ip });
      await ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN_BLOCKED', { reason: 'Account disabled', ip });
      return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
    }

    if (client.devicePolicy && client.devicePolicy.enabled) {
      // Hybrid device-profile policy: group browsers by physical system so the
      // SAME machine works in different browsers, while a genuinely NEW device is
      // held for admin approval. The first device per client auto-approves so
      // existing members are never locked out.
      let decision;
      try {
        decision = await DeviceProfile.resolve(client, {
          fingerprint: req.body.deviceFingerprint || deviceId, // fallback keeps older clients working
          browserInstanceId: deviceId,
          os: req.body.os || null,
          browser: req.body.browser || null,
          ip,
          userAgent: req.headers['user-agent'],
        });
      } catch (deviceErr) {
        // The credentials are already proven valid; the device profile is a
        // SECONDARY control. A transient DB/profile error must not turn a valid
        // login into a generic "Login failed". Fail open (allow) and log loudly so
        // it is still visible to operators — matching DeviceProfile.resolve's own
        // "do NOT break login" philosophy.
        logAuth('client', 'device_resolve_error', { email, ip, msg: deviceErr && deviceErr.message });
        console.error('[auth:client] device resolve error (allowing login):', deviceErr && deviceErr.stack ? deviceErr.stack : deviceErr);
        decision = { status: 'approved', profile: null, reason: 'resolve_error' };
      }

      if (decision.status === 'blocked') {
        logAuth('client', 'device_blocked', { email, ip });
        await ActivityLog.log('CLIENT', client._id, 'LOGIN_BLOCKED_DEVICE', { ip, deviceStatus: 'blocked' });
        return res.status(403).json({ error: 'This device is blocked. Please contact admin.', code: 'DEVICE_BLOCKED' });
      }
      if (decision.status === 'pending') {
        logAuth('client', 'device_pending', { email, ip });
        await ActivityLog.log('CLIENT', client._id, 'LOGIN_BLOCKED_DEVICE', { ip, deviceStatus: 'pending' });
        try {
          await SecurityAlert.raise(client._id, 'NEW_DEVICE', 'medium', {
            ip, deviceIdHash: decision.profile?.deviceGroupId,
            details: `New device pending approval (${req.body.browser || 'browser'} / ${req.body.os || 'OS'}).`,
          });
        } catch (_) {}
        return res.status(403).json({
          error: 'New device detected — pending admin approval. Please contact admin to approve this device.',
          code: 'DEVICE_PENDING',
        });
      }

      // Keep the legacy DeviceBinding row in sync (other reads still reference it),
      // but it is no longer the access gate.
      try {
        const deviceIdHash = DeviceBinding.hashDeviceId(deviceId);
        const existing = await DeviceBinding.findOne({ clientId: client._id, deviceIdHash });
        if (!existing) {
          await DeviceBinding.create({ clientId: client._id, deviceIdHash, userAgent: req.headers['user-agent'] });
        } else {
          existing.lastSeenAt = new Date();
          await existing.save();
        }
      } catch (_) {}
    }

    // Token generation MUST stay on the critical path — the session depends on it.
    // Credentials and the device check have ALREADY passed here, so if this throws the
    // ONLY thing that failed is issuing the session (JWT sign or the refresh-token DB
    // write — e.g. a transient DB/connection-pool error). Log it as a DISTINCT stage so
    // it is never mistaken for a credential failure, and return a specific message
    // instead of the generic catch-all so the user knows to simply retry.
    let accessToken, refreshToken;
    try {
      ({ accessToken, refreshToken } = await generateTokenPair(client, ip));
    } catch (tokenErr) {
      logAuth('client', 'token_error', { email, ip, msg: tokenErr && tokenErr.message });
      console.error('[auth:client] token generation failed:', tokenErr && tokenErr.stack ? tokenErr.stack : tokenErr);
      return res.status(500).json({ error: 'We could not start your session. Please try again in a moment.', code: 'TOKEN_ERROR' });
    }
    logAuth('client', 'success', { email, ip });

    // Role-specific cookie names — isolated from admin session cookies
    res.cookie('clientAccessToken', accessToken, COOKIE_OPTS(ACCESS_MAX));
    res.cookie('clientRefreshToken', refreshToken, COOKIE_OPTS(REFRESH_MAX));
    res.json({ success: true, user: client.toJSON() });

    // Non-critical writes run AFTER the response so they don't add to login latency:
    // the last-login metadata and the audit-log entry. The session (tokens + cookies) is
    // already issued, so a failure here never affects the login result. Fire-and-forget.
    client.lastLoginAt = new Date();
    client.lastLoginIp = ip;
    Promise.resolve()
      .then(() => client.save())
      .then(() => ActivityLog.log('CLIENT', client._id, 'CLIENT_LOGIN', { ip }))
      .catch((err) => console.error('[auth:client] post-login write failed:', err && err.message));
    // Live presence for the admin activity monitor (fire-and-forget, fail-safe).
    recordPresence({ clientId: client._id, clientName: client.fullName, clientEmail: client.email, event: 'login', ip });
    return;
  } catch (err) {
    // Log the FULL error server-side (stack included) to pinpoint the exact failure
    // point, but keep the client-facing message generic so no internals leak.
    logAuth('client', 'server_error', { email: req.body && req.body.email, msg: err && err.message });
    console.error('[auth:client] unhandled login error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Login failed. Please try again.', code: 'SERVER_ERROR' });
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

    // Mark client presence as logged-out so they drop off "Online Now" at once.
    if (req.userId && String(req.userRole).toUpperCase() === 'CLIENT') {
      recordPresence({ clientId: req.userId, clientName: req.user && req.user.fullName, clientEmail: req.user && req.user.email, event: 'logout', ip });
    }

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

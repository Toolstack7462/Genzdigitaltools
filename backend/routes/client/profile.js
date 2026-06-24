const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const DeviceBinding = require('../../models/DeviceBinding');
const DeviceProfile = require('../../models/DeviceProfile');
const ActivityLog = require('../../models/ActivityLog');
const Tool = require('../../models/Tool');
const Announcement = require('../../models/Announcement');
const ExtensionRelease = require('../../models/ExtensionRelease');
const { isOlder, compareVersions } = require('../../utils/semver');
const { readDiskExtensionVersion } = require('../../utils/extensionDownloads');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireRole('CLIENT'));

// GET /api/client/profile - Get client profile
router.get('/profile', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/client/device-info - Get device binding info
router.get('/device-info', async (req, res) => {
  try {
    const device = await DeviceBinding.findOne({ clientId: req.userId });
    res.json({ device });
  } catch (error) {
    console.error('Get device info error:', error);
    res.status(500).json({ error: 'Failed to fetch device info' });
  }
});

// GET /api/crm/client/activity - the signed-in client's OWN recent activity
// (logins, tool opens) for transparency. Scoped strictly to req.userId; never
// returns another user's data, and the payload carries no cookies/tokens/secrets.
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 15));
    const cutoff = new Date(Date.now() - days * 86400000);
    // Only client-meaningful events: sign-ins, blocked/failed sign-ins, tools opened
    // (via the extension), and device resets. Excludes internal extension noise like
    // EXTENSION_SCAN_SUBMITTED / EXTENSION_CREDENTIALS_FETCH / EXTENSION_AUTH.
    const SHOW = /^(CLIENT_LOGIN|LOGIN_BLOCKED|TOOL_OPENED|DEVICE_RESET)/i;
    const all = await ActivityLog.find({ actorId: req.userId }).sort({ createdAt: -1 }).limit(300);
    const rows = (all || [])
      .filter(l => SHOW.test(String(l.action || '')) && l.createdAt && new Date(l.createdAt) >= cutoff)
      .slice(0, limit);
    // Resolve tool names for TOOL_OPENED entries (one bounded lookup), so the client
    // sees "Opened HIX AI" rather than a raw id. No secrets in the payload.
    const toolIds = [...new Set((rows || []).map(l => l.meta && l.meta.toolId).filter(Boolean).map(String))];
    const nameById = {};
    if (toolIds.length) {
      const tools = await Tool.find({ _id: { $in: toolIds } }).select('name').catch(() => []);
      (tools || []).forEach(t => { nameById[String(t._id)] = t.name; });
    }
    const activity = (rows || []).map(l => {
      const tid = (l.meta && l.meta.toolId) || null;
      return {
        _id: l._id,
        action: l.action,
        createdAt: l.createdAt,
        toolId: tid,
        toolName: tid ? (nameById[String(tid)] || null) : null,
      };
    });
    res.json({ success: true, activity });
  } catch (error) {
    console.error('Get client activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// GET /api/crm/client/security - a privacy-safe security summary for the signed-in
// client: last successful sign-in, device-approval status, and recent FAILED/BLOCKED
// sign-in attempts (the "Failed Login Alerts" surface). Scoped strictly to req.userId
// — never returns another user's data. Reuses EXISTING data only (User.lastLoginAt/Ip,
// DeviceProfile, ActivityLog); adds NO new tracking and carries NO cookies/tokens/
// secrets (only safe metadata: os/browser/status + the client's own login IPs). Each
// sub-read is independently fail-safe, and the handler returns a minimal "secured"
// shape on error so the dashboard widget degrades gracefully instead of breaking.
router.get('/security', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('lastLoginAt lastLoginIp devicePolicy createdAt');

    // Devices grouped by physical system (safe metadata only).
    let devices = [];
    const deviceSummary = { total: 0, approved: 0, pending: 0, blocked: 0 };
    try {
      const profiles = await DeviceProfile.find({ clientId: req.userId });
      (profiles || []).forEach(p => {
        const st = String(p.status || 'approved');
        deviceSummary.total += 1;
        if (deviceSummary[st] != null) deviceSummary[st] += 1;
      });
      devices = (profiles || [])
        .slice()
        .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0))
        .slice(0, 5)
        .map(p => ({
          os: p.os || null,
          browser: p.browser || null,
          status: p.status || 'approved',
          firstDevice: !!p.firstDevice,
          lastSeenAt: p.lastSeenAt || null,
        }));
    } catch (_) { /* device read is best-effort; never breaks the summary */ }

    // Recent security-relevant events from the existing audit log (own account only).
    // CLIENT_LOGIN_FAILED / CLIENT_LOGIN_BLOCKED / LOGIN_BLOCKED_DEVICE are logged
    // against the client's own _id (see authEnhanced.js), so this is a true per-client
    // view — it never reveals attempts on a *different* account.
    const SECURITY_RE = /^(CLIENT_LOGIN|CLIENT_LOGIN_FAILED|CLIENT_LOGIN_BLOCKED|LOGIN_BLOCKED_DEVICE|PASSWORD_CHANGED|DEVICE_RESET)/i;
    const FAIL_RE = /(FAILED|BLOCKED)/i;
    const logs = await ActivityLog.find({ actorId: req.userId }).sort({ createdAt: -1 }).limit(200).catch(() => []);
    const relevant = (logs || []).filter(l => SECURITY_RE.test(String(l.action || '')));
    const since = Date.now() - 7 * 86400000;
    let failedRecent = 0;
    relevant.forEach(l => {
      if (FAIL_RE.test(String(l.action || '')) && l.createdAt && new Date(l.createdAt).getTime() >= since) failedRecent += 1;
    });
    const events = relevant.slice(0, 8).map(l => {
      const ac = String(l.action || '').toUpperCase();
      let type = 'login';
      if (/FAILED/.test(ac)) type = 'failed';
      else if (/BLOCKED_DEVICE/.test(ac)) type = 'device_blocked';
      else if (/BLOCKED/.test(ac)) type = 'blocked';
      else if (/PASSWORD/.test(ac)) type = 'password';
      else if (/DEVICE_RESET/.test(ac)) type = 'device_reset';
      return { type, at: l.createdAt, ip: (l.meta && l.meta.ip) || null };
    });

    res.json({
      success: true,
      security: {
        lastLogin: user && user.lastLoginAt ? { at: user.lastLoginAt, ip: user.lastLoginIp || null } : null,
        deviceBinding: { enabled: !!(user && user.devicePolicy && user.devicePolicy.enabled) },
        deviceSummary,
        devices,
        failedRecent,
        events,
        memberSince: user && user.createdAt ? user.createdAt : null,
      },
    });
  } catch (error) {
    console.error('Get client security error:', error);
    // Fail-safe minimal shape so the widget renders a calm "secured" state.
    res.json({ success: true, security: { lastLogin: null, deviceBinding: { enabled: false }, deviceSummary: { total: 0, approved: 0, pending: 0, blocked: 0 }, devices: [], failedRecent: 0, events: [] } });
  }
});

// PUT /api/crm/client/profile - client updates their OWN display name only.
router.put('/profile', async (req, res) => {
  try {
    const { fullName } = req.body;
    if (!fullName || String(fullName).trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    const user = await User.findById(req.userId);
    if (!user || user.role !== 'CLIENT') return res.status(404).json({ error: 'User not found' });
    user.fullName = String(fullName).trim().slice(0, 100);
    await user.save();
    await ActivityLog.log('CLIENT', req.userId, 'PROFILE_UPDATED', {});
    res.json({ success: true, user: user.toJSON() });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/crm/client/change-password - verify current password, set a new one.
// Never logs either password. Keeps the current session valid.
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await User.findById(req.userId); // needs passwordHash → no select()
    if (!user || user.role !== 'CLIENT') return res.status(404).json({ error: 'User not found' });
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    user.passwordHash = newPassword; // User.preSave bcrypt-hashes it
    await user.save();
    await ActivityLog.log('CLIENT', req.userId, 'PASSWORD_CHANGED', {});
    res.json({ success: true, message: 'Password updated' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/crm/client/announcements - active admin announcements for clients.
// Read-only; only published (active) items; never exposes drafts or internal fields.
router.get('/announcements', async (req, res) => {
  try {
    // Fetch a slightly larger window, then keep GLOBAL announcements (no clientId)
    // plus any TARGETED specifically at this signed-in client. A client never sees
    // an announcement aimed at someone else.
    const uid = String(req.userId);
    const rows = await Announcement.find({ active: true }).sort({ createdAt: -1 }).limit(60);
    const announcements = (rows || [])
      .filter(a => !a.clientId || String(a.clientId) === uid)
      .slice(0, 20)
      .map(a => ({
        _id: a._id,
        title: a.title || '',
        body: a.body || '',
        level: a.level || 'info',
        createdAt: a.createdAt,
      }));
    res.json({ success: true, announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.json({ success: true, announcements: [] }); // fail-safe: never break the dashboard
  }
});

// GET /api/crm/client/extension-notice - admin-triggered "please update your
// extension" notice for the signed-in client. Returns the notice ONLY while the
// client is still on an older version than the latest published release; once the
// client updates, the notice self-clears (returns null). Safe metadata only — no
// secrets. Fail-safe: never breaks the dashboard.
router.get('/extension-notice', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('extensionVersion extensionUpdateNotice');
    const notice = user && user.extensionUpdateNotice ? user.extensionUpdateNotice : null;
    if (!notice || !notice.notifiedAt) return res.json({ success: true, notice: null });

    // Resolve the current latest version (disk ZIP first, then DB record).
    const rel = await ExtensionRelease.getLatest().catch(() => null);
    const diskVersion = readDiskExtensionVersion();
    const dbVersion = rel ? rel.version : null;
    let latest = diskVersion || dbVersion || null;
    if (diskVersion && dbVersion && compareVersions(dbVersion, diskVersion) > 0) latest = dbVersion;

    const installed = user.extensionVersion || notice.installedVersion || null;
    // Self-clear: if the client is no longer behind the latest, suppress the notice.
    if (!latest || !installed || !isOlder(installed, latest)) {
      return res.json({ success: true, notice: null });
    }

    res.json({
      success: true,
      notice: {
        message: notice.message || 'Admin has requested you to update your Gen Z Digital Store extension to the latest version.',
        latestVersion: latest,
        installedVersion: installed,
        mandatory: !!notice.mandatory,
        notifiedAt: notice.notifiedAt,
      },
    });
  } catch (error) {
    console.error('Get extension notice error:', error);
    res.json({ success: true, notice: null }); // fail-safe
  }
});

module.exports = router;

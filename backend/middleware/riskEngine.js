/**
 * riskEngine.js
 *
 * Server-side Risk Engine for Gen Z Digital Store.
 * Evaluates each extension API request for known risk indicators
 * and raises SecurityAlert records when triggered.
 *
 * This module runs entirely server-side — no client data is trusted
 * for risk decisions. The extension scanner data submitted by the
 * client is treated as advisory metadata only.
 */
'use strict';

const SecurityAlert  = require('../models/SecurityAlert');
const ExtensionToken = require('../models/ExtensionToken');
const DeviceBinding  = require('../models/DeviceBinding');
const ActivityLog    = require('../models/ActivityLog');
const ToolAssignment = require('../models/ToolAssignment');
const crypto         = require('crypto');

const hashIp = (ip) => ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null;

// ── 1. New device detection ──────────────────────────────────────────────────
async function checkNewDevice(clientId, deviceIdHash, context) {
  if (!deviceIdHash) return;
  const existing = await DeviceBinding.findOne({ clientId, deviceIdHash });
  if (!existing) {
    await SecurityAlert.raise(clientId, 'NEW_DEVICE', 'medium', {
      ...context,
      details: 'Login from a device not previously bound to this account.',
    }, 10 * 60 * 1000);
  }
}

// ── 2. Device mismatch detection ─────────────────────────────────────────────
async function checkDeviceMismatch(clientId, deviceIdHash, tokenDeviceInfo, context) {
  if (!deviceIdHash || !tokenDeviceInfo?.userAgent) return;
  const bound = await DeviceBinding.findOne({ clientId });
  if (!bound) return;
  // Different device hash used with an existing binding → mismatch
  if (bound.deviceIdHash && bound.deviceIdHash !== deviceIdHash) {
    await SecurityAlert.raise(clientId, 'DEVICE_MISMATCH', 'high', {
      ...context,
      details: 'Extension token used from a device that does not match the registered binding.',
    }, 15 * 60 * 1000);
  }
}

// ── 3. Multiple active sessions ───────────────────────────────────────────────
async function checkMultipleSessions(clientId, context) {
  const activeSessions = await ExtensionToken.countDocuments({
    clientId,
    isRevoked: false,
    expiresAt: { $gt: new Date() },
  });
  if (activeSessions > 3) {
    await SecurityAlert.raise(clientId, 'MULTIPLE_ACTIVE_SESSIONS', 'medium', {
      ...context,
      sessionCount: activeSessions,
      details: `${activeSessions} active extension sessions detected.`,
    }, 60 * 60 * 1000); // 1-hour dedup
  }
}

// ── 4. Abnormal access frequency ─────────────────────────────────────────────
async function checkAccessFrequency(clientId, toolId, context) {
  const windowMs  = 10 * 60 * 1000; // 10 minutes
  const threshold = 20; // more than 20 credential fetches in 10 min is anomalous
  const cutoff    = new Date(Date.now() - windowMs);
  const count = await ActivityLog.countDocuments({
    actorId: clientId,
    action:  'TOOL_OPENED',
    createdAt: { $gte: cutoff },
  });
  if (count >= threshold) {
    await SecurityAlert.raise(clientId, 'ABNORMAL_ACCESS_FREQUENCY', 'high', {
      ...context,
      toolId,
      accessCount: count,
      accessWindowMins: 10,
      details: `${count} tool opens in the last 10 minutes (threshold: ${threshold}).`,
    }, 10 * 60 * 1000);
  }
}

// ── 5. Expired assignment access ─────────────────────────────────────────────
async function checkExpiredAccess(clientId, toolId, context) {
  if (!toolId) return;
  const assignment = await ToolAssignment.findOne({ clientId, toolId });
  if (assignment && assignment.status === 'expired') {
    await SecurityAlert.raise(clientId, 'EXPIRED_ACCESS_ATTEMPT', 'medium', {
      ...context,
      toolId,
      details: 'Credential fetch attempted for an expired tool assignment.',
    }, 30 * 60 * 1000);
  }
}

// ── 6. Repeated auth failures ─────────────────────────────────────────────────
async function checkRepeatedAuthFailures(ipAddress, context) {
  const windowMs  = 15 * 60 * 1000;
  const threshold = 5;
  const cutoff    = new Date(Date.now() - windowMs);
  const count = await ActivityLog.countDocuments({
    action: 'EXTENSION_AUTH_FAILED',
    'meta.ip': ipAddress,
    createdAt: { $gte: cutoff },
  });
  if (count >= threshold && context.clientId) {
    await SecurityAlert.raise(context.clientId, 'REPEATED_AUTH_FAILURE', 'high', {
      ...context,
      failureCount: count,
      details: `${count} failed extension auth attempts in 15 minutes from IP.`,
    }, 15 * 60 * 1000);
  }
}

// ── 7. Risky extension report (from scanner) ──────────────────────────────────
async function processExtensionScanReport(clientId, riskyExtensions, context) {
  if (!riskyExtensions?.length) return;
  const highRisk = riskyExtensions.filter(e => e.riskLevel === 'high');
  if (!highRisk.length) return;
  await SecurityAlert.raise(clientId, 'RISKY_EXTENSION_DETECTED',
    highRisk.length >= 2 ? 'critical' : 'high',
    {
      ...context,
      riskyExtensions: highRisk.map(e => ({
        extId:             e.extId,
        extName:           e.extName,
        riskLevel:         e.riskLevel,
        permissionsSummary: e.permissionsSummary,
      })),
      details: `${highRisk.length} high-risk browser extension(s) detected: ${highRisk.map(e => e.extName).join(', ')}.`,
    },
    30 * 60 * 1000
  );
}

/**
 * Express middleware: runs passive risk checks on authenticated extension requests.
 * Attaches to routes that use verifyExtensionToken.
 * Non-blocking — errors are swallowed so they never break the main request.
 */
function riskMiddleware(req, _res, next) {
  if (!req.clientId) return next();

  const context = {
    ipAddress:        req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
    userAgent:        req.headers['user-agent'],
    extensionVersion: req.headers['x-extension-version'],
    deviceIdHash:     req.headers['x-device-id-hash'] || null,
  };

  // Run checks non-blocking — do not await
  (async () => {
    try {
      await checkMultipleSessions(req.clientId, context);
    } catch {}
  })();

  next();
}

module.exports = {
  riskMiddleware,
  checkNewDevice,
  checkDeviceMismatch,
  checkMultipleSessions,
  checkAccessFrequency,
  checkExpiredAccess,
  checkRepeatedAuthFailures,
  processExtensionScanReport,
};

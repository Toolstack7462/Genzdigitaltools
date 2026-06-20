'use strict';
/**
 * Shared read-model: present proxy-gateway tools (HIX / BypassGPT / ChatGPT / Ryne /
 * WriteHuman) and StealthWriter as assignment-style DTOs so the Admin Assignments
 * list and Admin Analytics can treat them like normal assigned tools — WITHOUT
 * touching the proxy/stealth data model or their access flow (still lease/gateway).
 *
 * Access mode is always 'proxy' here; these rows are read-only in the unified
 * assignments view (managed on their dedicated admin pages). Never returns or logs
 * any account/session/secret — only status, expiry, client name/email and tool name.
 */
const ProxyClient = require('../models/proxy/ProxyClient');
const StealthClient = require('../models/stealth/StealthClient');
const User = require('../models/User');
const ToolAssignment = require('../models/ToolAssignment');
const proxyTools = require('./proxy/tools');

const EXPIRING_SOON_DAYS = 7;

// Use the SAME inclusive end-of-day rule as catalog tools (handles date-only
// strings + timezone/ms edge cases) so proxy/stealth expiry never diverges.
function endBoundary(expiryDate) {
  return ToolAssignment.effectiveEndBoundary(expiryDate);
}

function statusFor(row, now = new Date()) {
  const boundary = endBoundary(row.expiryDate);
  const remainingDays = boundary ? Math.ceil((boundary.getTime() - now.getTime()) / 86400000) : null;
  let effectiveStatus;
  if (row.status === 'disabled') effectiveStatus = 'revoked';
  else if (boundary && boundary.getTime() < now.getTime()) effectiveStatus = 'expired';
  else if (boundary && remainingDays <= EXPIRING_SOON_DAYS) effectiveStatus = 'expiring';
  else effectiveStatus = 'active';
  return { effectiveStatus, remainingDays };
}

function makeDTO(id, row, toolName, category, manageUrl, user) {
  const { effectiveStatus, remainingDays } = statusFor(row);
  return {
    _id: id,
    accessMode: 'proxy',
    readOnly: true,         // managed on the dedicated proxy/stealth admin page
    manageUrl,
    status: row.status === 'disabled' ? 'revoked' : (effectiveStatus === 'expired' ? 'expired' : 'active'),
    effectiveStatus,
    remainingDays,
    startDate: null,
    endDate: row.expiryDate || null,
    durationDays: null,
    assignedAt: row.createdAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    tool: { _id: null, name: toolName, category, status: 'active' },
    toolId: null,
    client: user
      ? { _id: user._id, fullName: user.fullName, email: user.email, status: user.status }
      : (row.userId ? { _id: row.userId, fullName: 'Client', email: '' } : null),
    clientId: row.userId || null,
  };
}

/**
 * Build proxy + stealth assignment DTOs. Optionally scoped to one client.
 * Fails safe: any error returns [] so it can never break the assignments list.
 */
async function buildProxyAssignmentDTOs({ clientId } = {}) {
  const out = [];
  try {
    const q = clientId ? { userId: clientId } : {};
    const [proxyRows, stealthRows] = await Promise.all([
      ProxyClient.find(q).then(r => r || []).catch(() => []),
      StealthClient.find(q).then(r => r || []).catch(() => []),
    ]);

    const ids = new Set();
    proxyRows.forEach(r => r.userId && ids.add(String(r.userId)));
    stealthRows.forEach(r => r.userId && ids.add(String(r.userId)));
    const userMap = {};
    if (ids.size) {
      const users = await User.find({ _id: { $in: [...ids] } }).select('fullName email status').catch(() => []);
      (users || []).forEach(u => { userMap[String(u._id)] = u; });
    }

    for (const r of proxyRows) {
      if (!proxyTools.isValidTool(r.tool)) continue;
      const info = proxyTools.publicInfo(r.tool) || {};
      out.push(makeDTO(`proxy:${r.tool}:${r.userId}`, r, info.name || r.tool, info.category || 'AI', '/admin/proxy-tools', userMap[String(r.userId)]));
    }
    for (const r of stealthRows) {
      out.push(makeDTO(`stealth:${r.userId}`, r, 'StealthWriter', 'Text Humanizers', '/admin/stealthwriter', userMap[String(r.userId)]));
    }
  } catch (_) { /* fail safe → [] */ }
  return out;
}

module.exports = { buildProxyAssignmentDTOs, statusFor, EXPIRING_SOON_DAYS };

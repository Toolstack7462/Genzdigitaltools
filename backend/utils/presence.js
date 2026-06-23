'use strict';

/**
 * Client presence recorder for the admin Client Activity Monitor.
 *
 * Design goals (matches the rest of the platform's "lightweight + fail-safe"
 * conventions, e.g. extensionLastSyncAt writes and ActivityLog.log):
 *   - ONE row per client (upsert by clientId) → the table is bounded by the
 *     number of clients, not by traffic. No append-log growth.
 *   - Every call is fail-safe and fire-and-forget: it NEVER throws and NEVER
 *     blocks the request that called it.
 *   - Write-throttled: repeated identical heartbeats within THROTTLE_MS are
 *     skipped, so the dashboard 45s poll / extension sync can call freely.
 *   - Stores ONLY safe metadata — name/email snapshot, event type, tool name,
 *     ip, timestamp. Never cookies, tokens, credentials, or user content.
 *
 * "Online" is DERIVED at read time from lastSeenAt + lastEvent, so a stale
 * session automatically drops off "Online Now" without any write — that is the
 * lightest possible auto-expiry of inactive sessions.
 */

// Tunable windows (env-overridable). Defaults chosen to comfortably tolerate the
// dashboard's 45s heartbeat (a couple of missed pings still counts as online).
const ONLINE_WINDOW_MS = Number(process.env.PRESENCE_ONLINE_WINDOW_MS || 150000);   // 2.5 min
const RECENT_WINDOW_MS = Number(process.env.PRESENCE_RECENT_WINDOW_MS || 1800000);  // 30 min
const THROTTLE_MS      = Number(process.env.PRESENCE_THROTTLE_MS || 10000);         // 10 s

// Human-friendly labels for the only events we track (deliberately a short,
// curated allowlist — no per-click / per-keystroke / page-movement tracking).
const EVENT_LABELS = {
  login:          'Logged in',
  logout:         'Logged out',
  dashboard:      'On dashboard',
  tool_launched:  'Launched a tool',
  extension_sync: 'Extension synced',
};

function normalizeEvent(event) {
  return EVENT_LABELS[event] ? event : 'dashboard';
}

// High-frequency heartbeat events (dashboard poll / extension sync). Only these
// are eligible for the in-memory fast-path throttle below.
const HEARTBEAT_EVENTS = new Set(['dashboard', 'extension_sync']);

// In-process marker of the last DB write per client: clientId -> { at, event }.
// Lets a flood of identical heartbeats short-circuit BEFORE the findOne (which is
// a FULL-TABLE SCAN on the JSON store), so spamming /presence/ping costs a Map
// lookup, not a DB scan. Bounded by client count; tiny entries. Hard-capped so a
// long-lived process can never grow it without bound.
const _lastWrite = new Map();
const _LASTWRITE_MAX = 10000;

// Is this presence row "online right now"? Pure function → unit-testable.
function isOnline(row, now = Date.now(), windowMs = ONLINE_WINDOW_MS) {
  if (!row || !row.lastSeenAt) return false;
  if (row.lastEvent === 'logout') return false;
  return (now - new Date(row.lastSeenAt).getTime()) <= windowMs;
}

// Was this client active within the "recently active" window?
function isRecent(row, now = Date.now(), windowMs = RECENT_WINDOW_MS) {
  if (!row || !row.lastSeenAt) return false;
  return (now - new Date(row.lastSeenAt).getTime()) <= windowMs;
}

async function resolveClient(clientId, clientName, clientEmail) {
  if (clientName && clientEmail) return { clientName, clientEmail };
  try {
    const User = require('../models/User');
    const u = await User.findById(clientId).select('fullName email');
    return {
      clientName:  clientName  || (u && u.fullName) || null,
      clientEmail: clientEmail || (u && u.email)    || null,
    };
  } catch (_) {
    return { clientName: clientName || null, clientEmail: clientEmail || null };
  }
}

/**
 * Record/refresh a client's presence. Fire-and-forget: call WITHOUT awaiting.
 * @param {Object} p
 * @param {string} p.clientId   required
 * @param {string} [p.clientName]
 * @param {string} [p.clientEmail]
 * @param {string} [p.event]     one of EVENT_LABELS keys (default 'dashboard')
 * @param {string} [p.toolId]    only stored for tool_launched
 * @param {string} [p.toolName]  only stored for tool_launched
 * @param {string} [p.ip]
 */
async function recordPresence({ clientId, clientName, clientEmail, event, toolId, toolName, ip } = {}) {
  try {
    if (!clientId) return;
    const key = String(clientId);
    const ev = normalizeEvent(event);
    const now = new Date();

    // Fast path: a repeated heartbeat of the SAME event within the throttle window
    // is dropped here, BEFORE touching the DB (no full-table scan). Event changes
    // (login/logout/tool_launched, or a heartbeat after a different event) always
    // proceed, so presence stays accurate.
    if (HEARTBEAT_EVENTS.has(ev)) {
      const prev = _lastWrite.get(key);
      if (prev && prev.event === ev && (now.getTime() - prev.at) < THROTTLE_MS) return;
    }

    const ClientPresence = require('../models/ClientPresence');
    const existing = await ClientPresence.findOne({ clientId: key });

    // Throttle: skip a write if we just recorded the SAME event very recently and
    // this is not a tool launch (tool launches always update the last tool name).
    if (existing && existing.lastSeenAt && ev !== 'tool_launched' && existing.lastEvent === ev) {
      if ((now.getTime() - new Date(existing.lastSeenAt).getTime()) < THROTTLE_MS) return;
    }

    const resolved = await resolveClient(clientId, clientName, clientEmail);
    const fields = {
      clientId: String(clientId),
      lastEvent: ev,
      lastSeenAt: now,
    };
    if (resolved.clientName)  fields.clientName  = resolved.clientName;
    if (resolved.clientEmail) fields.clientEmail = resolved.clientEmail;
    if (ip) fields.lastIp = String(ip).slice(0, 64);
    if (ev === 'tool_launched') {
      if (toolId)   fields.lastToolId   = String(toolId);
      if (toolName) fields.lastToolName = String(toolName).slice(0, 120);
    }

    if (existing) {
      Object.assign(existing, fields);
      await existing.save();
    } else {
      await ClientPresence.create(fields);
    }

    // Record the write so the in-memory fast path can short-circuit subsequent
    // identical heartbeats. Cheap reset if the map ever grows unexpectedly large.
    if (_lastWrite.size >= _LASTWRITE_MAX) _lastWrite.clear();
    _lastWrite.set(key, { at: now.getTime(), event: ev });
  } catch (err) {
    // Presence tracking must never affect the caller.
    try { console.error('recordPresence failed:', err && err.message); } catch (_) { /* noop */ }
  }
}

module.exports = {
  recordPresence,
  isOnline,
  isRecent,
  normalizeEvent,
  EVENT_LABELS,
  ONLINE_WINDOW_MS,
  RECENT_WINDOW_MS,
  THROTTLE_MS,
};

'use strict';
/**
 * Scheduled retention for the tables that otherwise grow forever.
 *
 * WHY: refresh_tokens / extension_tokens get a row per login and nothing ever removed an
 * expired one; activity_logs / security_alerts were purged only when an admin happened to open
 * their page, and then one DELETE per row. Every auth lookup scans these tables, so latency
 * rose with calendar time (measured 2026-08-17: 20k refresh tokens, 22k activity rows).
 *
 * WHAT IS REMOVED — only rows that already have no effect:
 *   - refresh / extension tokens expired or revoked more than RETENTION_TOKEN_GRACE_DAYS ago
 *     (the auth code already rejects them; the grace absorbs clock skew);
 *   - routine activity older than 7 days (ActivityLog's KEEP_ACTION_RE audit rows are kept);
 *   - closed, low-risk security alerts older than 7 days (SecurityAlert's own rules, unchanged).
 *
 * MODE (env RETENTION_MODE): 'dry-run' (DEFAULT — counts only, logs what it WOULD delete),
 * 'apply' (deletes), 'off'. Rows are unrecoverable, so the first deployment only reports.
 *
 * Stability: one self-rescheduling unref'd timer per process, single-flight, first run 5 min
 * after boot, then every 6 h. Several Passenger workers running it is harmless (idempotent).
 */
const RefreshToken = require('../models/RefreshToken');
const ExtensionToken = require('../models/ExtensionToken');
const ActivityLog = require('../models/ActivityLog');
const SecurityAlert = require('../models/SecurityAlert');

const FIRST_DELAY_MS = Math.max(10_000, Number(process.env.RETENTION_FIRST_DELAY_MS || 5 * 60_000));
const INTERVAL_MS = Math.max(15 * 60_000, Number(process.env.RETENTION_INTERVAL_MS || 6 * 60 * 60_000));
const GRACE_DAYS = Math.max(1, Number(process.env.RETENTION_TOKEN_GRACE_DAYS || 7));

function mode() {
  const m = String(process.env.RETENTION_MODE || 'dry-run').toLowerCase();
  return ['apply', 'off', 'dry-run'].includes(m) ? m : 'dry-run';
}

let running = false;
let timer = null;

async function runOnce() {
  const m = mode();
  if (m === 'off' || running) return null;
  running = true;
  const dryRun = m !== 'apply';
  const started = Date.now();
  const result = { mode: m };
  try {
    const step = async (name, fn) => {
      try { result[name] = await fn(); } catch (e) { result[name] = { error: String(e.message || e).slice(0, 120) }; }
    };
    await step('refresh_tokens', () => RefreshToken.purgeExpired({ graceDays: GRACE_DAYS, dryRun }));
    await step('extension_tokens', () => ExtensionToken.purgeExpired({ graceDays: GRACE_DAYS, dryRun }));
    await step('activity_logs', () => ActivityLog.purgeOld({ days: 7, dryRun }));
    // SecurityAlert purges at most batchLimit per call by design; the 6 h cadence drains a backlog.
    await step('security_alerts', async () => {
      const n = await SecurityAlert.purgeOld({ maxAgeDays: 7, batchLimit: 500, dryRun });
      return { candidates: n, deleted: dryRun ? 0 : n };
    });
    result.ms = Date.now() - started;
    console.log('[retention] ' + JSON.stringify(result));
    return result;
  } finally {
    running = false;
  }
}

function schedule(delay) {
  timer = setTimeout(async () => {
    try { await runOnce(); } catch (e) { console.error('[retention] run failed:', e.message); }
    schedule(INTERVAL_MS);
  }, delay);
  if (timer.unref) timer.unref();
}

function start() {
  if (mode() === 'off' || timer) return;
  console.log(`[retention] scheduler started; mode=${mode()} firstRunIn=${Math.round(FIRST_DELAY_MS / 1000)}s interval=${Math.round(INTERVAL_MS / 60000)}min graceDays=${GRACE_DAYS}`);
  schedule(FIRST_DELAY_MS);
}

module.exports = { start, runOnce, mode };

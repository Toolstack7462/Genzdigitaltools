'use strict';
/**
 * WriteHuman V2 — soak monitor.
 *
 * Polls /v2/health on an interval and flags any regression that would block a cutover:
 *   - unreachable / not ok
 *   - false logout      : account session_expired / needs_login (with the agent feeding it,
 *                         this should only ever happen on a REAL upstream logout)
 *   - bundle_lost       : hasBundle went false after being true
 *   - scheduler_stopped : smart timer not running
 *   - verify_stalled    : lastVerifiedAt older than the max age (timer not re-verifying)
 *
 * Read-only (HTTP GET on /v2/health) — never touches production, never sends the admin key,
 * never logs cookie values. Run it on the RDP (or anywhere that resolves the host) for the
 * full 24–72h window:
 *
 *   WHV2_HEALTH_URL=https://writehuman2.genzdigitalstore.com/v2/health \
 *   SOAK_INTERVAL_SEC=300 SOAK_DURATION_HRS=72 node test/soak-monitor.js
 *
 * Exit code 0 = no regressions observed; 1 = at least one regression flagged.
 */
const fs = require('fs');
const path = require('path');

const URL = process.env.WHV2_HEALTH_URL || 'https://writehuman2.genzdigitalstore.com/v2/health';
const INTERVAL = Math.max(5, parseInt(process.env.SOAK_INTERVAL_SEC, 10) || 300) * 1000;
const DURATION = (parseFloat(process.env.SOAK_DURATION_HRS) || 0) * 3600 * 1000; // 0 = until stopped
const VERIFY_MAX_AGE = (parseInt(process.env.SOAK_VERIFY_MAX_AGE_MIN, 10) || 30) * 60 * 1000;
const LOG = process.env.SOAK_LOG || path.join(__dirname, 'soak-monitor.log');

const start = Date.now();
const stats = { polls: 0, ok: 0, unreachable: 0, false_logout: 0, bundle_lost: 0, scheduler_stopped: 0, verify_stalled: 0, firstAt: null, lastAt: null, everHadBundle: false };

function line(obj) { try { fs.appendFileSync(LOG, JSON.stringify(obj) + '\n'); } catch (_) {} }
function stamp() { return new Date().toISOString(); }
function log(msg) { console.log('[soak] ' + stamp() + ' ' + msg); }

async function poll() {
  stats.polls++;
  let h = null, err = null;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-store' } });
    if (r.status !== 200) { err = 'http_' + r.status; } else { h = await r.json(); }
  } catch (e) { err = (e && e.name === 'TimeoutError') ? 'timeout' : 'neterr'; }

  const flags = [];
  if (err || !h || h.ok !== true) { stats.unreachable++; flags.push('unreachable:' + (err || 'not_ok')); }
  else {
    const a = h.account || {};
    if (a.hasBundle) stats.everHadBundle = true;
    if (a.status === 'session_expired' || a.sessionStatus === 'needs_login') { stats.false_logout++; flags.push('false_logout:' + a.status + '/' + a.sessionStatus); }
    if (stats.everHadBundle && !a.hasBundle) { stats.bundle_lost++; flags.push('bundle_lost'); }
    if (!(h.scheduler && h.scheduler.running)) { stats.scheduler_stopped++; flags.push('scheduler_stopped'); }
    if (a.lastVerifiedAt) {
      const age = Date.now() - new Date(a.lastVerifiedAt).getTime();
      if (age > VERIFY_MAX_AGE) { stats.verify_stalled++; flags.push('verify_stalled:' + Math.round(age / 60000) + 'min'); }
    }
  }
  if (!flags.length) stats.ok++;
  if (!stats.firstAt) stats.firstAt = stamp();
  stats.lastAt = stamp();

  const sample = { t: stamp(), ok: flags.length === 0, status: h && h.account && h.account.status, session: h && h.account && h.account.sessionStatus, bundle: h && h.account && h.account.hasBundle, sched: !!(h && h.scheduler && h.scheduler.running), lastVerifiedAt: h && h.account && h.account.lastVerifiedAt, flags };
  line(sample);
  log((flags.length ? 'REGRESSION ' + flags.join(',') : 'ok') + ' | status=' + sample.status + ' session=' + sample.session + ' bundle=' + sample.bundle + ' sched=' + sample.sched + ' lastVerified=' + sample.lastVerifiedAt);
}

function summary() {
  const regressions = stats.unreachable + stats.false_logout + stats.bundle_lost + stats.scheduler_stopped + stats.verify_stalled;
  const hrs = ((Date.now() - start) / 3600000).toFixed(2);
  console.log('\n──────── SOAK SUMMARY ────────');
  console.log('window           : ' + hrs + ' h  (' + stats.polls + ' polls, every ' + (INTERVAL / 1000) + 's)');
  console.log('clean polls      : ' + stats.ok + '/' + stats.polls);
  console.log('unreachable      : ' + stats.unreachable);
  console.log('false logout     : ' + stats.false_logout);
  console.log('bundle lost      : ' + stats.bundle_lost);
  console.log('scheduler stopped: ' + stats.scheduler_stopped);
  console.log('verify stalled   : ' + stats.verify_stalled);
  console.log('VERDICT          : ' + (regressions === 0 ? 'PASS (no regressions)' : 'FAIL (' + regressions + ' regression samples)'));
  console.log('log              : ' + LOG);
  line({ t: stamp(), summary: true, hours: hrs, ...stats, regressions });
  process.exitCode = regressions === 0 ? 0 : 1;
}

let stopped = false;
function stop() { if (stopped) return; stopped = true; summary(); setTimeout(() => process.exit(process.exitCode), 200).unref(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

log('start url=' + URL + ' interval=' + (INTERVAL / 1000) + 's duration=' + (DURATION ? (DURATION / 3600000) + 'h' : 'until-stopped') + ' log=' + LOG);
(async function loop() {
  await poll();
  while (!stopped) {
    if (DURATION && (Date.now() - start) >= DURATION) { stop(); break; }
    await new Promise((r) => setTimeout(r, INTERVAL));
    if (stopped) break;
    await poll();
  }
})();

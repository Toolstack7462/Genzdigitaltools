#!/usr/bin/env node
/**
 * WriteHuman health capture — the 70-90 minute timeline.
 *
 * Polls the admin agent-state endpoint on a fixed cadence and records, per sample, every timestamp
 * needed to tell the two failure modes apart:
 *
 *   last candidate promotion   bundleVersion / activeSource.promotedAt
 *   last cookie sync           account.lastSyncedAt / lastSyncSuccessAt / staleSec
 *   last agent heartbeat       lastAgentSeenAt / agentSeenSec
 *   last Chrome/CDP report     agent.cdp / agent.receivedAt
 *   last server verification   account.lastVerifiedAt + verification.result + httpStatus
 *   access-token expiry        accessTokenExpiresInSec  (the ~1h clock)
 *   refresh-token result       refreshTokenPresent, verification.result after a rotation
 *   frontend status            lifecycleState + the five healthSignals the page renders
 *
 * It records BOTH the pre-fix and post-fix field shapes, so the same script gives you a "before"
 * baseline on the currently deployed backend and an "after" run on the fixed one.
 *
 * It is READ-ONLY: one GET per sample, nothing is written, nothing is triggered, no browser is
 * opened. At the default 60s cadence a 90-minute run is 90 requests — about the same load as
 * leaving the dashboard open, which polls every 30s.
 *
 * USAGE
 *   1. Sign in to the admin panel in your browser.
 *   2. Open DevTools -> Application -> Cookies and copy the whole cookie header for
 *      api.genzdigitalstore.com (or copy the request as cURL and take the -H 'cookie: ...' value).
 *   3. WH_COOKIE='<that cookie string>' node scripts/writehuman-health-capture.mjs --minutes 90
 *
 * Output: writehuman-capture-<start>.ndjson (one JSON object per sample) plus a printed summary.
 * If you would rather not handle the cookie at all, see scripts/writehuman-capture-console.md —
 * the same capture as a snippet you paste into the browser console on the admin page.
 */
import fs from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const API = (process.env.WH_API || 'https://api.genzdigitalstore.com').replace(/\/+$/, '');
const COOKIE = process.env.WH_COOKIE || '';
const MINUTES = Number(arg('minutes', 90));
const EVERY_SEC = Number(arg('every', 60));
const OUT = arg('out', `writehuman-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);

if (!COOKIE) {
  console.error('Set WH_COOKIE to your admin session cookie header. See the header of this file.');
  process.exit(2);
}

const url = API + '/api/crm/admin/proxy-tools/writehuman/agent-state';
const samples = [];

/** Flatten one poll into the row we actually want to read afterwards. */
function row(s, t) {
  const a = s.account || {};
  const ag = s.agent || null;
  const hs = s.healthSignals || null;
  const v = a.verification || {};
  return {
    t,
    // --- what the operator SEES -------------------------------------------------
    lifecycleState: s.lifecycleState ?? null,
    health: s.health ?? null,
    loginRequired: s.loginRequired ?? null,
    // the five separate signals (post-fix backend only; null before the deploy)
    session: hs?.session?.state ?? null,
    verification: hs?.verification?.state ?? null,
    agentHealth: hs?.agent?.state ?? null,
    chromeHealth: hs?.chrome?.state ?? null,
    cookieSync: hs?.cookieSync?.state ?? null,
    summary: hs?.summary ?? null,
    // pre-fix equivalents, so a "before" run is still readable
    workingUnverified: a.workingUnverified ?? null,
    agentStale: a.agentStale ?? null,
    syncStale: a.syncStale ?? null,
    // --- the timestamps that decide the diagnosis -------------------------------
    accessTokenExpiresInSec: a.accessTokenExpiresInSec ?? s.accessTokenExpiresInSec ?? null,
    tokenExpired: a.tokenExpired ?? null,
    refreshTokenPresent: s.refreshTokenPresent ?? null,
    lastVerifiedAt: a.lastVerifiedAt ?? null,
    verifyResult: v.result ?? null,
    verifyHttp: v.httpStatus ?? null,
    lastSyncedAt: a.lastSyncedAt ?? null,
    syncStaleSec: a.staleSec ?? null,
    syncCount: a.syncCount ?? null,
    lastAgentSeenAt: s.lastAgentSeenAt ?? null,
    agentSeenSec: a.agentSeenSec ?? null,
    bundleVersion: s.bundleVersion ?? null,
    browserAuthCookies: a.browserAuthCookies ?? null,
    cdp: ag?.cdp ?? null,
    agentReportAt: ag?.receivedAt ?? null,
    // --- routing ----------------------------------------------------------------
    activeSource: s.activeSource?.name ?? s.activeSource?.deviceId ?? null,
    activeSourceOnline: s.activeSource?.online ?? null,
    activeSourcePromotedAt: s.activeSource?.promotedAt ?? null,
    onlineDeviceCount: s.onlineDeviceCount ?? null,
    pendingCommands: (s.pendingCommands || []).map(c => `${c.type}->${c.targetDeviceName || c.targetDeviceId}`),
  };
}

async function poll() {
  const t = new Date().toISOString();
  try {
    const r = await fetch(url, { headers: { cookie: COOKIE, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { t, error: 'http_' + r.status };
    return row(await r.json(), t);
  } catch (e) { return { t, error: String(e && e.message) }; }
}

function summarise() {
  if (!samples.length) return;
  console.log('\n=== TIMELINE ===');
  console.log('time      token  session/lifecycle    verification     agent     chrome  sync    bundle');
  let prev = null;
  for (const s of samples) {
    if (s.error) { console.log(`${s.t.slice(11, 19)}  ERROR ${s.error}`); continue; }
    const tok = s.accessTokenExpiresInSec == null ? '  —  '
      : (s.accessTokenExpiresInSec <= 0 ? ' EXP ' : String(Math.round(s.accessTokenExpiresInSec / 60)).padStart(4) + 'm');
    console.log([
      s.t.slice(11, 19), tok,
      String(s.session || s.lifecycleState || '?').padEnd(20),
      String(s.verification || (s.workingUnverified ? 'unverified' : s.verifyResult) || '?').padEnd(16),
      String(s.agentHealth || (s.agentStale ? 'stale' : 'live')).padEnd(9),
      String(s.chromeHealth || s.cdp || '?').padEnd(7),
      String(s.cookieSync || (s.syncStale ? 'behind' : 'fresh')).padEnd(7),
      String(s.bundleVersion ?? '?'),
    ].join(' '));
    // Call out the transitions that matter.
    if (prev) {
      if (prev.bundleVersion !== s.bundleVersion) console.log(`          ^ TOKEN ROTATED — bundle ${prev.bundleVersion} -> ${s.bundleVersion}`);
      if (prev.accessTokenExpiresInSec > 0 && s.accessTokenExpiresInSec <= 0) console.log('          ^ ACCESS TOKEN EXPIRED');
      if (prev.activeSource !== s.activeSource) console.log(`          ^ ACTIVE SOURCE CHANGED — ${prev.activeSource} -> ${s.activeSource}`);
      if (prev.verifyResult !== s.verifyResult) console.log(`          ^ VERIFY RESULT — ${prev.verifyResult} -> ${s.verifyResult}`);
    }
    prev = s;
  }
  const good = samples.filter(s => !s.error);
  const expired = good.filter(s => s.accessTokenExpiresInSec != null && s.accessTokenExpiresInSec <= 0);
  const notHealthy = good.filter(s => (s.session || s.lifecycleState) && (s.session || s.lifecycleState) !== 'HEALTHY');
  const rotations = good.filter((s, i) => i > 0 && good[i - 1].bundleVersion !== s.bundleVersion);
  console.log('\n=== VERDICT ===');
  console.log(`samples                 ${good.length} over ${Math.round((new Date(good.at(-1).t) - new Date(good[0].t)) / 60000)} min`);
  console.log(`access token expired in ${expired.length} sample(s)  (${Math.round(expired.length / good.length * 100)}% of the window)`);
  console.log(`token rotations seen    ${rotations.length}`);
  console.log(`session NOT healthy in  ${notHealthy.length} sample(s)`);
  if (expired.length && !notHealthy.length) {
    console.log('\nPASS — the access token aged out and the session stayed HEALTHY the whole time.');
    console.log('       That is the one-hour bug fixed: rotation is no longer reported as staleness.');
  } else if (notHealthy.length) {
    console.log('\nLOOK AT — session left HEALTHY. First occurrence:');
    console.log(JSON.stringify(notHealthy[0], null, 2));
  }
  console.log(`\nRaw samples: ${OUT}`);
}

const total = Math.ceil((MINUTES * 60) / EVERY_SEC);
console.log(`Capturing ${MINUTES} min, one sample every ${EVERY_SEC}s (${total} samples) -> ${OUT}`);
console.log('Leave the RDP browser ALONE for the whole run — that is the point of the test.\n');

for (let i = 0; i < total; i++) {
  const s = await poll();
  samples.push(s);
  fs.appendFileSync(OUT, JSON.stringify(s) + '\n');
  const tok = s.accessTokenExpiresInSec == null ? '—' : Math.round(s.accessTokenExpiresInSec / 60) + 'm';
  console.log(`[${i + 1}/${total}] ${s.t.slice(11, 19)}  ${s.error ? 'ERROR ' + s.error : `${s.session || s.lifecycleState}  token ${tok}  verify ${s.verification || s.verifyResult}  agent ${s.agentHealth || (s.agentStale ? 'stale' : 'live')}`}`);
  if (i < total - 1) await new Promise(r => setTimeout(r, EVERY_SEC * 1000));
}
summarise();

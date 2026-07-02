'use strict';
/**
 * Periodic READ-ONLY auto-verify for live-agent proxy tools (WriteHuman).
 *
 * Purpose: a safety net that keeps the session proven-alive BETWEEN the agent's cookie rotations,
 * and re-confirms after a sync / when verification goes stale — WITHOUT ever doing a server-side
 * refresh exchange (the RDP browser is the sole token rotator; an exchange here would revoke the
 * live session). Reuses the ONE canonical verify->apply path (utils/proxy/verifyAndApply) — no
 * duplicate verification/mapping logic. Never logs cookie values.
 *
 * Behaviour (matches the required spec):
 *   - runs every PROXY_VERIFY_INTERVAL_MS (default 7 min, within the 5-10 min window);
 *   - only when the primary account is active/standby AND has a bundle AND verification is stale;
 *   - PAUSES when the account is logged out (session_status === 'needs_login');
 *   - retries a transient 'unknown' (network) a few times; an aged-token read-only 'unknown' is
 *     not retried (not transient);
 *   - never marks session_expired on a network error (verify maps network -> unknown, which never
 *     downgrades a working session);
 *   - valid -> working, confirmed auth failure -> needs_login / session_expired.
 *
 * Stability: one self-rescheduling unref'd timer per process; single-flight (no overlap); bounded
 * state (no leaks). Multiple Passenger workers self-coordinate via the stale-gate on the shared row.
 */
const ProxyAccount = require('../models/proxy/ProxyAccount');
const tools = require('../utils/proxy/tools');
const { selectAccount } = require('../utils/proxy/accountSelect');
const { verifyAndApply } = require('../utils/proxy/verifyAndApply');

const INTERVAL_MS   = Math.max(60_000, Number(process.env.PROXY_VERIFY_INTERVAL_MS || 7 * 60_000));
const RETRY_MS      = Math.max(5_000,  Number(process.env.PROXY_VERIFY_RETRY_MS   || 45_000));
const MAX_RETRIES   = Math.max(0,      Number(process.env.PROXY_VERIFY_MAX_RETRIES || 2));
const STALE_MS      = Math.max(60_000, Number(process.env.PROXY_VERIFY_STALE_MS   || 8 * 60_000));
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';
const ENABLED = process.env.PROXY_VERIFY_SCHEDULER !== '0';

let timer = null, running = false, inFlight = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const liveTools = () => tools.TOOL_KEYS.filter((t) => tools.hasLiveAgent(t));

async function verifyOne(tool) {
  const accounts = await ProxyAccount.find({ tool });
  if (!accounts.length) return;
  const account = accounts.find((a) => a.isPrimary) || selectAccount(accounts, SELECTION_MODE) || accounts[0];
  if (!account || !account.sessionEncrypted) return;                 // nothing to verify
  if (account.session_status === 'needs_login') return;              // PAUSE when logged out
  if (!['active', 'standby'].includes(account.status)) return;       // only live-ish accounts
  const last = account.lastVerifiedAt ? new Date(account.lastVerifiedAt).getTime() : 0;
  if (Date.now() - last < STALE_MS) return;                          // not stale yet -> skip

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await verifyAndApply(account, tool, { readOnly: true });
    if (!r.v) break;                                                 // missing-cookie: applied, stop
    if (r.result !== 'unknown') break;                              // definitive result, stop
    if (r.v.reason === 'readonly_no_exchange') break;              // aged token, not transient
    if (attempt < MAX_RETRIES) await sleep(RETRY_MS);              // transient network -> retry
  }
}

async function tick() {
  if (!running) return;
  if (inFlight) { schedule(INTERVAL_MS); return; }
  inFlight = true;
  try {
    for (const t of liveTools()) {
      try { await verifyOne(t); }
      catch (e) { console.error('[proxyVerify] ' + t + ': ' + (e && e.message)); }
    }
  } finally {
    inFlight = false;
    schedule(INTERVAL_MS);
  }
}

function schedule(ms) {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, Math.max(0, ms));
  if (timer.unref) timer.unref();
}

function start() {
  if (running) return;
  if (!ENABLED) { console.log('[proxyVerify] disabled (PROXY_VERIFY_SCHEDULER=0)'); return; }
  if (!liveTools().length) { console.log('[proxyVerify] no live-agent tools; not starting'); return; }
  running = true;
  schedule(INTERVAL_MS);
  console.log('[proxyVerify] started; interval=' + Math.round(INTERVAL_MS / 60_000) + 'min, tools=' + liveTools().join(','));
}

function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } }
function status() { return { running, intervalMin: Math.round(INTERVAL_MS / 60_000), enabled: ENABLED }; }

module.exports = { start, stop, status };

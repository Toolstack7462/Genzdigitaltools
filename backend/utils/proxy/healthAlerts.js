'use strict';
/**
 * Health alerting for live-agent proxy tools (WriteHuman). Turns silent failures into an email so
 * an admin doesn't have to watch the dashboard. Fire-and-forget; never throws into the caller.
 *
 * Alerts on meaningful transitions only (debounced per state on the account row so restarts don't
 * re-spam and a flapping state doesn't page repeatedly):
 *   - session went DOWN (working/unknown -> needs_login / session_expired / cookies_invalid)
 *   - session RECOVERED (down -> working)
 *   - Cookie Sync Agent STALE (RDP/agent not reporting) — raised by the scheduler.
 *
 * Recipient resolution (per-account, checked at fire time — NOT frozen at boot):
 *   1. account.alertConfig.email  — set from the admin dashboard (takes precedence)
 *   2. PROXY_ALERT_EMAIL / ADMIN_ALERT_EMAIL env — fallback default
 * The dashboard toggle (account.alertConfig.enabled=false) turns alerts off for that account even
 * when a recipient exists. PROXY_ALERTS_ENABLED=0 is a global hard-off.
 *
 * Config (all optional):
 *   PROXY_ALERTS_ENABLED=0   global hard off
 *   PROXY_ALERT_DEBOUNCE_MS  re-alert window for the same state (default 30 min)
 *
 * Never logs or emails secrets — only masked email, status codes, timestamps.
 */
const { sendEmail, isEmailEnabled } = require('../email');

const ENV_RECIPIENT = process.env.PROXY_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || '';
const HARD_OFF = process.env.PROXY_ALERTS_ENABLED === '0';
const DEBOUNCE_MS = Math.max(60_000, Number(process.env.PROXY_ALERT_DEBOUNCE_MS || 30 * 60_000));

// Resolve the effective alert target for an account at CALL time, so a recipient set from the
// dashboard takes effect immediately with no redeploy. `source` is for the dashboard's own display.
function resolveAlert(account) {
  const cfg = (account && account.alertConfig) || {};
  const dbEmail = typeof cfg.email === 'string' ? cfg.email.trim() : '';
  const recipient = dbEmail || ENV_RECIPIENT;
  const source = dbEmail ? 'db' : (ENV_RECIPIENT ? 'env' : 'none');
  const enabled = !HARD_OFF && cfg.enabled !== false && !!recipient;
  return { recipient, enabled, source };
}

const DOWN_STATES = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];
function health(ss) { if (ss === 'working') return 'up'; if (DOWN_STATES.includes(ss)) return 'down'; return 'unknown'; }

// Debounce on account.alertState = { key, at }. Returns true if this key hasn't fired recently.
function shouldSend(account, key) {
  const a = account.alertState || {};
  return !(a.key === key && a.at && (Date.now() - new Date(a.at).getTime()) < DEBOUNCE_MS);
}

async function fire(account, tool, key, subject, line) {
  try {
    const { recipient, enabled } = resolveAlert(account);
    if (!enabled || !recipient || !isEmailEnabled()) return;
    if (!shouldSend(account, key)) return;
    account.alertState = { key, at: new Date() };
    try { await account.save(); } catch (_) { /* best-effort */ }
    const masked = (account.verification && account.verification.maskedId) || '(unknown)';
    const html = `<p>${line}</p><ul>` +
      `<li>Tool: ${tool}</li>` +
      `<li>Account: ${account.label || account._id}</li>` +
      `<li>User (masked): ${masked}</li>` +
      `<li>Status: ${account.status} / ${account.session_status}</li>` +
      `<li>Time: ${new Date().toISOString()}</li></ul>`;
    await sendEmail({ to: recipient, subject, html, text: line + ' (' + account.status + '/' + account.session_status + ')' });
  } catch (_) { /* alerting must never break the caller */ }
}

// Called (fire-and-forget) after a verify result is applied. prevSs = session_status BEFORE it.
async function onVerifyApplied(account, tool, prevSs) {
  if (!resolveAlert(account).enabled) return;
  const before = health(prevSs), now = health(account.session_status);
  if (before !== 'down' && now === 'down') {
    await fire(account, tool, 'down:' + account.session_status,
      `[Alert] ${tool} session DOWN (${account.session_status})`,
      `The ${tool} session went down (${account.session_status}). Clients see a "refreshing" message until it recovers. If it stays down, log the RDP browser back into ${tool}.`);
  } else if (before === 'down' && now === 'up') {
    await fire(account, tool, 'up',
      `[Recovered] ${tool} session working again`,
      `The ${tool} session recovered and is serving clients again.`);
  }
}

// Called (fire-and-forget) by the scheduler when the agent hasn't reported in too long.
async function onAgentStale(account, tool, staleMin) {
  if (!resolveAlert(account).enabled) return;
  await fire(account, tool, 'agent_stale',
    `[Alert] ${tool} Cookie Sync Agent stale (~${staleMin}m)`,
    `The ${tool} Cookie Sync Agent hasn't reported for ~${staleMin} minutes — the RDP or the agent may be down. The session keeps serving cached cookies but will NOT self-refresh until the agent is back.`);
}

module.exports = { onVerifyApplied, onAgentStale, resolveAlert };

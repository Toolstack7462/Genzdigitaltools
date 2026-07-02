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
 * Config (all optional; disabled if no recipient / email not configured):
 *   PROXY_ALERT_EMAIL        recipient (falls back to ADMIN_ALERT_EMAIL)
 *   PROXY_ALERTS_ENABLED=0   hard off
 *   PROXY_ALERT_DEBOUNCE_MS  re-alert window for the same state (default 30 min)
 *
 * Never logs or emails secrets — only masked email, status codes, timestamps.
 */
const { sendEmail, isEmailEnabled } = require('../email');

const RECIPIENT = process.env.PROXY_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || '';
const ENABLED = process.env.PROXY_ALERTS_ENABLED !== '0' && !!RECIPIENT;
const DEBOUNCE_MS = Math.max(60_000, Number(process.env.PROXY_ALERT_DEBOUNCE_MS || 30 * 60_000));

const DOWN_STATES = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];
function health(ss) { if (ss === 'working') return 'up'; if (DOWN_STATES.includes(ss)) return 'down'; return 'unknown'; }

// Debounce on account.alertState = { key, at }. Returns true if this key hasn't fired recently.
function shouldSend(account, key) {
  const a = account.alertState || {};
  return !(a.key === key && a.at && (Date.now() - new Date(a.at).getTime()) < DEBOUNCE_MS);
}

async function fire(account, tool, key, subject, line) {
  try {
    if (!ENABLED || !isEmailEnabled()) return;
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
    await sendEmail({ to: RECIPIENT, subject, html, text: line + ' (' + account.status + '/' + account.session_status + ')' });
  } catch (_) { /* alerting must never break the caller */ }
}

// Called (fire-and-forget) after a verify result is applied. prevSs = session_status BEFORE it.
async function onVerifyApplied(account, tool, prevSs) {
  if (!ENABLED) return;
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
  if (!ENABLED) return;
  await fire(account, tool, 'agent_stale',
    `[Alert] ${tool} Cookie Sync Agent stale (~${staleMin}m)`,
    `The ${tool} Cookie Sync Agent hasn't reported for ~${staleMin} minutes — the RDP or the agent may be down. The session keeps serving cached cookies but will NOT self-refresh until the agent is back.`);
}

module.exports = { onVerifyApplied, onAgentStale, ENABLED };

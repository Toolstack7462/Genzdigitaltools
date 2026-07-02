'use strict';
/**
 * WriteHuman V2 — cookie ingest endpoint handler (Step 2 + dashboard telemetry).
 *
 * POST /v2/cookies/ingest is the Cookie Sync Agent target. Every agent request (cookie push,
 * heartbeat, or logout signal) may carry an `agent` diagnostics object → recorded for the
 * dashboard. The response carries any queued remote command back to the agent.
 *
 * Body: { cookies:[...] } | { heartbeat:true, hash } | { loggedOut:true, reason }, each
 * optionally with { agent: { cdp, chrome, pollCount, authCookies, lastError, host, version,
 * uptimeSec } }. Never logs cookie values.
 */
const sm = require('./sessionManager');

async function handle(body) {
  // Record agent diagnostics on any request that carries them.
  if (body && body.agent && typeof body.agent === 'object') sm.setAgentReport(body.agent);
  // Consume at most one queued command to hand back to the agent this cycle.
  const command = sm.takeCommand();
  const withCmd = (r) => (command ? Object.assign({}, r, { command }) : r);

  if (body && body.heartbeat === true) {
    return { status: 200, body: withCmd(sm.heartbeat()) };
  }
  if (body && body.loggedOut === true) {
    return { status: 200, body: withCmd(sm.markLoggedOut(body.reason)) };
  }
  const list = body && body.cookies;
  if (!Array.isArray(list)) return { status: 400, body: withCmd({ ok: false, code: 'bad_cookies' }) };
  const r = await sm.ingestCookies(list);
  return { status: r.ok ? 200 : (r.status || 400), body: withCmd(r) };
}

module.exports = { handle };

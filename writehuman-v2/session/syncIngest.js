'use strict';
/**
 * WriteHuman V2 — cookie ingest endpoint handler (Step 2).
 *
 * POST /v2/cookies/ingest is the target for the Cookie Sync Agent (CDP). It accepts the
 * current AUTH cookies and delegates to sessionManager.ingestCookies, which hash-detects a
 * change, replaces (never merges) the stored auth cookies, persists, auto-verifies, and
 * resets the smart timer. Auth (admin/agent key) is enforced by the route in server.js.
 *
 * Request body: { cookies: [ { name, value, domain?, path? }, ... ] }
 * Never logs cookie values.
 */
const sm = require('./sessionManager');

async function handle(body) {
  const list = body && body.cookies;
  if (!Array.isArray(list)) return { status: 400, body: { ok: false, code: 'bad_cookies' } };
  const r = await sm.ingestCookies(list);
  return { status: r.ok ? 200 : (r.status || 400), body: r };
}

module.exports = { handle };

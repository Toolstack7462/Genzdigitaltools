'use strict';
/**
 * Admin routes for the WriteHuman V2 monitoring module.
 * Mounted at /api/crm/admin/writehuman-v2 — isolated from core admin routes.
 *
 * This does NOT manage the WriteHuman account vault or client assignments — those live in the
 * existing Proxy-Tools admin (/api/crm/admin/proxy-tools/writehuman/...) and stay the single
 * source of truth. This module ONLY surfaces the V2 service's live telemetry (agent / Chrome-CDP
 * / cookie-sync / verification / diagnostics / logs) so the unified Admin Dashboard can show and
 * control it, mirroring how StealthWriter has its own admin routes.
 *
 * It is a thin, read-mostly PROXY to the standalone V2 service so the browser never holds the V2
 * admin key and never talks cross-origin: the admin's existing session gates access here, and this
 * server forwards to V2 with the server-held WRITEHUMAN_V2_ADMIN_KEY.
 *
 * Dormant until configured: with no WRITEHUMAN_V2_ADMIN_KEY set, every route returns 503
 * (v2_not_configured) — so mounting it changes nothing for existing tools/production.
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');

const V2_URL = (process.env.WRITEHUMAN_V2_URL || 'https://writehuman2.genzdigitalstore.com').replace(/\/$/, '');
const V2_ADMIN_KEY = process.env.WRITEHUMAN_V2_ADMIN_KEY || '';

router.use(requireAuth);
router.use(requireAdmin);

// Thin server-to-server call to the V2 service. Never logs the key. Times out so a slow/dead V2
// can't hang an admin request.
async function v2(method, path, body) {
  const headers = { 'x-admin-key': V2_ADMIN_KEY };
  const opts = { method, headers, signal: AbortSignal.timeout(12000) };
  if (body !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  const resp = await fetch(V2_URL + path, opts);
  let data = null; try { data = await resp.json(); } catch (_) { data = null; }
  return { status: resp.status, data };
}
function guard(res) {
  if (!V2_ADMIN_KEY) { res.status(503).json({ ok: false, code: 'v2_not_configured' }); return false; }
  return true;
}
function forwardError(res, e) {
  return res.status(502).json({ ok: false, code: 'v2_unreachable', error: e && e.message });
}

// Aggregated live state for the dashboard (account, session, verification, sync, agent telemetry).
router.get('/state', async (req, res) => {
  if (!guard(res)) return;
  try { const r = await v2('GET', '/v2/admin/state'); return res.status(r.status).json(r.data || { ok: false }); }
  catch (e) { return forwardError(res, e); }
});

// Recent event log (bounded ring buffer on the V2 side).
router.get('/logs', async (req, res) => {
  if (!guard(res)) return;
  const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try { const r = await v2('GET', '/v2/admin/logs?limit=' + limit); return res.status(r.status).json(r.data || { ok: false }); }
  catch (e) { return forwardError(res, e); }
});

// Raw health (also useful as a reachability check for the dashboard).
router.get('/health', async (req, res) => {
  try { const r = await v2('GET', '/v2/health'); return res.status(r.status).json(r.data || { ok: false }); }
  catch (e) { return forwardError(res, e); }
});

// Queue a remote command for the RDP agent (whitelisted V2-side: relaunch-chrome, reverify).
router.post('/command', async (req, res) => {
  if (!guard(res)) return;
  try { const r = await v2('POST', '/v2/admin/command', { command: req.body && req.body.command }); return res.status(r.status).json(r.data || { ok: false }); }
  catch (e) { return forwardError(res, e); }
});

// Force a live verification now.
router.post('/verify', async (req, res) => {
  if (!guard(res)) return;
  try { const r = await v2('POST', '/v2/admin/verify'); return res.status(r.status).json(r.data || { ok: false }); }
  catch (e) { return forwardError(res, e); }
});

module.exports = router;

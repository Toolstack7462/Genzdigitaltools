'use strict';
/**
 * Admin routes for Proxy Services SLEEP / WAKE.
 * Mounted at /api/crm/admin/proxy-sleep — isolated from every other admin router.
 *
 * WHAT THIS DOES. Each of the four managed proxies is a Passenger *Node* app (there is no PHP
 * anywhere in them). The vhost mounts it purely through `Passenger*` directives in that domain's
 * own `public_html/.htaccess`:
 *
 *     Browser → LiteSpeed → .htaccess (PassengerAppRoot) → Node gateway → target site
 *
 * SLEEP comments those directives out and drops in a static maintenance rule, so the request is
 * answered by the web server itself and never reaches Node:
 *
 *     Browser → LiteSpeed → static 503  (no Node, no PHP, no external API, no DB)
 *
 * Passenger then has no app to keep resident for that vhost and its workers exit, which is where
 * the actual RAM saving comes from. This is not a cosmetic flag: with the app unmounted there is
 * no process left to run the gateway's in-process timers either.
 *
 * WHY THIS EXACT MECHANISM. It is not invented here — it is already proven in production on this
 * account. `writehuman2` was disabled this way during the 2026-07-21 resource audit (its .htaccess
 * still carries the `#GENZ-DISABLED ` prefixes) and has held **zero processes and zero RAM** ever
 * since while its files, database, DNS and SSL stayed fully intact. This module productionises
 * that manual edit and adds the static 503 the manual version lacked.
 *
 * BLAST RADIUS. Every write is confined to ONE domain's docroot plus that app's own
 * `tmp/restart.txt`. Nothing shared is touched: no PHP-FPM, no MySQL, no Redis, no Passenger
 * global config, no other vhost. Sleeping one proxy cannot affect another.
 *
 * SECURITY. The `:id` from the request is never used to build a path. It is only ever a key
 * lookup into the hard-coded SERVICES map below; anything not in that map is rejected before any
 * filesystem work. There is no shell execution anywhere in this file — only `fs` calls — so there
 * is no command-injection surface and no privilege escalation. Mutations are POST-only, admin
 * authenticated, and CSRF protected.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { requireCsrf } = require('../../middleware/csrf');

// ── Hard-coded service allowlist ────────────────────────────────────────────────
// These four IDs are the ONLY things this module will ever act on. Paths are derived from the
// home directory plus fixed literals here — never from request input.
// Resolving the ACCOUNT home is subtle: under Passenger this process runs with
// HOME=/home/u171982351/domains/api.genzdigitalstore.com — the *domain* directory, not the
// account root. Using os.homedir() directly therefore builds
// `…/api.genzdigitalstore.com/domains/grok1…/public_html/.htaccess`, which does not exist, and
// every service reports htaccess_unreadable. Cut the path back at `/domains/` to recover the
// account root, and keep an env override for anything unusual.
function accountHome() {
  if (process.env.GENZ_HOME) return process.env.GENZ_HOME;
  const h = os.homedir() || '';
  const i = h.indexOf('/domains/');
  if (i > 0) return h.slice(0, i);
  return h || '/home/u171982351';
}
const HOME = accountHome();

const SERVICES = Object.freeze({
  bypassgpt1:  { name: 'BypassGPT',      host: 'bypassgpt1.genzdigitalstore.com',  appDir: 'bypassgpt-gateway' },
  hix1:        { name: 'HIX AI',         host: 'hix1.genzdigitalstore.com',        appDir: 'hix-gateway' },
  grok1:       { name: 'Grok',           host: 'grok1.genzdigitalstore.com',       appDir: 'grok-gateway' },
  writehuman2: { name: 'WriteHuman V2',  host: 'writehuman2.genzdigitalstore.com', appDir: 'writehuman-v2' },
});
const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));

const STATE_DIR   = process.env.PROXY_SLEEP_STATE_DIR || path.join(HOME, '.genz-proxy-sleep');
const BACKUP_DIR  = path.join(STATE_DIR, 'backups');
const AUDIT_LOG   = path.join(STATE_DIR, 'audit.log');

function isValidId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SERVICES, id);
}
function docrootOf(id)  { return path.join(HOME, 'domains', SERVICES[id].host, 'public_html'); }
function htaccessOf(id) { return path.join(docrootOf(id), '.htaccess'); }
function appRootOf(id)  { return path.join(HOME, SERVICES[id].appDir); }

// ── .htaccess transform (pure, unit-tested) ─────────────────────────────────────
// `#GENZ-DISABLED ` is the marker left by the 2026-07-21 manual audit; `#GENZ-SLEEP ` is what this
// module writes. Both mean "asleep", and wake strips both, so a hand-disabled tool (writehuman2)
// is adopted correctly instead of being double-commented or left stuck.
const SLEEP_PREFIX = '#GENZ-SLEEP ';
const ASLEEP_RE    = /^#GENZ-(?:SLEEP|DISABLED)\s+Passenger/i;
const ACTIVE_RE    = /^\s*Passenger/i;
const BLOCK_BEGIN  = '# --- GENZ-SLEEP-BEGIN (managed by Admin → Proxy Services; do not hand-edit) ---';
const BLOCK_END    = '# --- GENZ-SLEEP-END ---';

// The static maintenance rule. Everything except the maintenance page itself is answered 503 by
// the web server. `no-store` matters: without it Hostinger's hcdn edge can cache the 503 with a
// long TTL and keep serving it for days *after* the tool is woken.
function maintenanceBlock() {
  return [
    BLOCK_BEGIN,
    'DirectoryIndex disabled',
    'ErrorDocument 503 /maintenance.html',
    '<IfModule mod_headers.c>',
    '  Header always set Cache-Control "no-store, no-cache, must-revalidate, max-age=0"',
    '  Header always set Retry-After "3600"',
    '</IfModule>',
    'RewriteEngine On',
    'RewriteBase /',
    'RewriteCond %{REQUEST_URI} !^/maintenance\\.html$',
    'RewriteRule ^ - [R=503,L]',
    BLOCK_END,
  ].join('\n');
}

function stripBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) { inBlock = true; continue; }
    if (inBlock) { if (line.trim() === BLOCK_END) inBlock = false; continue; }
    out.push(line);
  }
  return out.join('\n');
}

/** Comment out every Passenger directive and append the static 503 rule. Idempotent. */
function toSleeping(text) {
  const body = stripBlock(text);
  const lines = body.split(/\r?\n/).map((line) =>
    ACTIVE_RE.test(line) ? SLEEP_PREFIX + line : line
  );
  let joined = lines.join('\n').replace(/\s*$/, '');
  return joined + '\n\n' + maintenanceBlock() + '\n';
}

/** Uncomment every Passenger directive and remove the 503 rule. Idempotent. */
function toActive(text) {
  const body = stripBlock(text);
  const lines = body.split(/\r?\n/).map((line) =>
    ASLEEP_RE.test(line) ? line.replace(/^#GENZ-(?:SLEEP|DISABLED)\s+/i, '') : line
  );
  return lines.join('\n').replace(/\s*$/, '') + '\n';
}

function readState(text) {
  const lines = String(text).split(/\r?\n/);
  const asleep = lines.some((l) => ASLEEP_RE.test(l));
  const active = lines.some((l) => ACTIVE_RE.test(l));
  if (active && !asleep) return 'ACTIVE';
  if (asleep && !active) return 'SLEEPING';
  if (asleep && active) return 'ERROR';   // half-commented: needs a human
  return 'ERROR';                          // no Passenger directives at all
}

// ── Real runtime state ──────────────────────────────────────────────────────────
// Phase 16: never report SLEEPING purely from a stored flag. Passenger names each worker
// `lsnode:<appRoot>/`, so /proc is read directly — no shell, no `ps`.
function countWorkers(appRoot) {
  let n = 0;
  let pids;
  try { pids = fs.readdirSync('/proc'); } catch (_) { return null; }  // non-Linux/dev: unknown
  const needle = 'lsnode:' + appRoot;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const raw = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (raw.replace(/\0/g, ' ').includes(needle)) n++;
    } catch (_) { /* process vanished or not ours */ }
  }
  return n;
}

// ── Atomic write + backup ───────────────────────────────────────────────────────
function ensureDirs() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
function backupOnce(id, current) {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `${id}.htaccess.before-proxy-sleep-system-${stamp}`);
  fs.writeFileSync(dest, current, { mode: 0o600 });
  return dest;
}
/** Same-directory temp + rename, so a reader never sees a half-written .htaccess. */
function writeAtomic(target, content) {
  const tmp = target + '.genz-tmp-' + process.pid;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, target);
}
function writeMaintenancePage(id) {
  const file = path.join(docrootOf(id), 'maintenance.html');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Temporarily unavailable</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f6f9fc;color:#0f2540;
       font:400 16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  @media (prefers-color-scheme:dark){body{background:#061528;color:#e6eef8}}
  .card{max-width:30rem;padding:2.5rem 2rem;text-align:center}
  h1{margin:0 0 .5rem;font-size:1.35rem;font-weight:600}
  p{margin:0;opacity:.75}
</style></head>
<body><div class="card">
  <h1>This service is temporarily unavailable.</h1>
  <p>Please check back shortly.</p>
</div></body></html>
`;
  writeAtomic(file, html);
}
/** Tell Passenger to shut the app down / restart it. Best-effort: never fails the transition. */
function touchRestart(id) {
  try {
    const dir = path.join(appRootOf(id), 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'restart.txt'), String(Date.now()));
    return true;
  } catch (_) { return false; }
}

// ── Audit log (JSONL, outside the web root, never contains secrets) ─────────────
function audit(entry) {
  try {
    ensureDirs();
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) {
    try { console.error('[proxy-sleep] audit write failed:', e && e.message); } catch (_) {}
  }
}

// ── Transition locking (Phase 17) ───────────────────────────────────────────────
const inFlight = new Set();

// ── Routes ──────────────────────────────────────────────────────────────────────
router.use(requireAuth);
router.use(requireAdmin);

function describe(id) {
  const svc = SERVICES[id];
  const base = { id, name: svc.name, host: svc.host, url: 'https://' + svc.host };
  if (inFlight.has(id)) return { ...base, status: 'TRANSITIONING', workers: null, lastChanged: null };
  let text;
  try {
    text = fs.readFileSync(htaccessOf(id), 'utf8');
  } catch (e) {
    return { ...base, status: 'ERROR', workers: null, lastChanged: null, detail: 'htaccess_unreadable' };
  }
  let lastChanged = null;
  try { lastChanged = fs.statSync(htaccessOf(id)).mtime.toISOString(); } catch (_) {}
  return { ...base, status: readState(text), workers: countWorkers(appRootOf(id)), lastChanged };
}

// GET /  → live state of all four services
router.get('/', (req, res) => {
  try {
    return res.json({ ok: true, services: SERVICE_IDS.map(describe) });
  } catch (e) {
    try { console.error('[proxy-sleep] list failed:', e && e.message); } catch (_) {}
    return res.status(500).json({ ok: false, code: 'list_failed' });
  }
});

function transition(req, res, target) {
  const id = req.params.id;
  if (!isValidId(id)) return res.status(404).json({ ok: false, code: 'unknown_service' });
  if (inFlight.has(id)) return res.status(409).json({ ok: false, code: 'transition_in_progress' });

  inFlight.add(id);
  const adminId = (req.user && (req.user.email || req.user._id)) || 'unknown-admin';
  const file = htaccessOf(id);
  let before = null;
  let fromState = 'ERROR';

  try {
    before = fs.readFileSync(file, 'utf8');
    fromState = readState(before);

    if (fromState === target) {                      // already there — idempotent no-op
      inFlight.delete(id);
      return res.json({ ok: true, service: describe(id), changed: false });
    }

    const backup = backupOnce(id, before);
    const next = target === 'SLEEPING' ? toSleeping(before) : toActive(before);

    if (target === 'SLEEPING') writeMaintenancePage(id);
    writeAtomic(file, next);

    // Verify what actually landed; roll back if it is not what we intended.
    const after = fs.readFileSync(file, 'utf8');
    const resulting = readState(after);
    if (resulting !== target) {
      writeAtomic(file, before);
      audit({ serviceId: id, from: fromState, requested: target, result: 'ERROR',
              adminId, message: 'post-write state mismatch; rolled back', backup });
      inFlight.delete(id);
      return res.status(500).json({ ok: false, code: 'transition_failed' });
    }

    const restarted = touchRestart(id);
    audit({ serviceId: id, from: fromState, requested: target, result: resulting,
            adminId, ip: getClientIp ? getClientIp(req) : undefined, restartSignalled: restarted, backup });

    inFlight.delete(id);
    return res.json({ ok: true, service: describe(id), changed: true });
  } catch (e) {
    // Fail safe: put the previous known-good file back if we had read it.
    if (before !== null) { try { writeAtomic(file, before); } catch (_) {} }
    try { console.error('[proxy-sleep] transition failed:', e && e.message); } catch (_) {}
    audit({ serviceId: id, from: fromState, requested: target, result: 'ERROR',
            adminId, message: (e && e.message) || 'unknown error' });
    inFlight.delete(id);
    return res.status(500).json({ ok: false, code: 'transition_failed' });
  }
}

// POST /:id/sleep  and  POST /:id/wake  — mutations are POST-only + CSRF protected.
router.post('/:id/sleep', requireCsrf, (req, res) => transition(req, res, 'SLEEPING'));
router.post('/:id/wake',  requireCsrf, (req, res) => transition(req, res, 'ACTIVE'));

module.exports = router;
// Exported for unit tests only — pure functions, no filesystem access.
module.exports.__transform = { toSleeping, toActive, readState, stripBlock, SERVICE_IDS, accountHome };

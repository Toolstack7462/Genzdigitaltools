'use strict';
/**
 * WriteHuman V2 — Cookie Sync Agent (runs on the dedicated RDP, next to the 24/7 Chrome).
 *
 * Connects to the always-on Chrome via the Chrome DevTools Protocol (CDP), reads the browser
 * cookies (Storage.getCookies on the browser target), keeps ONLY the WriteHuman auth cookies
 * (`sb-<ref>-auth-token` + chunks, `sb-session-token`), hashes them, and — only when the hash
 * CHANGES — pushes them to the V2 service (`POST /v2/cookies/ingest`). The server then
 * replaces (never merges) the stored auth cookies, auto-verifies, and resets its smart timer.
 *
 * Dependency-free: uses Node's global `fetch` (>=18) and global `WebSocket` (>=22). Never logs
 * cookie values — counts and an 8-char hash prefix only. Lightweight: one infrequent poll, one
 * short-lived CDP connection per poll, errors are caught and retried on the next tick (no tight
 * loop, no crash).
 *
 * Launch the 24/7 Chrome with, e.g.:
 *   chrome.exe --user-data-dir="C:\\wh-profile" --remote-debugging-port=9222
 * then run:  node agent/cookie-sync-agent.js
 *
 * Env:
 *   WHV2_INGEST_URL   default http://127.0.0.1:3100/v2/cookies/ingest
 *   WHV2_AGENT_KEY    required (matches WRITEHUMAN_V2_AGENT_KEY or _ADMIN_KEY on the server)
 *   WHV2_CDP_URL      default http://127.0.0.1:9222
 *   WHV2_TARGET_DOMAIN default writehuman.ai
 *   WHV2_SUPABASE_REF default hicfsbrfkzsxbwayibfm
 *   WHV2_POLL_MS      default 120000 (2 min)
 */
const crypto = require('crypto');

const CFG = {
  ingestUrl: process.env.WHV2_INGEST_URL || 'http://127.0.0.1:3100/v2/cookies/ingest',
  agentKey: process.env.WHV2_AGENT_KEY || '',
  cdpUrl: (process.env.WHV2_CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, ''),
  domain: process.env.WHV2_TARGET_DOMAIN || 'writehuman.ai',
  ref: process.env.WHV2_SUPABASE_REF || 'hicfsbrfkzsxbwayibfm',
  pollMs: Math.max(15000, parseInt(process.env.WHV2_POLL_MS, 10) || 120000),
};

function log(event, fields) { try { console.log(`[wh-v2-agent] ${event} ${JSON.stringify(fields || {})}`); } catch (_) {} }

// ── pure helpers (exported for tests) ─────────────────────────────────────────
function authTokenBase(ref) { return 'sb-' + ref + '-auth-token'; }
function isAuthName(name, ref) {
  if (!name) return false;
  const base = authTokenBase(ref);
  return name === base || name.startsWith(base + '.') || name === 'sb-session-token';
}
function domainMatches(cookieDomain, domain) {
  const cd = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!cd) return true;
  return cd === d || cd.endsWith('.' + d) || d.endsWith('.' + cd);
}
// Keep only the auth cookies for the target domain, as { name, value, domain, path }.
function filterAuthCookies(cookies, domain, ref) {
  return (cookies || [])
    .filter((c) => c && isAuthName(c.name, ref) && domainMatches(c.domain, domain))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }));
}
// MUST match session/cookieManager.cookieHash: sha256 of sorted "name=value" joined by \n.
function hashAuthCookies(authList) {
  const items = (authList || []).map((c) => `${c.name}=${c.value == null ? '' : c.value}`).sort();
  if (!items.length) return null;
  return crypto.createHash('sha256').update(items.join('\n')).digest('hex');
}

// ── CDP: read all browser cookies via Storage.getCookies ──────────────────────
async function getAllCookiesViaCDP(cdpUrl) {
  const verRes = await fetch(cdpUrl + '/json/version', { signal: AbortSignal.timeout(8000) });
  if (!verRes.ok) throw new Error('cdp_version_http_' + verRes.status);
  const ver = await verRes.json();
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('cdp_no_ws_url');
  if (typeof WebSocket === 'undefined') throw new Error('no_global_websocket_need_node22');

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (_) {} fn(arg); };
    const t = setTimeout(() => done(reject, new Error('cdp_timeout')), 10000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })); } catch (e) { done(reject, e); } };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id === 1) {
          if (msg.error) return done(reject, new Error('cdp_' + (msg.error.message || 'error')));
          done(resolve, (msg.result && msg.result.cookies) || []);
        }
      } catch (_) { /* ignore non-JSON / other events */ }
    };
    ws.onerror = () => done(reject, new Error('cdp_ws_error'));
    ws.onclose = () => { if (!settled) done(reject, new Error('cdp_ws_closed')); };
  });
}

async function pushIfChanged(state) {
  let cookies;
  try { cookies = await getAllCookiesViaCDP(CFG.cdpUrl); }
  catch (e) { log('cdp_read_failed', { error: e.message }); return; } // retry next tick
  const auth = filterAuthCookies(cookies, CFG.domain, CFG.ref);
  const hash = hashAuthCookies(auth);
  if (!hash) { log('browser_not_authenticated', { auth_cookies: 0 }); return; }
  if (hash === state.lastHash) { log('cookie_unchanged', { hash: hash.slice(0, 8) }); return; }

  let resp;
  try {
    resp = await fetch(CFG.ingestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-key': CFG.agentKey },
      body: JSON.stringify({ cookies: auth }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { log('ingest_post_failed', { error: e.message }); return; } // keep lastHash → retry next tick

  if (resp.ok) {
    state.lastHash = hash;
    let body = null; try { body = await resp.json(); } catch (_) {}
    log('cookie_synchronized', { hash: hash.slice(0, 8), changed: body && body.changed, result: body && body.result });
  } else {
    log('ingest_rejected', { status: resp.status });
  }
}

function start() {
  if (!CFG.agentKey) { log('fatal', { reason: 'WHV2_AGENT_KEY not set' }); process.exit(1); }
  log('starting', { ingest: CFG.ingestUrl, cdp: CFG.cdpUrl, domain: CFG.domain, poll_ms: CFG.pollMs });
  const state = { lastHash: null };
  const tick = () => { pushIfChanged(state).catch((e) => log('tick_error', { error: e && e.message })); };
  tick(); // run once immediately
  const timer = setInterval(tick, CFG.pollMs);
  const shutdown = () => { clearInterval(timer); log('stopping', {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { isAuthName, domainMatches, filterAuthCookies, hashAuthCookies, getAllCookiesViaCDP, CFG };

if (require.main === module) start();

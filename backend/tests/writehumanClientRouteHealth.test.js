'use strict';
/**
 * The admin dashboard must not report WriteHuman as healthy while clients are being sent off the
 * managed origin (2026-10-06: every client launch on writehuman1 was replaced onto the public
 * writehuman.ai). The five existing signals — session, verification, agent, Chrome, cookie sync —
 * are all about the SOURCE side and could all be green during that outage. `clientRoute` is the
 * sixth, separately-scoped signal, read from the gateway's own /__genz/health route self-check.
 *
 * Run: node --test tests/writehumanClientRouteHealth.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveHealth, deriveClientRoute } = require('../utils/proxy/sessionHealth');

const now = Date.now();
const iso = (agoSec) => new Date(now - agoSec * 1000).toISOString();
// Everything on the SOURCE side green — the exact state the dashboard showed while clients broke.
const GREEN = {
  hasBundle: true, sessionStatus: 'working', browserAuthCookies: 2, tokenExpired: false, refreshTokenPresent: true,
  lastVerifyResult: 'working', verificationAgeSec: 60, verificationDueSec: 1200,
  agentStale: false, agentSeenSec: 30, agentStaleSec: 600, devicesPaired: 1, onlineDeviceCount: 1,
  cdpConnected: true, ingestConfigured: true, cookieSyncAgeSec: 120, cookieSyncStaleSec: 5400, lastSyncFailed: false,
};

test('contained + recent → CONTAINED, with its scope and timestamp carried through', () => {
  const r = deriveClientRoute({ result: 'contained', scope: 'public_page_static', checkedAt: iso(60) }, now);
  assert.equal(r.state, 'CONTAINED');
  assert.equal(r.scope, 'public_page_static');
  assert.equal(r.checkedAt, iso(60));
});

test('escape → ESCAPING, and the overall summary says so even with every source signal green', () => {
  const h = deriveHealth({ ...GREEN, clientRoute: { result: 'escape', scope: 'public_page_static', checkedAt: iso(60) }, nowMs: now });
  assert.equal(h.session.state, 'HEALTHY', 'source-side session health is a separate fact and stays as it is');
  assert.equal(h.clientRoute.state, 'ESCAPING');
  assert.match(h.summary, /Client route ESCAPING/);
});

test('no evidence is UNKNOWN, never CONTAINED: unreachable gateway, old gateway without the check, inconclusive check', () => {
  assert.equal(deriveClientRoute(null, now).state, 'UNKNOWN');
  assert.equal(deriveClientRoute({ unreachable: true }, now).state, 'UNKNOWN');
  assert.equal(deriveClientRoute({ ok: true }, now).state, 'UNKNOWN', 'a pre-fix gateway (no route field) proves nothing');
  assert.equal(deriveClientRoute({ result: 'inconclusive', reason: 'upstream_http_502', checkedAt: iso(30) }, now).state, 'UNKNOWN');
});

test('a stale "contained" does not stay current forever', () => {
  assert.equal(deriveClientRoute({ result: 'contained', checkedAt: iso(31 * 60) }, now).state, 'UNKNOWN');
  assert.equal(deriveClientRoute({ result: 'contained', checkedAt: 'garbage' }, now).state, 'UNKNOWN');
});

test('recovery: a later contained verdict supersedes an earlier escape (the check is stateless per read)', () => {
  assert.equal(deriveClientRoute({ result: 'escape', checkedAt: iso(600) }, now).state, 'ESCAPING');
  assert.equal(deriveClientRoute({ result: 'contained', checkedAt: iso(5) }, now).state, 'CONTAINED');
});

test('backwards compatible: callers that pass no clientRoute get UNKNOWN, and the five signals are unchanged', () => {
  const h = deriveHealth(GREEN);
  assert.equal(h.clientRoute.state, 'UNKNOWN');
  assert.equal(h.session.state, 'HEALTHY');
  assert.equal(h.loginRequired, false);
});

test('a caller that never sought route evidence keeps its exact previous summary', () => {
  assert.equal(deriveHealth(GREEN).summary, 'Session HEALTHY');
  assert.equal(deriveHealth({ ...GREEN, clientRoute: null }).summary, 'Session HEALTHY · Client route UNKNOWN');
});

test('admin agent-state wiring: escaping forces overall "down"; unverified can never read "healthy"', () => {
  // Source pin — the tri-state is computed inline in the route, so assert the override exists there.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin', 'proxyTools.js'), 'utf8');
  assert.match(src, /clientRoute: tool === 'writehuman' \? await fetchClientRoute\(tool\) : undefined/);
  assert.match(src, /hs\.clientRoute\.state === 'ESCAPING'\) \{ health = 'down'/);
  assert.match(src, /hs\.clientRoute\.state === 'UNKNOWN' && health === 'up'\) \{ health = 'degraded'/);
});

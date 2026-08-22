'use strict';
/**
 * Unit tests for the Proxy Services SLEEP/WAKE .htaccess transform.
 *
 * These functions decide whether a live proxy vhost mounts its Node app or answers a static 503,
 * so a bug here either leaves a tool unreachable or silently fails to free the RAM. They are pure
 * string transforms with no filesystem access, which is exactly why they are worth pinning down.
 *
 * The `writehuman2` fixture is the important one: that tool was disabled BY HAND on 2026-07-21
 * with a `#GENZ-DISABLED ` prefix, before this module existed. Waking it must strip that older
 * marker too, and sleeping it again must not double-comment the directives.
 */
const test = require('node:test');
const assert = require('node:assert');

// authEnhanced validates required secrets at load; provide test-only values so the
// route module can be imported. These never leave the test process.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { toSleeping, toActive, readState, SERVICE_IDS } = require('../routes/admin/proxySleep').__transform;

// Real shape of an ACTIVE gateway vhost (secrets replaced with placeholders).
const ACTIVE_HTACCESS = `PassengerAppRoot /home/u171982351/grok-gateway
PassengerAppType node
PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node
PassengerStartupFile server.js
PassengerBaseURI /
PassengerRestartDir /home/u171982351/grok-gateway/tmp

# Grok proxy gateway env (persistent via Passenger SetEnv)
SetEnv TOOL_KEY grok
SetEnv TARGET_ORIGIN https://grok.com
SetEnv LEASE_SECRET PLACEHOLDER
SetEnv NODE_OPTIONS "--v8-pool-size=2"
`;

// Real shape of the tool that was disabled by hand during the 2026-07-21 audit.
const HAND_DISABLED_HTACCESS = `#GENZ-DISABLED PassengerAppRoot /home/u171982351/writehuman-v2
#GENZ-DISABLED PassengerAppType node
#GENZ-DISABLED PassengerStartupFile server.js
#GENZ-DISABLED PassengerBaseURI /

SetEnv LSNODE_CONSOLE_LOG 1
`;

test('readState detects an active vhost', () => {
  assert.strictEqual(readState(ACTIVE_HTACCESS), 'ACTIVE');
});

test('readState adopts the hand-disabled writehuman2 as SLEEPING', () => {
  assert.strictEqual(readState(HAND_DISABLED_HTACCESS), 'SLEEPING');
});

test('sleeping comments out every Passenger directive and adds a static 503', () => {
  const out = toSleeping(ACTIVE_HTACCESS);
  assert.strictEqual(readState(out), 'SLEEPING');

  // No Passenger directive may remain live — a single survivor keeps the Node app mounted.
  for (const line of out.split('\n')) {
    assert.ok(!/^\s*Passenger/i.test(line), `directive left active: ${line}`);
  }
  assert.match(out, /ErrorDocument 503 \/maintenance\.html/);
  assert.match(out, /RewriteRule \^ - \[R=503,L\]/);
  // The CDN must not be allowed to cache the 503, or waking the tool appears not to work.
  assert.match(out, /no-store/);
  // Non-Passenger config (env vars) must survive untouched.
  assert.match(out, /SetEnv TOOL_KEY grok/);
});

test('waking restores every Passenger directive and drops the 503 block', () => {
  const out = toActive(toSleeping(ACTIVE_HTACCESS));
  assert.strictEqual(readState(out), 'ACTIVE');
  assert.ok(!/GENZ-SLEEP/.test(out), 'sleep markers must be gone');
  assert.ok(!/ErrorDocument 503/.test(out), '503 block must be gone');
});

test('sleep → wake round-trips back to the original file', () => {
  const out = toActive(toSleeping(ACTIVE_HTACCESS));
  assert.strictEqual(out.trim(), ACTIVE_HTACCESS.trim());
});

test('waking the hand-disabled tool strips the older GENZ-DISABLED marker', () => {
  const out = toActive(HAND_DISABLED_HTACCESS);
  assert.strictEqual(readState(out), 'ACTIVE');
  assert.ok(!/GENZ-DISABLED/.test(out), 'legacy marker must be stripped');
  assert.match(out, /^PassengerAppRoot \/home\/u171982351\/writehuman-v2$/m);
});

test('sleeping the hand-disabled tool does not double-comment it', () => {
  const out = toSleeping(HAND_DISABLED_HTACCESS);
  assert.strictEqual(readState(out), 'SLEEPING');
  assert.ok(!/#GENZ-SLEEP #GENZ-DISABLED/.test(out), 'must not stack markers');
});

test('transitions are idempotent', () => {
  assert.strictEqual(toSleeping(toSleeping(ACTIVE_HTACCESS)), toSleeping(ACTIVE_HTACCESS));
  assert.strictEqual(toActive(toActive(ACTIVE_HTACCESS)), toActive(ACTIVE_HTACCESS));
  // Repeated sleeps must not append the 503 block twice.
  const twice = toSleeping(toSleeping(ACTIVE_HTACCESS));
  assert.strictEqual(twice.match(/ErrorDocument 503/g).length, 1);
});

test('the allowlist is exactly the four authorised proxies', () => {
  assert.deepStrictEqual([...SERVICE_IDS].sort(), ['bypassgpt1', 'grok1', 'hix1', 'writehuman2']);
});

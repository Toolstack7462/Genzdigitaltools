'use strict';
/**
 * Universal Agent — Chrome profile targeting and CDP exposure.
 *
 * Two silent failure modes, in opposite directions, both dangerous:
 *
 *   - too loose: the agent reads a DIFFERENT profile than intended and syncs someone else's or an
 *     empty session, while every downstream signal still says healthy. A substring match makes this
 *     easy — `C:\wh-profile` is a substring of `C:\wh-profile-old`.
 *   - too strict: a case, slash or trailing-separator difference refuses the CORRECT profile, and
 *     sync simply stops. On Windows all three of those differences are routine.
 *
 * So the comparison is canonical, and these pin it. The CDP loopback rule is here too: the debug
 * port is unauthenticated, so a non-loopback endpoint would expose every cookie in the profile to
 * the network — the agent must refuse rather than warn.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const AGENT = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const agent = require(AGENT);

test('the agent package version is the one the backend expects', () => {
  assert.match(agent.AGENT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(agent.AGENT_VERSION, '3.4.0');
});

test('canonical path comparison accepts the same profile written differently', () => {
  const same = [
    ['C:\\wh-profile', 'C:/wh-profile'],
    ['C:\\wh-profile', 'C:\\wh-profile\\'],
    ['C:/wh-profile//', 'C:\\wh-profile'],
  ];
  for (const [a, b] of same) {
    assert.strictEqual(agent.samePath(a, b), true, `${a} should equal ${b}`);
  }
});

test('canonical path comparison rejects a different profile with a shared prefix', () => {
  // The substring trap: this pair must NOT match, or the agent reads the wrong profile.
  assert.strictEqual(agent.samePath('C:\\wh-profile', 'C:\\wh-profile-old'), false);
  assert.strictEqual(agent.samePath('C:\\wh-profile', 'C:\\wh-profile\\Default'), false);
  assert.strictEqual(agent.samePath('C:\\users\\a\\chrome', 'C:\\users\\b\\chrome'), false);
});

test('an empty or missing path never matches anything', () => {
  assert.strictEqual(agent.samePath('', 'C:\\wh-profile'), false);
  assert.strictEqual(agent.samePath('C:\\wh-profile', ''), false);
  assert.strictEqual(agent.samePath(null, null), false, 'two unknowns are not a match');
});

test('case-insensitivity follows the platform', () => {
  const got = agent.samePath('C:\\WH-Profile', 'c:\\wh-profile');
  assert.strictEqual(got, process.platform === 'win32',
    'Windows paths are case-insensitive; POSIX paths are not, and pretending otherwise would let ' +
    'the wrong profile match on Linux');
});

test('the agent refuses a CDP endpoint that is not loopback', async () => {
  // No network is attempted: the check happens before any fetch.
  await assert.rejects(
    () => agent.getAllCookiesViaCDP('http://10.0.0.5:9222', {}),
    /cdp_not_loopback/,
    'an unauthenticated debug port must never be contacted over the network');
  await assert.rejects(() => agent.getAllCookiesViaCDP('http://example.com:9222', {}), /cdp_not_loopback/);
});

test('loopback forms are all accepted by the guard', async () => {
  // These must get PAST the loopback check — they then fail on connection, which is a different
  // error and proves the guard let them through.
  for (const url of ['http://127.0.0.1:59999', 'http://localhost:59999']) {
    await assert.rejects(() => agent.getAllCookiesViaCDP(url, {}), (e) => {
      assert.ok(!/cdp_not_loopback/.test(e.message), `${url} must pass the loopback guard`);
      return true;
    });
  }
});

test('only allowlisted WriteHuman auth cookies are selected for upload', () => {
  const ref = 'hicfsbrfkzsxbwayibfm';
  const cookies = [
    { name: 'sb-' + ref + '-auth-token', domain: '.writehuman.ai', value: 'a' },
    { name: 'sb-' + ref + '-auth-token.0', domain: '.writehuman.ai', value: 'b' },
    { name: 'sb-session-token', domain: '.writehuman.ai', value: 'c' },
    { name: 'ga_tracking', domain: '.writehuman.ai', value: 'd' },
    { name: 'sb-' + ref + '-auth-token', domain: '.example.com', value: 'e' },
  ];
  const got = agent.filterAuthCookies(cookies, 'writehuman.ai', ref).map(c => c.name).sort();
  assert.deepStrictEqual(got, ['sb-' + ref + '-auth-token', 'sb-' + ref + '-auth-token.0', 'sb-session-token']);
});

test('the agent hash is stable and order-independent', () => {
  const ref = 'hicfsbrfkzsxbwayibfm';
  const a = [{ name: 'sb-' + ref + '-auth-token', value: 'x' }, { name: 'sb-session-token', value: 'y' }];
  const b = [a[1], a[0]];
  assert.strictEqual(agent.hashAuthCookies(a), agent.hashAuthCookies(b), 'order must not change the hash');
  assert.notStrictEqual(agent.hashAuthCookies(a), agent.hashAuthCookies([{ name: 'sb-session-token', value: 'z' }]));
});

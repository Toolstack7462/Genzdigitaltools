'use strict';
/**
 * Browser-authorized enrolment: the security properties, not the happy path alone.
 *
 * The happy path is easy to get right by accident. What matters is everything that must NOT work:
 * redeeming twice, redeeming without an admin's approval, redeeming with the wrong verifier or from
 * a different agent, redeeming after expiry. Each of those is a way for someone who glimpsed an
 * enrolment URL to walk off with a credential, so each gets a test.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const enroll = require('../utils/proxy/agentEnroll');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function account() { return { _id: 'acct1', tool: 'writehuman', agentEnrollments: [] }; }
const AGENT = 'agent_' + 'a'.repeat(32);

test('a start request creates an inert pending record', () => {
  const a = account();
  const { challenge } = pkce();
  const r = enroll.start(a, { agentId: AGENT, challenge, name: 'LOCAL-PC', hostname: 'LOCAL-PC' });
  assert.strictEqual(r.ok, true);
  assert.match(r.enrollId, /^enr_[0-9a-f]{24}$/);
  const rec = enroll.find(a, r.enrollId);
  assert.strictEqual(rec.status, enroll.STATUS.PENDING, 'pending until a human approves it');
  assert.ok(new Date(rec.expiresAt) > new Date(), 'and it expires on its own');
});

test('the full flow issues exactly once', () => {
  const a = account();
  const { verifier, challenge } = pkce();
  const { enrollId } = enroll.start(a, { agentId: AGENT, challenge, hostname: 'LOCAL-PC' });

  // Before authorization the agent gets nothing, however correct its verifier.
  assert.strictEqual(enroll.redeem(a, { enrollId, agentId: AGENT, verifier }).code, 'ENROLLMENT_PENDING');

  assert.strictEqual(enroll.authorize(a, enrollId, 'admin1').ok, true);
  const first = enroll.redeem(a, { enrollId, agentId: AGENT, verifier });
  assert.strictEqual(first.ok, true, 'redeems once');

  const replay = enroll.redeem(a, { enrollId, agentId: AGENT, verifier });
  assert.strictEqual(replay.code, 'ENROLLMENT_CONSUMED', 'and never twice');
});

test('the wrong verifier is refused — a glimpsed URL is not enough', () => {
  const a = account();
  const { challenge } = pkce();
  const other = pkce();
  const { enrollId } = enroll.start(a, { agentId: AGENT, challenge, hostname: 'LOCAL-PC' });
  enroll.authorize(a, enrollId, 'admin1');
  const r = enroll.redeem(a, { enrollId, agentId: AGENT, verifier: other.verifier });
  assert.strictEqual(r.code, 'PKCE_FAILED', 'possession of the verifier is what proves identity');
  // And the record survives so the real agent can still complete.
  assert.strictEqual(enroll.find(a, enrollId).status, enroll.STATUS.AUTHORIZED);
});

test('another agent cannot redeem an authorization that is not its own', () => {
  const a = account();
  const { verifier, challenge } = pkce();
  const { enrollId } = enroll.start(a, { agentId: AGENT, challenge, hostname: 'LOCAL-PC' });
  enroll.authorize(a, enrollId, 'admin1');
  const r = enroll.redeem(a, { enrollId, agentId: 'agent_' + 'b'.repeat(32), verifier });
  assert.strictEqual(r.code, 'ENROLLMENT_AGENT_MISMATCH');
});

test('an expired authorization is refused, before and after approval', () => {
  const a = account();
  const { verifier, challenge } = pkce();
  const { enrollId } = enroll.start(a, { agentId: AGENT, challenge, hostname: 'LOCAL-PC' });
  enroll.authorize(a, enrollId, 'admin1');
  enroll.find(a, enrollId).expiresAt = new Date(Date.now() - 1000);

  assert.strictEqual(enroll.redeem(a, { enrollId, agentId: AGENT, verifier }).code, 'ENROLLMENT_EXPIRED');
  assert.strictEqual(enroll.authorize(a, enrollId, 'admin1').code, 'ENROLLMENT_EXPIRED',
    'and an expired request cannot be approved either');
});

test('an unknown enrolment id yields nothing', () => {
  const a = account();
  assert.strictEqual(enroll.redeem(a, { enrollId: 'enr_deadbeefdeadbeefdeadbeef', agentId: AGENT, verifier: 'x' }).code, 'ENROLLMENT_UNKNOWN');
  assert.strictEqual(enroll.authorize(a, 'enr_deadbeefdeadbeefdeadbeef', 'admin1').code, 'ENROLLMENT_UNKNOWN');
});

test('malformed input is rejected at the door', () => {
  const a = account();
  const { challenge } = pkce();
  assert.strictEqual(enroll.start(a, { agentId: 'short', challenge }).code, 'AGENT_ID_INVALID');
  assert.strictEqual(enroll.start(a, { agentId: AGENT, challenge: 'tiny' }).code, 'CHALLENGE_INVALID');
  assert.strictEqual(enroll.start(a, { agentId: 'has spaces!!', challenge }).code, 'AGENT_ID_INVALID');
});

test('pending requests are bounded and pruned, so the record cannot grow forever', () => {
  const a = account();
  const { challenge } = pkce();
  for (let i = 0; i < enroll.MAX_PENDING; i++) {
    assert.strictEqual(enroll.start(a, { agentId: 'agent_' + String(i).padStart(32, '0'), challenge }).ok, true);
  }
  const over = enroll.start(a, { agentId: 'agent_' + 'z'.repeat(32), challenge });
  assert.strictEqual(over.code, 'TOO_MANY_PENDING');

  // Expire them all; the next start prunes and succeeds again.
  for (const r of enroll.list(a)) r.expiresAt = new Date(Date.now() - 1000);
  assert.strictEqual(enroll.start(a, { agentId: 'agent_' + 'z'.repeat(32), challenge }).ok, true);
  assert.ok(enroll.list(a).length <= enroll.MAX_PENDING);
});

test('nothing an admin sees contains the challenge or any secret', () => {
  const a = account();
  const { challenge } = pkce();
  const { enrollId } = enroll.start(a, { agentId: AGENT, challenge, hostname: 'LOCAL-PC' });
  const view = enroll.publicEnrollment(enroll.find(a, enrollId));
  const s = JSON.stringify(view);
  assert.ok(!s.includes(challenge), 'the PKCE challenge is never shown');
  assert.ok(!s.includes(AGENT), 'the full agent id is not shown, only a truncated form');
  assert.match(view.agentIdShort, /\.\.\.$/);
  assert.strictEqual(view.name, 'LOCAL-PC', 'but the operator can still tell which machine it is');
});

test('the TTL sits in the 5-10 minute band the design calls for', () => {
  assert.ok(enroll.ENROLL_TTL_MS >= 5 * 60 * 1000 && enroll.ENROLL_TTL_MS <= 10 * 60 * 1000);
});

'use strict';
/**
 * Browser-authorized agent enrolment.
 *
 * Replaces "copy this secret onto every machine" with "click Authorize once in a browser you are
 * already signed into". The agent never handles a shared secret at all, and there is no new global
 * key to distribute, rotate or lose - which matters here, because losing exactly one such key is
 * what caused a 38-day silent outage.
 *
 * The shape is the OAuth device flow, minus the parts that do not apply:
 *
 *   agent                          server                         admin browser
 *   -----                          ------                         -------------
 *   make agent_id, verifier
 *   challenge = S256(verifier)
 *   POST /enroll/start  ------->   store {agent_id, challenge}
 *                       <-------   enrollId + authorize URL
 *   open browser ------------------------------------------->     signs in (existing admin session)
 *                                  <-------------------------     POST .../authorize  (auth + CSRF)
 *                                  mark authorized
 *   POST /enroll/poll(verifier) -> check S256(verifier)==challenge
 *                       <-------   deviceId + deviceKey  (ONCE)
 *
 * Why PKCE when the poll is already a private channel: `enrollId` travels through a browser URL, so
 * it is not a secret. The verifier never leaves the agent, so possession of it is what proves the
 * poller is the same process that started the flow. Without it, anyone who saw the URL over the
 * admin's shoulder could race the agent and collect the credential.
 *
 * Nothing secret is ever stored in the clear: the verifier is held only by the agent, the challenge
 * is a hash, and the issued device key is stored as a hash by the device registry.
 */
const crypto = require('crypto');

const ENROLL_TTL_MS = 10 * 60 * 1000;   // spec: 5-10 minutes
const MAX_PENDING = 10;                 // bounded, so /enroll/start cannot grow the row without limit
const POLL_INTERVAL_MS = 3000;

const STATUS = { PENDING: 'pending', AUTHORIZED: 'authorized', CONSUMED: 'consumed' };

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
/** PKCE S256, base64url of the SHA-256 digest - the same transform the agent computes. */
function s256(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newId(prefix) { return prefix + '_' + crypto.randomBytes(12).toString('hex'); }

function list(account) {
  const e = account && account.agentEnrollments;
  return Array.isArray(e) ? e : [];
}
function alive(rec, now) {
  return rec && rec.status !== STATUS.CONSUMED && new Date(rec.expiresAt).getTime() > (now || Date.now());
}
/** Drop consumed and expired records so the account document cannot grow without bound. */
function prune(account, now) {
  const t = now || Date.now();
  account.agentEnrollments = list(account).filter(r => alive(r, t)).slice(-MAX_PENDING);
  return account.agentEnrollments;
}

/**
 * Step 1 - the agent asks to enrol. Deliberately unauthenticated: a fresh agent has no credential,
 * which is the entire problem being solved. A pending record grants nothing on its own; it is inert
 * until an authenticated admin authorizes it, and it expires on its own.
 */
function start(account, { agentId, challenge, name, hostname, agentVersion }, now) {
  const t = now || Date.now();
  prune(account, t);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(agentId || ''))) return { ok: false, code: 'AGENT_ID_INVALID' };
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(String(challenge || ''))) return { ok: false, code: 'CHALLENGE_INVALID' };
  if (list(account).length >= MAX_PENDING) return { ok: false, code: 'TOO_MANY_PENDING' };

  const rec = {
    enrollId: newId('enr'),
    agentId: String(agentId),
    challenge: String(challenge),          // a hash of the verifier; useless on its own
    name: String(name || hostname || 'New device').replace(/[^\w .-]/g, '').slice(0, 32) || 'New device',
    hostname: String(hostname || '').replace(/[^\w .-]/g, '').slice(0, 64) || null,
    agentVersion: String(agentVersion || '').replace(/[^\w.-]/g, '').slice(0, 20) || null,
    status: STATUS.PENDING,
    createdAt: new Date(t),
    expiresAt: new Date(t + ENROLL_TTL_MS),
    authorizedAt: null,
    authorizedBy: null,
  };
  account.agentEnrollments = list(account).concat([rec]);
  return { ok: true, code: 'OK', enrollId: rec.enrollId, expiresAt: rec.expiresAt, pollIntervalMs: POLL_INTERVAL_MS };
}

/** Safe projection for the admin page - no challenge, no ids that would help an attacker. */
function publicEnrollment(rec, now) {
  if (!rec) return null;
  const t = now || Date.now();
  return {
    enrollId: rec.enrollId,
    name: rec.name,
    hostname: rec.hostname,
    agentVersion: rec.agentVersion,
    status: rec.status,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    expired: new Date(rec.expiresAt).getTime() <= t,
    // The agent id, shown truncated so the admin can tell two pending requests apart without
    // reading a full identifier off the screen.
    agentIdShort: String(rec.agentId || '').slice(0, 14) + '...',
  };
}

function find(account, enrollId) {
  return list(account).find(r => r && r.enrollId === enrollId) || null;
}

/** Step 2 - an authenticated admin approves one specific pending request. */
function authorize(account, enrollId, adminId, now) {
  const t = now || Date.now();
  const rec = find(account, enrollId);
  if (!rec) return { ok: false, code: 'ENROLLMENT_UNKNOWN' };
  if (rec.status === STATUS.CONSUMED) return { ok: false, code: 'ENROLLMENT_CONSUMED' };
  if (new Date(rec.expiresAt).getTime() <= t) return { ok: false, code: 'ENROLLMENT_EXPIRED' };
  if (rec.status === STATUS.AUTHORIZED) return { ok: true, code: 'ALREADY_AUTHORIZED', record: rec };
  rec.status = STATUS.AUTHORIZED;
  rec.authorizedAt = new Date(t);
  rec.authorizedBy = adminId ? String(adminId) : null;
  account.agentEnrollments = list(account).map(r => (r.enrollId === enrollId ? rec : r));
  return { ok: true, code: 'OK', record: rec };
}

/**
 * Step 3 - the agent redeems its authorization.
 *
 * Every one of these checks earns its place: the record must exist, be authorized rather than
 * merely requested, not have expired, not have been consumed already (replay), and the presented
 * verifier must hash to the stored challenge (proving this is the same agent that started it).
 * Only then is the enrolment marked consumed and the caller allowed to mint a credential.
 */
function redeem(account, { enrollId, agentId, verifier }, now) {
  const t = now || Date.now();
  const rec = find(account, enrollId);
  if (!rec) return { ok: false, code: 'ENROLLMENT_UNKNOWN' };
  if (rec.status === STATUS.CONSUMED) return { ok: false, code: 'ENROLLMENT_CONSUMED' };
  if (new Date(rec.expiresAt).getTime() <= t) return { ok: false, code: 'ENROLLMENT_EXPIRED' };
  if (rec.status !== STATUS.AUTHORIZED) return { ok: false, code: 'ENROLLMENT_PENDING' };
  if (String(rec.agentId) !== String(agentId || '')) return { ok: false, code: 'ENROLLMENT_AGENT_MISMATCH' };

  const got = s256(verifier || '');
  const a = Buffer.from(got), b = Buffer.from(String(rec.challenge));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'PKCE_FAILED' };

  rec.status = STATUS.CONSUMED;
  rec.consumedAt = new Date(t);
  account.agentEnrollments = list(account).map(r => (r.enrollId === enrollId ? rec : r));
  return { ok: true, code: 'OK', record: rec };
}

module.exports = {
  STATUS, ENROLL_TTL_MS, MAX_PENDING, POLL_INTERVAL_MS,
  sha256, s256, start, authorize, redeem, find, list, prune, publicEnrollment,
};

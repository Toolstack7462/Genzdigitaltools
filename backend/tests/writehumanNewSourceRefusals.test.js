'use strict';
/**
 * THE ORIGINAL INCIDENT: "new source -> Mark as Active fails".
 *
 * That one sentence is the only evidence in hand. No status, no code, no screenshot, no logs were
 * captured, and nothing here invents one: no live attempt is made and no failure is manufactured.
 * What CAN be done from the source is a differential — enumerate every way a device that was JUST
 * paired can be refused by this route, and for each, pin the behaviour that distinguishes it from
 * the others. That turns "it fails" into a ranked shortlist plus the single field that decides
 * between them, which is what the next real error message is for.
 *
 * These are CHARACTERIZATION tests of existing behaviour, not fixes. Several describe refusals
 * that are correct and protective. Nothing here changes eligibility, authorization, replay or
 * previous-source protection; the one defect-shaped finding is documented, not silently altered,
 * because changing supersede/eligibility rules on a hypothesis is how a working source gets lost.
 *
 * docs/MARK-ACTIVE-INCIDENT.md is the operator-facing form of this, with the evidence that is
 * still missing marked unknown.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const deviceSync = require('../utils/proxy/deviceSync');
const deviceState = require('../utils/proxy/deviceState');
const agentCommands = require('../utils/proxy/agentCommands');

const STALE_MS = 10 * 60000;
const ago = (ms) => new Date(Date.now() - ms);

/** A freshly paired, healthy device: the baseline every case below deviates from by ONE field. */
function newDevice(over = {}) {
  return {
    deviceId: 'agent_new', name: 'RDP-01', hostname: 'RDP-01',
    agentVersion: '3.5.15', keyHash: 'x'.repeat(64),
    pairedAt: ago(60000), lastSeenAt: ago(5000),
    revoked: false, uninstalledAt: null, supersededBy: null,
    ...over,
  };
}
const accountWith = (devices, activeId = null) => ({
  tool: 'writehuman', isPrimary: true, syncDevices: devices,
  activeSource: activeId ? { deviceId: activeId } : null,
});
const TARGET_OPTS = {
  requireActiveSource: false, requireOnline: true, requireCommandSupport: true,
  requireActivationSupport: true, staleMs: STALE_MS,
};

describe('new source: the baseline must actually be activatable', () => {
  test('a freshly paired, heartbeating, credentialled 3.5.15 device passes every gate', () => {
    const dev = newDevice();
    const account = accountWith([dev]);
    const st = deviceState.stateOf(account, dev, { staleMs: STALE_MS });
    assert.ok(deviceState.canActivate(st.state),
      `a healthy new device must be activatable, got ${st.state}: ${st.reason}`);
    const t = agentCommands.validateTarget(account, dev.deviceId, TARGET_OPTS);
    assert.ok(t.ok, `validateTarget refused a healthy new device: ${t.code} ${t.message}`);
    // This is the control. If it ever fails, the incident is NOT environmental.
  });

  test('a non-active device is not refused merely for not being the active source', () => {
    // The standing requirement: a newly authorized target must not have to already BE the active
    // source to receive its scoped activation command.
    const dev = newDevice();
    const other = newDevice({ deviceId: 'agent_old', name: 'RDP-00' });
    const t = agentCommands.validateTarget(accountWith([other, dev], 'agent_old'),
      dev.deviceId, TARGET_OPTS);
    assert.ok(t.ok, `a non-active new device must still be addressable, got ${t.code}`);
  });
});

describe('new source: every refusal a just-paired device can hit, and its discriminator', () => {
  // Each case names the code the operator would have seen. That code is the evidence that would
  // pick one of these out of the list.
  const cases = [
    ['never heartbeated (paired, agent not yet running)',
      { lastSeenAt: null }, 'DEVICE_OFFLINE'],
    ['heartbeat older than the 10-minute window',
      { lastSeenAt: ago(STALE_MS + 60000) }, 'DEVICE_OFFLINE'],
    ['paired without completing key enrolment',
      { keyHash: null }, 'DEVICE_NO_CREDENTIAL'],
    ['agent too old for addressed commands at all',
      { agentVersion: '3.3.9' }, 'COMMAND_VERSION_UNSUPPORTED'],
    ['agent new enough for commands but not for on-device capture',
      { agentVersion: '3.4.5' }, 'ACTIVATION_VERSION_UNSUPPORTED'],
    ['agent version not reported by the agent at all',
      { agentVersion: null }, 'COMMAND_VERSION_UNSUPPORTED'],
    ['record explicitly superseded by a later enrolment',
      { supersededBy: 'agent_newer', lastSeenAt: ago(STALE_MS + 60000) }, 'DEVICE_SUPERSEDED'],
    ['revoked', { revoked: true }, 'DEVICE_REVOKED'],
    ['agent uninstalled on that machine', { uninstalledAt: ago(1000) }, 'DEVICE_UNINSTALLED'],
  ];

  for (const [label, over, expected] of cases) {
    test(`${label} -> ${expected}`, () => {
      const dev = newDevice(over);
      const t = agentCommands.validateTarget(accountWith([dev]), dev.deviceId, TARGET_OPTS);
      assert.equal(t.ok, false, `${label} must be refused, not silently accepted`);
      assert.equal(t.code, expected,
        `${label} must be distinguishable by its code — the operator's error message is the only `
        + 'evidence this incident has, so two different causes must not share one code');
      assert.ok(t.message && t.message.length > 10,
        'every refusal must carry an actionable message, not just a code');
    });
  }

  test('an unpaired/unknown device id is refused as unknown, not as something else', () => {
    const t = agentCommands.validateTarget(accountWith([newDevice()]), 'agent_absent', TARGET_OPTS);
    assert.equal(t.code, 'DEVICE_UNKNOWN');
  });

  test('every refusal happens BEFORE any command is minted', () => {
    // So that each of the cases above is a 409 with nothing queued — which is what makes the code
    // in the operator's screenshot safe to act on.
    for (const [, over] of cases) {
      const dev = newDevice(over);
      const account = accountWith([dev]);
      const t = agentCommands.validateTarget(account, dev.deviceId, TARGET_OPTS);
      assert.equal(t.ok, false);
      assert.ok(!(account.commands || []).length, 'a refused target must not leave a command behind');
    }
  });
});

describe('new source: the latched-ERROR trap, which rewrites the evidence', () => {
  test('one earlier failure makes every later press report DEVICE_ERROR instead', () => {
    // deviceState ranks ERROR above READY, and canActivate admits only READY/STANDBY. So the
    // SECOND press reports a different cause than the first. Any captured DEVICE_ERROR therefore
    // points at /activation's failureCode, not at itself.
    const dev = newDevice({ lastResultCode: 'ACCOUNT_MISMATCH' });
    const st = deviceState.stateOf(accountWith([dev]), dev, { staleMs: STALE_MS });
    assert.equal(st.state, 'ERROR',
      'an earlier ACCOUNT_MISMATCH must latch the device into ERROR — this is the trap');
    assert.ok(!deviceState.canActivate('ERROR'),
      'ERROR must not be activatable, or the latch would be meaningless');
    assert.ok(!deviceState.canActivate('OFFLINE'));
    for (const ok of ['READY', 'STANDBY']) assert.ok(deviceState.canActivate(ok));
  });
});

describe('supersede: what the heuristic can and cannot refuse', () => {
  /**
   * CORRECTION TO AN EARLIER CLAIM IN THIS FILE.
   *
   * An earlier revision presented the supersede heuristic as a strong candidate for
   * "new source -> Mark as Active fails", on a fixture that cannot occur: a device paired one
   * minute ago whose last heartbeat was eleven minutes ago. Pairing IS contact, so `lastSeenAt`
   * cannot predate `pairedAt`.
   *
   * More importantly, `isSupersededDevice()` returns false for ANY online device — its second
   * guard is `if (isOnline(dev, staleMs)) return false`. So the heuristic cannot refuse a device
   * that is heartbeating, however many same-named records exist. It only ever relabels an OFFLINE
   * device's refusal: without it that device gets `DEVICE_OFFLINE`, with it `DEVICE_SUPERSEDED`
   * (the supersede check runs before `requireOnline`). It cannot block a healthy new source.
   *
   * `DEVICE_SUPERSEDED` therefore identifies a refusal CATEGORY, not a root cause, and it does not
   * on its own distinguish the heuristic from an explicit `supersededBy` written by re-enrolment.
   * No speculative `pairedAt` fix is implemented and no eligibility rule is weakened.
   */
  test('CONTROL: an ONLINE new device is never superseded, even by a more recent sibling', () => {
    // The case the earlier claim needed and never tested: the new device is healthy and online,
    // and an older same-named record heartbeated even more recently.
    const fresh = newDevice({
      deviceId: 'agent_fresh', name: 'RDP-01',
      pairedAt: ago(120000), lastSeenAt: ago(60000), // paired 2 min ago, seen 1 min ago: online
    });
    const older = newDevice({
      deviceId: 'agent_older', name: 'RDP-01',
      pairedAt: ago(90 * 24 * 3600 * 1000), lastSeenAt: ago(1000), // seen MORE recently
    });
    const account = accountWith([older, fresh]);
    assert.ok(new Date(older.lastSeenAt) > new Date(fresh.lastSeenAt),
      'the fixture must have the OLDER record heartbeating more recently');

    assert.equal(deviceSync.isSupersededDevice(account, fresh, STALE_MS), false,
      'an online device must never be judged superseded — isOnline() short-circuits the heuristic');
    const t = agentCommands.validateTarget(account, fresh.deviceId, TARGET_OPTS);
    assert.ok(t.ok,
      `a healthy online new source must pass, got ${t.code} — the heuristic cannot be the cause `
      + 'of a refusal for a device that is actually running');
  });

  test('the heuristic only ever relabels an OFFLINE refusal, and needs a plausible timeline', () => {
    // A plausible stale device: paired three days ago, last heard from 40 minutes ago (so it is
    // offline), while the same machine's newer enrolment is live.
    const stale = newDevice({
      deviceId: 'agent_stale', name: 'RDP-01',
      pairedAt: ago(3 * 24 * 3600 * 1000), lastSeenAt: ago(40 * 60000),
    });
    const live = newDevice({
      deviceId: 'agent_live', name: 'RDP-01',
      pairedAt: ago(10 * 60000), lastSeenAt: ago(30000),
    });
    assert.ok(new Date(stale.lastSeenAt) >= new Date(stale.pairedAt),
      'a device cannot have been seen before it was paired');

    const withSibling = accountWith([live, stale]);
    assert.equal(deviceSync.isSupersededDevice(withSibling, stale, STALE_MS), true);
    assert.equal(agentCommands.validateTarget(withSibling, stale.deviceId, TARGET_OPTS).code,
      'DEVICE_SUPERSEDED');

    // The SAME offline device, with no sibling, is refused as offline instead. That difference is
    // the heuristic's entire effect on this route: which name the refusal carries.
    const alone = accountWith([stale]);
    assert.equal(deviceSync.isSupersededDevice(alone, stale, STALE_MS), false);
    assert.equal(agentCommands.validateTarget(alone, stale.deviceId, TARGET_OPTS).code,
      'DEVICE_OFFLINE');
  });

  test('explicit supersededBy is a DIFFERENT cause that shares the code', () => {
    // Written by re-enrolment rather than inferred. It refuses even an ONLINE device, so it is the
    // only way a heartbeating new source can see DEVICE_SUPERSEDED — which is why the code alone
    // does not identify which of the two happened.
    const online = newDevice({ deviceId: 'agent_online', supersededBy: 'agent_newer' });
    assert.equal(deviceSync.isSupersededDevice(accountWith([online]), online, STALE_MS), false,
      'the heuristic does not fire here — the flag is what refuses it');
    assert.equal(agentCommands.validateTarget(accountWith([online]), online.deviceId, TARGET_OPTS).code,
      'DEVICE_SUPERSEDED',
      'so the same code covers an explicit flag and an inferred offline sibling');
  });

  test('the heuristic still protects the case it was written for', () => {
    const live = newDevice({ deviceId: 'agent_live', name: 'RDP-01', pairedAt: ago(600000), lastSeenAt: ago(5000) });
    const dead = newDevice({ deviceId: 'agent_dead', name: 'RDP-01', pairedAt: ago(90 * 24 * 3600 * 1000), lastSeenAt: ago(STALE_MS + 60000) });
    const account = accountWith([live, dead]);
    assert.equal(deviceSync.isSupersededDevice(account, dead, STALE_MS), true);
    assert.equal(deviceSync.isSupersededDevice(account, live, STALE_MS), false);
  });

  test('the active source is never judged superseded, whatever the heartbeats say', () => {
    const act = newDevice({ deviceId: 'agent_act', name: 'RDP-01', lastSeenAt: ago(STALE_MS + 60000) });
    const other = newDevice({ deviceId: 'agent_other', name: 'RDP-01', lastSeenAt: ago(1000) });
    assert.equal(
      deviceSync.isSupersededDevice(accountWith([act, other], 'agent_act'), act, STALE_MS), false,
      'the working source must never be demoted by this heuristic');
  });
});

describe('correlation: targetDeviceId + stageAt does NOT identify an attempt', () => {
  /**
   * CORRECTION TO THE CAPTURE DOCUMENT'S §4 RULE.
   *
   * It said `/activation` could be treated as describing your attempt when no activationId was
   * returned, provided its `targetDeviceId` matched the device you targeted AND its `stageAt` was
   * at or after your attempt. That is unsound. An OLDER activation for the SAME device keeps
   * advancing while the agent works on it, so its `stageAt` moves past the timestamp of a LATER
   * request that was refused before `activation.create()` was ever called. Both halves of the
   * predicate then hold while the record describes a different, earlier attempt.
   *
   * Timestamps alone are not proof. Without an attempt-specific identifier the status is UNKNOWN.
   */
  const activation = require('../utils/proxy/activation');

  test('an older activation advancing after a failed newer request satisfies the old rule', () => {
    const dev = newDevice({ deviceId: 'agent_target', name: 'RDP-01' });
    const account = accountWith([dev]);

    // 10 minutes ago: a Mark as Active was accepted for this device and is still in flight.
    const earlier = new Date(Date.now() - 600000);
    const first = activation.create(account, { device: dev, issuedBy: 'admin1', now: earlier, ttlMs: 3600000 });
    assert.ok(first.ok);
    const firstId = first.activation.activationId;

    // NOW: the operator presses again and is refused BEFORE activation.create() — so no record
    // exists for this attempt. (Any pre-create refusal does this; see the differential above.)
    const attemptAt = new Date();

    // A moment later the agent advances the EARLIER activation.
    const adv = activation.advance(account, {
      activationId: firstId, stage: 'OPENING_CHROME', fromAgent: true,
      now: new Date(attemptAt.getTime() + 5000),
    });
    assert.ok(adv.ok && !adv.noop, 'the earlier activation must actually have advanced');

    const live = activation.current(account, new Date(attemptAt.getTime() + 6000));
    assert.equal(live.activationId, firstId, 'the record on the account is still the EARLIER one');

    // The withdrawn predicate, applied literally:
    const deviceMatches = live.targetDeviceId === dev.deviceId;
    const stageAtAfterAttempt = new Date(live.stageAt).getTime() >= attemptAt.getTime();
    assert.ok(deviceMatches && stageAtAfterAttempt,
      'both halves of the old rule hold here — which is exactly the problem');
    assert.notEqual(live.activationId, null);

    // ...and it is wrong: this record is not the operator's attempt. Nothing was created for it.
    assert.ok(new Date(live.createdAt).getTime() < attemptAt.getTime(),
      'the record predates the attempt it would have been attributed to');
  });

  test('only an activationId match is conclusive; otherwise the status stays UNKNOWN', () => {
    const dev = newDevice({ deviceId: 'agent_target' });
    const account = accountWith([dev]);
    const earlier = new Date(Date.now() - 600000);
    const first = activation.create(account, { device: dev, issuedBy: 'admin1', now: earlier, ttlMs: 3600000 });
    const live = activation.current(account, new Date());

    // The corrected rule, as the capture document now states it.
    const correlates = (record, attempt) =>
      !!(record && attempt.activationId && record.activationId === attempt.activationId);

    assert.equal(correlates(live, { activationId: first.activation.activationId }), true,
      'a returned activationId that matches IS conclusive');
    assert.equal(correlates(live, { activationId: null }), false,
      'no returned id means no correlation — UNKNOWN, not "probably mine"');
    assert.equal(correlates(live, { activationId: 'act_somethingelse' }), false,
      'a different id means the record is NOT this attempt');
    assert.equal(correlates(null, { activationId: 'act_x' }), false,
      'a null activation correlates with nothing');
  });

  test('the capture and incident documents state the corrected rule', () => {
    const fs = require('fs');
    const path = require('path');
    const docs = path.join(__dirname, '..', '..', 'writehuman-v2', 'docs');
    const capture = fs.readFileSync(path.join(docs, 'MARK-ACTIVE-EVIDENCE-CAPTURE.md'), 'utf8');
    const incident = fs.readFileSync(path.join(docs, 'MARK-ACTIVE-INCIDENT.md'), 'utf8');
    // Assembled so this check does not match its own source.
    const withdrawn = new RegExp(['`targetDeviceId` matches the', 'device you targeted \\*\\*and\\*\\*'].join(''));
    assert.ok(!withdrawn.test(capture),
      'the capture document still carries the withdrawn targetDeviceId+stageAt rule');
    for (const [name, doc] of [['capture', capture], ['incident', incident]]) {
      assert.match(doc, /UNKNOWN/,
        `the ${name} document must retain UNKNOWN status without an attempt-specific identifier`);
    }
    assert.match(capture, /not proof|never proof/,
      'the capture document must say timestamps alone are not proof');
  });
});

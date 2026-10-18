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

describe('FINDING: supersede is decided by name and lastSeenAt, never by pairedAt', () => {
  /**
   * CHARACTERIZATION OF A DEFECT-SHAPED PATH — not changed here.
   *
   * isSupersededDevice() calls a device superseded when another non-revoked device shares its
   * `name` and has a NEWER `lastSeenAt`. It never consults `pairedAt`. "Newest heartbeat wins" is
   * not the same rule as "newest enrolment wins", and they disagree in exactly the scenario the
   * incident describes: the agent is reinstalled on a machine (a reinstall mints a fresh deviceId),
   * but the OLD agent is still running and still heartbeating from that same host. The old record
   * then has the newer lastSeenAt, so the NEW record — the one the operator just paired and is
   * trying to activate — is the one judged superseded.
   *
   * This fits the single symptom in hand. It is NOT asserted to be the cause: `DEVICE_SUPERSEDED`
   * in the operator's error would support it, any other code would rule it out. The rule is left
   * exactly as it is until that evidence exists, because loosening a supersede check on a
   * hypothesis risks addressing a command to a stale enrolment of a working source.
   */
  test('a newly paired device loses to an older record that is still heartbeating', () => {
    const fresh = newDevice({
      deviceId: 'agent_fresh', name: 'RDP-01',
      pairedAt: ago(60000), lastSeenAt: ago(STALE_MS + 60000), // paired now, gone quiet since
    });
    const stale = newDevice({
      deviceId: 'agent_stale', name: 'RDP-01',
      pairedAt: ago(90 * 24 * 3600 * 1000), lastSeenAt: ago(5000), // old enrolment, still alive
    });
    const account = accountWith([stale, fresh]);

    assert.equal(deviceSync.isSupersededDevice(account, fresh, STALE_MS), true,
      'current behaviour: the NEWER enrolment is judged superseded by the OLDER one');
    assert.ok(new Date(fresh.pairedAt) > new Date(stale.pairedAt),
      'and it is the newer enrolment by pairedAt — the field the rule does not read');

    const t = agentCommands.validateTarget(account, fresh.deviceId, TARGET_OPTS);
    assert.equal(t.code, 'DEVICE_SUPERSEDED',
      'so Mark as Active refuses the new source with DEVICE_SUPERSEDED — this is the code that '
      + 'would confirm this path, and its absence that would rule it out');
  });

  test('the ordering rule still protects the case it was written for', () => {
    // A genuinely abandoned old row, with the live one being the newer enrolment: the old row must
    // still be superseded. Any future fix must keep this true.
    const live = newDevice({ deviceId: 'agent_live', name: 'RDP-01', pairedAt: ago(60000), lastSeenAt: ago(5000) });
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

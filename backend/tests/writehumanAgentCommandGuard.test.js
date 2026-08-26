'use strict';
/**
 * The AGENT-side half of the no-wrong-machine guarantee.
 *
 * The server already refuses to address a revoked / superseded / non-active-source device, and only
 * hands a command to the device named in it. This is the SECOND, INDEPENDENT lock: the agent
 * re-checks the address before it does anything, so a server bug, a shared response or a replayed
 * body still cannot open a Chrome window on someone's desk.
 *
 * It also pins the refusal of the pre-3.4.0 bare-string command — the exact shape that used to be
 * broadcast to whichever agent polled first.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const AGENT = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const { handleCommand, AGENT_VERSION } = require(AGENT);

const ME = 'dev_rdp01';
const state = () => ({ device: { deviceId: ME, deviceKey: 'k' }, lastHash: 'abc', forceNext: false, pendingAck: null });
const cmd = (o = {}) => ({
  id: 'cmd_1', type: 'resync', tool: 'writehuman', targetDeviceId: ME,
  nonce: 'n1', expiresAt: new Date(Date.now() + 60000).toISOString(), ...o,
});

test('the agent ships a version that understands addressed commands', () => {
  const [maj, min] = AGENT_VERSION.split('.').map(Number);
  assert.ok(maj > 3 || (maj === 3 && min >= 4), 'expected >= 3.4.0, got ' + AGENT_VERSION);
});

test('a command addressed to THIS device is executed', () => {
  const s = state();
  handleCommand(s, cmd());
  assert.strictEqual(s.forceNext, true);
  assert.strictEqual(s.lastHash, null);
  assert.strictEqual(s.pendingAck.commandId, 'cmd_1');
});

test('a command addressed to ANOTHER device is refused outright', () => {
  const s = state();
  handleCommand(s, cmd({ targetDeviceId: 'dev_someone_else' }));
  assert.strictEqual(s.forceNext, false, 'must not act');
  assert.strictEqual(s.pendingAck, null, 'must not even acknowledge it');
  assert.strictEqual(s.lastCommand, undefined);
});

test('a command with NO target is refused — that is the shape that hit the wrong machine', () => {
  const s = state();
  handleCommand(s, cmd({ targetDeviceId: undefined }));
  assert.strictEqual(s.forceNext, false);
});

test('the pre-3.4.0 bare string is refused rather than obeyed', () => {
  for (const legacy of ['relaunch-chrome', 'reverify']) {
    const s = state();
    handleCommand(s, legacy);
    assert.strictEqual(s.forceNext, false, legacy);
    assert.strictEqual(s.pendingAck, null, legacy);
  }
});

test('an expired command is refused', () => {
  const s = state();
  handleCommand(s, cmd({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.strictEqual(s.forceNext, false);
});

test('a command scoped to another tool is refused', () => {
  const s = state();
  handleCommand(s, cmd({ tool: 'stealthwriter' }));
  assert.strictEqual(s.forceNext, false);
});

test('a stood-down (revoked) agent executes nothing, however well addressed', () => {
  const s = state();
  s.standDown = true;
  handleCommand(s, cmd({ type: 'open-chrome' }));
  assert.strictEqual(s.pendingAck, null);
  assert.strictEqual(s.lastCommand, undefined);
});

test('malformed input is refused, not thrown on', () => {
  for (const bad of [null, undefined, {}, { id: 'x' }, { type: 'resync' }, 42, []]) {
    const s = state();
    assert.doesNotThrow(() => handleCommand(s, bad));
    assert.strictEqual(s.forceNext, false);
  }
});

test('an unknown command type does nothing', () => {
  const s = state();
  handleCommand(s, cmd({ type: 'format-c-drive' }));
  assert.strictEqual(s.forceNext, false);
});

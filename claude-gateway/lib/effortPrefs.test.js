'use strict';
/**
 * Tests for the Claude default-effort preference decision logic (lib/effortPrefs.js).
 * Covers: session loading, new chats, manual user changes, refreshes, Personal/Team switching
 * (reload), the /new→/chat continuation, UI-selector failure, and the separate thinking default.
 * Pure — no DOM, no network. Run: node --test lib/effortPrefs.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('./effortPrefs');

test('normalizeEffort: canonical levels, aliases, and fallback to medium', () => {
  assert.equal(e.normalizeEffort('low'), 'low');
  assert.equal(e.normalizeEffort('Medium'), 'medium');
  assert.equal(e.normalizeEffort('max'), 'max');
  assert.equal(e.normalizeEffort('maximum'), 'max');
  assert.equal(e.normalizeEffort('extra high'), 'extra');
  assert.equal(e.normalizeEffort('standard'), 'medium'); // alias
  assert.equal(e.normalizeEffort('garbage'), 'medium');  // fallback
  assert.equal(e.normalizeEffort(null), 'medium');
  assert.equal(e.normalizeEffort('garbage', 'high'), 'high'); // explicit fallback honoured
});

test('parseEffortFromText: extracts a level; "extra high" beats "high"; null when none', () => {
  assert.equal(e.parseEffortFromText('Effort: Medium'), 'medium');
  assert.equal(e.parseEffortFromText('High effort'), 'high');
  assert.equal(e.parseEffortFromText('Extra high'), 'extra');
  assert.equal(e.parseEffortFromText('Maximum'), 'max');
  assert.equal(e.parseEffortFromText('Send message'), null);
  assert.equal(e.parseEffortFromText(''), null);
});

test('sameEffort compares canonically', () => {
  assert.equal(e.sameEffort('medium', 'Medium'), true);
  assert.equal(e.sameEffort('max', 'maximum'), true);
  assert.equal(e.sameEffort('high', 'extra'), false);
  assert.equal(e.sameEffort('medium', null), false);
});

// ── Session loading ──────────────────────────────────────────────────────────
test('session load: not-ready waits; ready + different current applies; matching skips', () => {
  const base = { target: 'medium', conversationKey: 'new', handledFor: null };
  assert.equal(e.decideEffort({ ...base, ready: false }).action, 'wait');
  assert.equal(e.decideEffort({ ...base, ready: true, controlFound: true, current: 'high' }).action, 'apply');
  // "do not click when Medium is already selected"
  assert.equal(e.decideEffort({ ...base, ready: true, controlFound: true, current: 'medium' }).action, 'skip');
});

test('applies the ADMIN-configured target (e.g. High), not always medium', () => {
  const d = e.decideEffort({ ready: true, controlFound: true, current: 'low', target: 'high', conversationKey: 'new', handledFor: null });
  assert.equal(d.action, 'apply');
  assert.equal(d.target, 'high');
});

// ── Apply once; never override a manual change ──────────────────────────────
test('once handled for a conversation, never touch effort again (manual change preserved)', () => {
  // The user manually switched to 'low' after we applied 'medium'; we already marked it handled.
  const d = e.decideEffort({ ready: true, controlFound: true, current: 'low', target: 'medium', conversationKey: 'chat:abc', handledFor: 'chat:abc' });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'already-handled');
});

// ── New chats + refreshes + Personal/Team switching ─────────────────────────
test('new conversation detection: fresh on load, on New-chat, and after a reload', () => {
  // First load → fresh.
  assert.deepEqual(e.nextConversationState(null, '/new'), { key: 'new', fresh: true, inherit: false });
  // Starting a New chat from an existing conversation → fresh again.
  assert.deepEqual(e.nextConversationState('chat:old', '/new'), { key: 'new', fresh: true, inherit: false });
  // A refresh / Personal-Team switch reloads the page → prevKey resets to null → fresh.
  assert.equal(e.nextConversationState(null, '/chat/xyz').fresh, true);
  // Same path (a no-op re-eval) → not fresh (apply only once).
  assert.equal(e.nextConversationState('chat:xyz', '/chat/xyz').fresh, false);
});

test('the /new → /chat/<id> transition is the SAME conversation (no re-apply, carries handled)', () => {
  const s = e.nextConversationState('new', '/chat/abc123');
  assert.equal(s.key, 'chat:abc123');
  assert.equal(s.fresh, false);
  assert.equal(s.inherit, true); // carry the handled flag so we don't re-apply after the first message
});

test('opening a DIFFERENT existing chat does not re-apply (avoid overriding it)', () => {
  const s = e.nextConversationState('chat:a', '/chat/b');
  assert.equal(s.fresh, false);
  assert.equal(s.inherit, false);
});

// ── UI-selector failure ──────────────────────────────────────────────────────
test('control unavailable: waits while retrying, then warns once and skips (no loop, no break)', () => {
  const base = { ready: true, controlFound: false, current: null, target: 'medium', conversationKey: 'new', handledFor: null };
  assert.equal(e.decideEffort({ ...base, attemptsExhausted: false }).action, 'wait');
  const done = e.decideEffort({ ...base, attemptsExhausted: true });
  assert.equal(done.action, 'warn-skip');
  assert.equal(done.reason, 'control-unavailable');
});

test('control found but current effort undetectable → treated as unavailable (never blind-click)', () => {
  const d = e.decideEffort({ ready: true, controlFound: true, current: null, target: 'medium', conversationKey: 'new', handledFor: null, attemptsExhausted: true });
  assert.equal(d.action, 'warn-skip');
});

// ── Thinking default (separate; OFF by default) ─────────────────────────────
test('thinking default OFF → never touch the thinking control (users may enable manually)', () => {
  const d = e.decideThinking({ enabled: false, ready: true, controlFound: true, currentOn: false, conversationKey: 'new', handledFor: null });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'thinking-default-off');
});

test('thinking default ON → enable once when off; skip when already on or already handled', () => {
  assert.equal(e.decideThinking({ enabled: true, ready: true, controlFound: true, currentOn: false, conversationKey: 'new', handledFor: null }).action, 'apply');
  assert.equal(e.decideThinking({ enabled: true, ready: true, controlFound: true, currentOn: true, conversationKey: 'new', handledFor: null }).action, 'skip');
  assert.equal(e.decideThinking({ enabled: true, ready: true, controlFound: true, currentOn: false, conversationKey: 'new', handledFor: 'new' }).action, 'skip');
});

test('parseThinkingDefault: off by default; explicit truthy strings enable', () => {
  assert.equal(e.parseThinkingDefault(undefined), false);
  assert.equal(e.parseThinkingDefault('0'), false);
  assert.equal(e.parseThinkingDefault('false'), false);
  assert.equal(e.parseThinkingDefault('1'), true);
  assert.equal(e.parseThinkingDefault('on'), true);
  assert.equal(e.parseThinkingDefault(true), true);
});

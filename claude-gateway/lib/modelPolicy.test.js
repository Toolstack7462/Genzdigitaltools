'use strict';
/**
 * Claude model allowlist (claude-only). Fable 5 must be unreachable for proxy clients no matter
 * how the request is constructed, and every other model must be completely unaffected.
 */
const test = require('node:test');
const assert = require('node:assert');
const mp = require('./modelPolicy');

const OFF = { allowed: false, fallback: 'claude-opus-4-8' };
const ON = { allowed: true, fallback: 'claude-opus-4-8' };
const buf = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8');
const json = (r) => JSON.parse(r.body.toString('utf8'));

// ══ Blocking ════════════════════════════════════════════════════════════════
test('every Fable 5 id spelling is blocked, including ones that do not exist yet', () => {
  for (const id of [
    'claude-fable-5', 'claude-fable-5-20260101', 'fable-5', 'fable5', 'Fable-5',
    'CLAUDE-FABLE-5', 'claude_fable_5', 'fable-5-latest', 'claude-fable-5-thinking',
  ]) {
    assert.strictEqual(mp.isBlockedModel(id, false), true, id + ' must be blocked');
  }
});

test('no other Claude model is affected', () => {
  for (const id of [
    'claude-opus-4-8', 'claude-opus-4-8-20260101', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet', 'claude-opus-4-1', 'claude-3-opus',
  ]) {
    assert.strictEqual(mp.isBlockedModel(id, false), false, id + ' must NOT be blocked');
  }
});

// ══ Request enforcement — the part that cannot be bypassed ══════════════════
test('a completion request asking for Fable 5 is rewritten to the fallback', () => {
  const r = mp.applyToRequestBody(buf({ prompt: 'hi', model: 'claude-fable-5', timezone: 'UTC' }), OFF);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(json(r).model, 'claude-opus-4-8');
  assert.strictEqual(r.from, 'claude-fable-5');
  assert.strictEqual(json(r).prompt, 'hi', 'unrelated fields untouched');
  assert.strictEqual(json(r).timezone, 'UTC');
});

test('a request for any other model is passed through byte-identically', () => {
  const original = buf({ prompt: 'hi', model: 'claude-sonnet-5' });
  const r = mp.applyToRequestBody(original, OFF);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.body, original, 'same Buffer instance - no re-encode, no content-length churn');
});

test('nested and aliased model keys are caught (modified/handcrafted requests)', () => {
  const r = mp.applyToRequestBody(buf({
    settings: { preferred_model: 'fable-5' },
    conversation: { model_name: 'claude-fable-5' },
    tools: [{ target_model: 'fable5' }],
  }), OFF);
  const o = json(r);
  assert.strictEqual(o.settings.preferred_model, 'claude-opus-4-8');
  assert.strictEqual(o.conversation.model_name, 'claude-opus-4-8');
  assert.strictEqual(o.tools[0].target_model, 'claude-opus-4-8');
});

test('an existing Fable 5 conversation is switched on its next request', () => {
  // What the client replays when resuming a conversation already pinned to Fable 5.
  const r = mp.applyToRequestBody(buf({ conversation_uuid: 'abc-123', model: 'claude-fable-5', parent: null }), OFF);
  assert.strictEqual(json(r).model, 'claude-opus-4-8');
  assert.strictEqual(json(r).conversation_uuid, 'abc-123', 'the conversation itself is preserved');
});

test('account-level automatic model switching is forced off', () => {
  const r = mp.applyToRequestBody(buf({ model: 'claude-fable-5', auto_model_selection: true, smart_model_routing: true }), OFF);
  const o = json(r);
  assert.strictEqual(o.auto_model_selection, false);
  assert.strictEqual(o.smart_model_routing, false);
  assert.strictEqual(r.autoSwitchDisabled, true);
});

// ══ Never silently back to Fable ════════════════════════════════════════════
test('SECURITY: no input can make the policy EMIT a Fable 5 id', () => {
  const inputs = [
    { model: 'claude-fable-5' },
    { model: 'claude-opus-4-8' },
    { fallback_model: 'claude-fable-5' },
    { a: { b: { c: { model: 'fable5' } } } },
  ];
  for (const i of inputs) {
    const out = mp.applyToRequestBody(buf(i), OFF).body.toString('utf8');
    assert.ok(!/fable/i.test(out), 'output must never contain a fable id: ' + out);
  }
});

test('SECURITY: a misconfigured fallback pointing at Fable 5 is refused', () => {
  // Asserted against the module's own constant, not a literal: the DEFAULT is a policy decision
  // (Sonnet, to match the required Sonnet+Medium default pairing) and may be retuned, whereas the
  // invariant under test — a fallback naming the blocked family is always refused — must not be.
  assert.strictEqual(mp.normalizeFallback('claude-fable-5'), mp.DEFAULT_FALLBACK_MODEL);
  assert.strictEqual(mp.normalizeFallback(''), mp.DEFAULT_FALLBACK_MODEL);
  assert.strictEqual(mp.normalizeFallback(null), mp.DEFAULT_FALLBACK_MODEL);
  assert.ok(!/fable/i.test(mp.DEFAULT_FALLBACK_MODEL), 'the default fallback itself is never a blocked id');
  assert.strictEqual(mp.normalizeFallback('claude-sonnet-5'), 'claude-sonnet-5', 'a valid override still works');
});

test('SECURITY: the setting defaults to OFF (blocked) for unset/garbage values', () => {
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'maybe', 'FALSE ']) {
    assert.strictEqual(mp.parseAllowSetting(v), false, JSON.stringify(v) + ' must NOT allow Fable 5');
  }
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', true]) {
    assert.strictEqual(mp.parseAllowSetting(v), true, JSON.stringify(v) + ' must allow');
  }
});

// ══ Reversibility ═══════════════════════════════════════════════════════════
test('REVERSIBLE: with the setting On, nothing is touched at all', () => {
  const original = buf({ model: 'claude-fable-5', auto_model_selection: true });
  const r = mp.applyToRequestBody(original, ON);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.body, original);
  const resp = mp.applyToResponseBody(JSON.stringify({ models: [{ id: 'claude-fable-5' }] }), ON);
  assert.strictEqual(resp.changed, false);
  assert.strictEqual(mp.isBlockedModel('claude-fable-5', true), false);
});

// ══ Response filtering — the picker removal ════════════════════════════════
test('Fable 5 is dropped from the model list, other models kept in order', () => {
  const r = mp.applyToResponseBody(JSON.stringify({
    models: [
      { id: 'claude-opus-4-8', name: 'Opus 4.8' },
      { id: 'claude-fable-5', name: 'Fable 5' },
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
    ],
  }), OFF);
  assert.strictEqual(r.changed, true);
  const o = JSON.parse(r.text);
  assert.deepStrictEqual(o.models.map((m) => m.id), ['claude-opus-4-8', 'claude-sonnet-5']);
});

test('a conversation still naming Fable 5 renders as the fallback', () => {
  const r = mp.applyToResponseBody(JSON.stringify({ uuid: 'c1', model: 'claude-fable-5' }), OFF);
  assert.strictEqual(JSON.parse(r.text).model, 'claude-opus-4-8');
});

test('a response with no Fable 5 is returned untouched (identity)', () => {
  const text = JSON.stringify({ models: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }] });
  const r = mp.applyToResponseBody(text, OFF);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, text);
});

// ══ Fail-open / robustness — must never break Claude ═══════════════════════
test('malformed or non-JSON bodies are forwarded untouched, never dropped', () => {
  for (const bad of ['not json at all', '{"broken":', '', '<html>fable</html>']) {
    const r = mp.applyToRequestBody(Buffer.from(bad, 'utf8'), OFF);
    assert.strictEqual(r.changed, false, JSON.stringify(bad));
    const rr = mp.applyToResponseBody(bad, OFF);
    assert.strictEqual(rr.changed, false);
    assert.strictEqual(rr.text, bad);
  }
});

test('PERF: the byte pre-filter avoids parsing bodies that cannot contain it', () => {
  assert.strictEqual(mp.mayContainBlocked(Buffer.from('{"model":"claude-opus-4-8"}')), false);
  assert.strictEqual(mp.mayContainBlocked(Buffer.from('{"model":"claude-fable-5"}')), true);
  assert.strictEqual(mp.mayContainBlocked(Buffer.from('{"m":"CLAUDE-FABLE-5"}')), true, 'case-insensitive');
  assert.strictEqual(mp.mayContainBlocked(Buffer.alloc(0)), false);
  assert.strictEqual(mp.mayContainBlocked(Buffer.from('fabl')), false, 'no false positive on a prefix');
  // A large ordinary body must be cheap and must not match.
  assert.strictEqual(mp.mayContainBlocked(Buffer.from('x'.repeat(500000))), false);
});

test('the client-facing message is exactly the required wording', () => {
  assert.strictEqual(mp.BLOCKED_MESSAGE, 'Fable 5 is disabled by your administrator.');
});

'use strict';
/**
 * Unit tests for the Claude EFFORT allowlist (lib/effortPolicy.js).
 *
 * The policy: only Low and Medium may be used; High / Extra / Extra High / Very High / Max /
 * Maximum / Highest / Ultra are removed from the picker and rewritten to Medium on the way
 * upstream, where the block cannot be bypassed from the browser.
 *
 * The two properties that matter most, and are asserted repeatedly below:
 *   1. NO INPUT CAN PRODUCE A BLOCKED LEVEL AS OUTPUT.
 *   2. ANYTHING UNRECOGNISED IS LEFT EXACTLY AS IT WAS — we never break a chat to enforce a
 *      preference.
 */
const test = require('node:test');
const assert = require('node:assert');
const ep = require('./effortPolicy');

const buf = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const json = (r) => JSON.parse(r.body.toString('utf8'));

// ── Canonicalisation ────────────────────────────────────────────────────────
test('canonEffort: every spelling the picker has used maps to one level', () => {
  assert.equal(ep.canonEffort('Low'), 'low');
  assert.equal(ep.canonEffort('MEDIUM'), 'medium');
  assert.equal(ep.canonEffort('standard'), 'medium');
  assert.equal(ep.canonEffort('high'), 'high');
  // Separator and case tolerance: these are the same level however it is written.
  for (const v of ['extra high', 'extra_high', 'extra-high', 'ExtraHigh', 'very high', 'VERY_HIGH']) {
    assert.equal(ep.canonEffort(v), 'extra', v);
  }
  for (const v of ['max', 'Maximum', 'highest', 'ultra', 'MAXIMAL']) {
    assert.equal(ep.canonEffort(v), 'max', v);
  }
  // Not effort words → null, the "leave it alone" signal.
  for (const v of ['', null, undefined, 'turbo', 'sonnet', 'thinking', 42, {}]) {
    assert.equal(ep.canonEffort(v), null, String(v));
  }
});

test('allowlist membership: recognising is not permitting', () => {
  assert.deepEqual(ep.ALLOWED_EFFORTS, ['low', 'medium']);
  assert.equal(ep.isAllowedEffort('low'), true);
  assert.equal(ep.isAllowedEffort('Medium'), true);
  for (const v of ['high', 'extra', 'extra high', 'max', 'maximum', 'ultra', 'very-high']) {
    assert.equal(ep.isAllowedEffort(v), false, v);
    assert.equal(ep.isBlockedEffort(v), true, v);   // recognised, so it can be found and removed
  }
  // Unrecognised is neither allowed nor blocked — it is simply not ours to touch.
  assert.equal(ep.isAllowedEffort('turbo'), false);
  assert.equal(ep.isBlockedEffort('turbo'), false);
});

test('clampEffort normalises any stale value to a permitted level', () => {
  assert.equal(ep.clampEffort('low'), 'low');
  assert.equal(ep.clampEffort('medium'), 'medium');
  assert.equal(ep.clampEffort('extra high'), 'medium');   // the migration requirement
  assert.equal(ep.clampEffort('max'), 'medium');
  assert.equal(ep.clampEffort('nonsense'), 'medium');
  assert.equal(ep.clampEffort(null), 'medium');
  assert.equal(ep.clampEffort('nonsense', 'low'), 'low', 'a permitted fallback is honoured');
  assert.equal(ep.clampEffort('nonsense', 'max'), 'medium', 'a blocked fallback is refused');
});

// ── Request side: the authoritative, unbypassable block ─────────────────────
test('request: a blocked effort is rewritten to medium', () => {
  const r = ep.applyToRequestBody(buf({ prompt: 'hi', effort: 'high' }), {});
  assert.equal(r.changed, true);
  assert.equal(r.from, 'high');
  assert.equal(json(r).effort, 'medium');
  assert.equal(json(r).prompt, 'hi', 'nothing else is touched');
});

test('request: every blocked spelling and every effort field name is caught', () => {
  const body = {
    effort: 'max',
    reasoning_effort: 'extra high',
    thinking_effort: 'VERY_HIGH',
    paprika_mode: 'highest',
    settings: { output_effort: 'ultra', nested: { effort_level: 'high' } },
  };
  const out = json(ep.applyToRequestBody(buf(body), {}));
  const seen = JSON.stringify(out);
  assert.ok(!/high|extra|max|ultra|highest/i.test(seen), 'no blocked level survives anywhere: ' + seen);
  assert.equal(out.effort, 'medium');
  assert.equal(out.reasoning_effort, 'medium');
  assert.equal(out.thinking_effort, 'medium');
  assert.equal(out.paprika_mode, 'medium');
  assert.equal(out.settings.output_effort, 'medium');
  assert.equal(out.settings.nested.effort_level, 'medium');
});

test('request: permitted levels pass through completely untouched', () => {
  for (const v of ['low', 'medium', 'Low', 'standard']) {
    const original = buf({ effort: v });
    const r = ep.applyToRequestBody(original, {});
    assert.equal(r.changed, false, v);
    assert.strictEqual(r.body, original, v + ': the SAME buffer instance, so content-length is untouched');
  }
});

test('request: FAILS OPEN — an unrecognised vocabulary is never rewritten', () => {
  // Rewriting a value we do not understand could produce a request claude.ai rejects, breaking
  // chat in order to enforce a preference. Leaving it alone is the correct trade.
  const r = ep.applyToRequestBody(buf({ effort: 'turbo-9000' }), {});
  assert.equal(r.changed, false);
  assert.equal(json(r).effort, 'turbo-9000');
});

test('request: malformed / non-JSON / empty bodies are forwarded untouched', () => {
  for (const b of [Buffer.from('not json at all effort'), Buffer.alloc(0), Buffer.from('{"effort":')]) {
    const r = ep.applyToRequestBody(b, {});
    assert.equal(r.changed, false);
    assert.strictEqual(r.body, b);
  }
});

test('request: the user\'s own message text is never mistaken for a setting', () => {
  // "high" and "max" are ordinary English. Only EFFORT-NAMED FIELDS are considered.
  const body = { prompt: 'Explain why high tide is at its maximum, in extra detail.', effort: 'low' };
  const r = ep.applyToRequestBody(buf(body), {});
  assert.equal(r.changed, false);
  assert.equal(json(r).prompt, body.prompt, 'message text is byte-identical');
});

test('request: the kill-switch restores the original behaviour exactly', () => {
  const original = buf({ effort: 'max' });
  const r = ep.applyToRequestBody(original, { allowed: true });
  assert.equal(r.changed, false);
  assert.strictEqual(r.body, original);
});

// ── Response side: the picker removal ───────────────────────────────────────
test('response: blocked levels are dropped from the selectable list', () => {
  const text = JSON.stringify({
    effort_levels: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'extra_high', name: 'Extra High' },
      { id: 'max', name: 'Max' },
    ],
  });
  const r = ep.applyToResponseBody(text, {});
  assert.equal(r.changed, true);
  assert.equal(r.optionsRemoved, true);
  assert.deepEqual(JSON.parse(r.text).effort_levels.map((o) => o.id), ['low', 'medium']);
});

test('response: a list of bare strings is filtered the same way', () => {
  const r = ep.applyToResponseBody(JSON.stringify({ available_efforts: ['low', 'medium', 'high', 'max'] }), {});
  assert.deepEqual(JSON.parse(r.text).available_efforts, ['low', 'medium']);
});

test('response: a conversation SAVED at a blocked level reopens as medium', () => {
  // The "Opus Extra must reopen as Opus Medium" requirement.
  const text = JSON.stringify({ conversation: { model: 'claude-opus-5', effort: 'extra high' } });
  const r = ep.applyToResponseBody(text, {});
  assert.equal(r.changed, true);
  const o = JSON.parse(r.text);
  assert.equal(o.conversation.effort, 'medium');
  assert.equal(o.conversation.model, 'claude-opus-5', 'the MODEL is untouched — Opus stays selectable');
});

test('response: an upstream metadata refresh cannot restore the hidden options', () => {
  // The filter runs on every such response, so a later refresh is filtered identically.
  const text = JSON.stringify({ effort_options: ['low', 'medium', 'high', 'extra', 'max'] });
  const first = ep.applyToResponseBody(text, {});
  const second = ep.applyToResponseBody(first.text, {});
  assert.deepEqual(JSON.parse(first.text).effort_options, ['low', 'medium']);
  assert.equal(second.changed, false, 'already-clean output is stable (no oscillation)');
});

test('response: non-JSON and unrelated JSON are passed through untouched', () => {
  for (const t of ['<html>high max</html>', '{"models":["claude-opus-5"]}', 'null', '']) {
    const r = ep.applyToResponseBody(t, {});
    assert.equal(r.changed, false, t);
    assert.strictEqual(r.text, t, t);
  }
});

test('response: the kill-switch restores the original behaviour exactly', () => {
  const text = JSON.stringify({ effort_levels: ['low', 'high', 'max'] });
  const r = ep.applyToResponseBody(text, { allowed: true });
  assert.equal(r.changed, false);
  assert.strictEqual(r.text, text);
});

// ── Invariants ──────────────────────────────────────────────────────────────
test('INVARIANT: no input to either direction can yield a blocked level', () => {
  const inputs = ['low', 'medium', 'high', 'extra', 'extra high', 'very high', 'max', 'maximum', 'ultra', 'highest', 'garbage'];
  for (const v of inputs) {
    const out = ep.applyToRequestBody(buf({ effort: v }), {});
    const got = json(out).effort;
    // Either it was left alone because we do not recognise it, or it is now permitted.
    assert.ok(got === v || ep.isAllowedEffort(got), v + ' -> ' + got);
    assert.ok(!ep.isBlockedEffort(got), v + ' produced a BLOCKED output: ' + got);
  }
});

test('the default model is Sonnet and can never be a blocked family', () => {
  assert.equal(ep.DEFAULT_MODEL, 'claude-sonnet-5');
  assert.equal(ep.normalizeDefaultModel(''), 'claude-sonnet-5');
  assert.equal(ep.normalizeDefaultModel(null), 'claude-sonnet-5');
  assert.equal(ep.normalizeDefaultModel('claude-fable-5'), 'claude-sonnet-5', 'a fable override is refused');
  assert.equal(ep.normalizeDefaultModel('claude-opus-5'), 'claude-opus-5', 'a valid override still works');
});

test('parseAllowSetting: blocked by default; only an explicit truthy value opens it', () => {
  for (const v of [undefined, null, '', '0', 'false', 'off', 'nonsense']) assert.equal(ep.parseAllowSetting(v), false, String(v));
  for (const v of [true, '1', 'true', 'ON', 'yes']) assert.equal(ep.parseAllowSetting(v), true, String(v));
});

'use strict';
/**
 * THE ORCHESTRATOR-ACCESSOR TRANSFORMATION, as a pure function on source text.
 *
 * WHY THIS IS ITS OWN MODULE. The first release of this patch was applied by three string
 * operations inline in scripts/patch-live-extension.mjs, and the third one was wrong:
 *
 *     bg = bg.replace(DECL, ACCESSOR);                                    // inserts the accessor
 *     bg = bg.split(CALL).join('await requireOrchestrator().executeLogin(');
 *     bg = bg.replace('orchestrator = getOrchestrator();', 'requireOrchestrator();');
 *
 * `String.prototype.replace` with a string pattern replaces the FIRST occurrence. By that point the
 * first occurrence was no longer the assignment inside initialize() — it was the line the patcher
 * had just inserted into its own accessor, which sits at the top of the file where
 * `let orchestrator = null;` is declared. So the shipped accessor became:
 *
 *     function requireOrchestrator() {
 *       if (!orchestrator) requireOrchestrator();   // ← calls itself
 *       return orchestrator;
 *     }
 *
 * and initialize() kept its original assignment. A warm worker therefore worked perfectly, while a
 * cold message-driven wake — the exact case the patch existed to fix — recursed until the stack
 * gave out: "Maximum call stack size exceeded", with the singleton factory never called once.
 *
 * Every structural check the patcher ran still passed, because not one of them executed the
 * accessor: the function was present, no bare call site remained, and every call site went through
 * it. That is the lesson encoded here — a transformation of this kind is verified by RUNNING its
 * output, and releasePatchTransform.test.js does exactly that against this module.
 *
 * So the transformation now lives in one place, is scoped by index rather than by first match, and
 * refuses anything it does not recognise instead of guessing. It is imported by the patcher that
 * builds the release and by the test that executes the result, so the two cannot drift.
 */

export const DECL = 'let orchestrator = null;';
export const ASSIGN = 'orchestrator = getOrchestrator();';
export const CALL = 'await orchestrator.executeLogin(';
export const ACCESSOR_CALL = 'await requireOrchestrator().executeLogin(';
export const ACCESSOR_NAME = 'requireOrchestrator';

export const ACCESSOR_BODY = `/**
 * The login orchestrator, guaranteed present on EVERY service-worker wake.
 *
 * Chrome terminates an idle MV3 worker and wakes it to deliver a MESSAGE — a wake that fires
 * neither chrome.runtime.onInstalled nor chrome.runtime.onStartup, the only two events that ran
 * initialize() and therefore the only two that assigned this variable. Clicking Access after an
 * idle period then produced:
 *
 *     Could not open tool: Cannot read properties of null (reading 'executeLogin')
 *
 * getOrchestrator() is a synchronous, side-effect-free singleton factory, so readiness is free and
 * must not drag the rest of initialize() along: no cleanup sync, no alarm re-arming, no bridge
 * re-injection, no re-pairing on an Access click. No optional chaining, no fabricated success and
 * no keep-alive either — the worker may sleep, and the dependency is rebuilt when it wakes.
 */
function ${ACCESSOR_NAME}() {
  if (!orchestrator) ${ASSIGN}
  return orchestrator;
}`;

/** Strip comment-only lines so a doc comment can never satisfy a code assertion. */
export const codeOf = (s) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

class PatchError extends Error {}
const fail = (msg) => { throw new PatchError(msg); };

/**
 * Find the accessor function and return its exact source range.
 * Brace matching skips strings and comments so a brace inside either cannot end the body early.
 */
export function findAccessor(src) {
  const decl = new RegExp(`function\\s+${ACCESSOR_NAME}\\s*\\(`).exec(src);
  if (!decl) return null;
  const open = src.indexOf('{', decl.index);
  if (open < 0) return null;
  let depth = 0, i = open, q = null, line = false, block = false;
  for (; i < src.length; i += 1) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i += 1; } continue; }
    if (q) { if (c === '\\') { i += 1; continue; } if (c === q) q = null; continue; }
    if (c === '/' && n === '/') { line = true; i += 1; continue; }
    if (c === '/' && n === '*') { block = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  if (depth !== 0) return null;
  return { start: decl.index, end: i, text: src.slice(decl.index, i) };
}

/**
 * What state is this source in? "accessor exists" is NOT a health check — the broken 3.9.36
 * release has an accessor, and it is the thing that crashes. These three states are distinct and
 * must be treated differently: absent needs the patch, recursive needs repair, correct needs
 * nothing at all.
 */
export function classify(src) {
  const found = findAccessor(src);
  if (!found) return { state: 'absent' };
  const body = codeOf(found.text);
  const selfCalls = (body.match(new RegExp(`${ACCESSOR_NAME}\\s*\\(`, 'g')) || []).length - 1; // minus its own declaration
  if (selfCalls > 0) return { state: 'recursive', selfCalls, accessor: found };
  if (!body.includes('getOrchestrator()')) return { state: 'unknown', accessor: found };
  return { state: 'correct', accessor: found };
}

/** Replace every occurrence of `needle` that lies OUTSIDE [start,end), asserting the count. */
function replaceOutside(src, needle, replacement, range, expected) {
  const parts = [];
  let i = 0, hits = 0;
  for (;;) {
    const at = src.indexOf(needle, i);
    if (at < 0) { parts.push(src.slice(i)); break; }
    const inside = range && at >= range.start && at < range.end;
    parts.push(src.slice(i, at));
    if (inside) parts.push(needle);
    else { parts.push(replacement); hits += 1; }
    i = at + needle.length;
  }
  if (expected !== undefined && hits !== expected) {
    fail(`expected ${expected} occurrence(s) of \`${needle}\` outside the accessor, found ${hits}`);
  }
  return { code: parts.join(''), hits };
}

/**
 * Apply (or repair) the accessor. Returns the new source, the number of call sites routed through
 * it, and which action was taken. Refuses rather than guessing on anything unrecognised.
 */
export function patch(src) {
  const before = classify(src);
  if (before.state === 'unknown') fail('an accessor is present but calls neither itself nor getOrchestrator() — refusing to touch it');
  if (before.state === 'correct') return { code: src, callSites: countAccessorCalls(src), action: 'none' };

  let code = src;
  let action;

  if (before.state === 'recursive') {
    // REPAIR the already-shipped broken accessor. Scoped to the accessor's own range: the one
    // self-call inside it becomes the real assignment, and nothing outside it is touched.
    action = 'repair';
    const { start, end, text } = before.accessor;
    const selfCall = new RegExp(`(if\\s*\\(!orchestrator\\)\\s*)${ACCESSOR_NAME}\\s*\\(\\s*\\)\\s*;`);
    if (!selfCall.test(text)) fail('the recursive accessor does not have the expected shape — refusing to repair it blindly');
    const repaired = text.replace(selfCall, `$1${ASSIGN}`);
    code = code.slice(0, start) + repaired + code.slice(end);
    // The broken release never rewrote initialize() either — its first-match replace had already
    // been consumed by the accessor it had just inserted. Route it through the accessor now, scoped
    // to everything OUTSIDE the accessor's own (recomputed) range so the repair cannot undo itself.
    const after = classify(code);
    if (after.state !== 'correct') fail(`repair did not produce a correct accessor (got "${after.state}")`);
    const moved = replaceOutside(code, ASSIGN, `${ACCESSOR_NAME}();`, after.accessor);
    if (moved.hits > 1) fail(`expected at most 1 assignment outside the accessor, found ${moved.hits}`);
    code = moved.code;
  } else {
    // FRESH patch. Do the initialize() rewrite FIRST, while there is exactly one occurrence of the
    // assignment in the file — this is the ordering defect that produced the recursive release.
    action = 'insert';
    if (!code.includes(DECL)) fail(`the source does not declare \`${DECL}\` — its shape has changed`);
    const occurrences = code.split(ASSIGN).length - 1;
    if (occurrences !== 1) fail(`expected exactly 1 occurrence of \`${ASSIGN}\` before patching, found ${occurrences}`);
    code = replaceOutside(code, ASSIGN, `${ACCESSOR_NAME}();`, null, 1).code;
    // Only now insert the accessor, whose body legitimately contains that same assignment.
    const declAt = code.indexOf(DECL);
    if (declAt < 0) fail('the declaration disappeared while patching');
    code = code.slice(0, declAt) + `${DECL}\n\n${ACCESSOR_BODY}` + code.slice(declAt + DECL.length);
  }

  // Route every bare call site through the accessor (idempotent — a repair has none left).
  const bare = codeOf(code).split(CALL).length - 1;
  if (bare > 0) code = code.split(CALL).join(ACCESSOR_CALL);

  const callSites = countAccessorCalls(code);
  verify(code, { callSites });
  return { code, callSites, action, repaired: before.state === 'recursive' };
}

export const countAccessorCalls = (src) =>
  (codeOf(src).match(new RegExp(`${ACCESSOR_NAME}\\(\\)\\.executeLogin\\(`, 'g')) || []).length;

/**
 * Structural post-conditions. Necessary but NOT sufficient — the original release passed every
 * check of this kind while being unrunnable. The executable proof is in the test suite.
 */
export function verify(src, { callSites } = {}) {
  const code = codeOf(src);
  const state = classify(src);
  if (state.state !== 'correct') fail(`post-condition: accessor state is "${state.state}", expected "correct"`);
  if (/(?<!require)[Oo]rchestrator\.executeLogin\(/.test(code)) fail('post-condition: a bare call site survived');
  if (callSites !== undefined && countAccessorCalls(src) !== callSites) {
    fail('post-condition: not every call site is routed through the accessor');
  }
  const body = codeOf(state.accessor.text);
  if (!body.includes(ASSIGN)) fail('post-condition: the accessor does not assign the singleton');
  // classify() already proved state === 'correct', i.e. zero self-calls; assert it directly too,
  // because this is the single property whose absence shipped a package that could not run.
  if (new RegExp(`${ACCESSOR_NAME}\\s*\\(`).test(body.replace(new RegExp(`function\\s+${ACCESSOR_NAME}\\s*\\(`), ''))) {
    fail('post-condition: the accessor calls itself');
  }
  // initialize() must reach the singleton through the one accessor so the two paths cannot drift.
  // These offsets index the ORIGINAL source, so the slice is taken from src and stripped after.
  const outside = codeOf(src.slice(0, state.accessor.start) + src.slice(state.accessor.end));
  if (outside.includes(ASSIGN)) fail('post-condition: an assignment outside the accessor still bypasses it');
  return true;
}

export { PatchError };

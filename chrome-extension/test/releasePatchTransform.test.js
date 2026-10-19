'use strict';
/**
 * THE RELEASE TRANSFORMATION, PROVED BY RUNNING ITS OUTPUT.
 *
 * v3.9.36 shipped an accessor that called itself:
 *
 *     function requireOrchestrator() {
 *       if (!orchestrator) requireOrchestrator();
 *       return orchestrator;
 *     }
 *
 * because the patcher's third operation — a first-match `String.replace` of
 * `orchestrator = getOrchestrator();` — landed on the line it had just inserted into its own
 * accessor instead of on the assignment inside initialize(). A warm worker was unaffected;
 * a cold, message-driven wake recursed until the stack gave out, and the singleton factory was
 * never called once.
 *
 * Every structural check passed: the accessor existed, no bare call site remained, and every call
 * site was routed through it. None of them ran the code. So this suite imports the REAL
 * transformation from scripts/lib/orchestratorAccessor.mjs — the same module the release patcher
 * uses, so the two cannot drift — applies it, and then EXECUTES the result: first call, repeated
 * calls, warm initialization, independent worker wakes, concurrent Access and a failing factory.
 *
 * Execution uses a synthetic package shaped like the live background.js, because the real one
 * cannot be imported outside a service worker. The real packaged bytes are covered separately:
 * classify() asserts their state here, and workerWakeOrchestrator.test.js drives their actual
 * message handler with EXT_DIR pointed at the downloaded ZIP.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib', 'orchestratorAccessor.mjs');
const load = () => import(LIB);

// A package shaped like the live background.js: the null declaration at the top, the assignment
// buried inside initialize() far below it, and several bare call sites in the message handler.
const SYNTHETIC = `let orchestrator = null;
let isInitialized = false;

async function initialize() {
  orchestrator = getOrchestrator();
  isInitialized = true;
}

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);

async function onMessage(msg) {
  if (msg.type === 'OPEN_TOOL') {
    return await orchestrator.executeLogin(msg.tool);
  }
  if (msg.type === 'OPEN_TOOL_RETRY') {
    return await orchestrator.executeLogin(msg.tool);
  }
  if (msg.type === 'REAUTH') {
    return await orchestrator.executeLogin(msg.tool);
  }
  return await orchestrator.executeLogin(msg.tool);
}
`;

// Exactly what v3.9.36 shipped, produced by the old three-operation sequence.
const BROKEN_3_9_36 = `let orchestrator = null;

function requireOrchestrator() {
  if (!orchestrator) requireOrchestrator();
  return orchestrator;
}
let isInitialized = false;

async function initialize() {
  orchestrator = getOrchestrator();
  isInitialized = true;
}

async function onMessage(msg) {
  return await requireOrchestrator().executeLogin(msg.tool);
}
`;

/**
 * Import the patched source as an independent service-worker runtime. Each call is a separate
 * module instance — a fresh worker wake — with a counting factory injected around it.
 */
let wakeSeq = 0;
async function spinUp(patchedBody, { factoryThrows = false } = {}) {
  wakeSeq += 1;
  const src = `// worker wake ${wakeSeq}
let factoryCalls = 0;
const chrome = { runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } } };
function getOrchestrator() {
  factoryCalls += 1;
  if (${factoryThrows}) throw new Error('orchestrator_factory_failed');
  return { executeLogin: async (tool) => 'opened:' + tool };
}
${patchedBody}
export { onMessage, initialize };
export const factoryCallCount = () => factoryCalls;
`;
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  return import(url);
}

const coldAccess = async (mod, tool = 'writehuman') => mod.onMessage({ type: 'OPEN_TOOL', tool });

// ── A. the broken release is recognised as broken ────────────────────────────────────────────
test('the shipped v3.9.36 accessor is classified recursive, NOT "already fixed"', async () => {
  const { classify } = await load();
  const c = classify(BROKEN_3_9_36);
  assert.equal(c.state, 'recursive');
  assert.equal(c.selfCalls, 1);
  // The old health check was `if (/function requireOrchestrator\(/.test(bg)) die('ALREADY fixed')`.
  // It would have refused to repair the very package that crashes.
  assert.match(BROKEN_3_9_36, /function requireOrchestrator\(/);
});

test('the shipped v3.9.36 accessor actually overflows the stack on a cold wake', async () => {
  const mod = await spinUp(BROKEN_3_9_36);
  await assert.rejects(() => coldAccess(mod), (e) => e instanceof RangeError && /call stack/i.test(e.message));
  assert.equal(mod.factoryCallCount(), 0, 'the singleton factory is never reached');
});

test('the shipped v3.9.36 accessor works WARM — which is why this was missed', async () => {
  const mod = await spinUp(BROKEN_3_9_36);
  await mod.initialize();
  assert.equal(await coldAccess(mod), 'opened:writehuman');
  assert.equal(mod.factoryCallCount(), 1);
});

// ── B. the corrected transformation, executed ────────────────────────────────────────────────
test('a cold message wake opens the tool and calls the factory exactly once', async () => {
  const { patch } = await load();
  const { code, callSites, action } = patch(SYNTHETIC);
  assert.equal(action, 'insert');
  assert.equal(callSites, 4);
  const mod = await spinUp(code);
  assert.equal(await coldAccess(mod), 'opened:writehuman');
  assert.equal(mod.factoryCallCount(), 1);
});

test('repeated Access on one runtime reuses the singleton — one factory call in total', async () => {
  const { patch } = await load();
  const mod = await spinUp(patch(SYNTHETIC).code);
  for (let i = 0; i < 5; i += 1) assert.equal(await coldAccess(mod, 't' + i), 'opened:t' + i);
  assert.equal(mod.factoryCallCount(), 1);
});

test('warm initialization goes through the same accessor and does not double-build', async () => {
  const { patch } = await load();
  const mod = await spinUp(patch(SYNTHETIC).code);
  await mod.initialize();
  assert.equal(mod.factoryCallCount(), 1);
  assert.equal(await coldAccess(mod), 'opened:writehuman');
  assert.equal(mod.factoryCallCount(), 1, 'initialize() and Access must share one singleton');
});

test('each independent worker wake builds its own singleton exactly once', async () => {
  const { patch } = await load();
  const { code } = patch(SYNTHETIC);
  for (let wake = 0; wake < 3; wake += 1) {
    const mod = await spinUp(code);
    assert.equal(mod.factoryCallCount(), 0, 'nothing is built until something asks');
    assert.equal(await coldAccess(mod), 'opened:writehuman');
    assert.equal(mod.factoryCallCount(), 1);
  }
});

test('concurrent Access clicks on a cold worker build the singleton once', async () => {
  const { patch } = await load();
  const mod = await spinUp(patch(SYNTHETIC).code);
  const results = await Promise.all(['a', 'b', 'c', 'd'].map((t) => coldAccess(mod, t)));
  assert.deepEqual(results, ['opened:a', 'opened:b', 'opened:c', 'opened:d']);
  assert.equal(mod.factoryCallCount(), 1);
});

test('a failing factory propagates its real error — not a stack overflow, not a fake success', async () => {
  const { patch } = await load();
  const mod = await spinUp(patch(SYNTHETIC).code, { factoryThrows: true });
  await assert.rejects(() => coldAccess(mod), (e) => {
    assert.ok(!(e instanceof RangeError), 'must not degenerate into recursion');
    assert.match(e.message, /orchestrator_factory_failed/);
    return true;
  });
  assert.equal(mod.factoryCallCount(), 1, 'it tried once and surfaced the failure');
});

// ── C. the repair path: 3.9.36 → correct, without reverting the cold-wake fix ────────────────
test('patch() REPAIRS the recursive release instead of refusing it', async () => {
  const { patch, classify } = await load();
  const { code, action, repaired } = patch(BROKEN_3_9_36);
  assert.equal(action, 'repair');
  assert.equal(repaired, true);
  assert.equal(classify(code).state, 'correct');
  const mod = await spinUp(code);
  assert.equal(await coldAccess(mod), 'opened:writehuman', 'the cold wake the patch exists for now works');
  assert.equal(mod.factoryCallCount(), 1);
});

test('the repair keeps the cold-wake fix rather than reverting to the null-crash release', async () => {
  const { patch } = await load();
  const { code } = patch(BROKEN_3_9_36);
  assert.match(code, /function requireOrchestrator\(/, 'the accessor is still there');
  assert.doesNotMatch(code, /(?<!require)\borchestrator\.executeLogin\(/, 'no bare call site returns');
});

test('the repaired initialize() reaches the singleton through the accessor', async () => {
  const { patch } = await load();
  const { code } = patch(BROKEN_3_9_36);
  const init = code.slice(code.indexOf('async function initialize'));
  assert.match(init, /requireOrchestrator\(\);/);
  assert.doesNotMatch(init.split('}')[0], /orchestrator = getOrchestrator\(\);/);
});

// ── D. the accessor never calls itself, by text and by execution ─────────────────────────────
test('the generated accessor assigns the singleton and never calls itself', async () => {
  const { patch, findAccessor, codeOf } = await load();
  for (const input of [SYNTHETIC, BROKEN_3_9_36]) {
    const { code } = patch(input);
    const body = codeOf(findAccessor(code).text);
    assert.match(body, /orchestrator = getOrchestrator\(\);/);
    const selfCalls = (body.match(/requireOrchestrator\s*\(/g) || []).length - 1;
    assert.equal(selfCalls, 0, 'the accessor body must contain no call to itself');
  }
});

// ── E. the transformation refuses what it does not recognise ─────────────────────────────────
test('patch() is idempotent — a correct package is left exactly as it is', async () => {
  const { patch } = await load();
  const once = patch(SYNTHETIC).code;
  const twice = patch(once);
  assert.equal(twice.action, 'none');
  assert.equal(twice.code, once);
});

test('patch() refuses a source whose declaration has changed shape', async () => {
  const { patch } = await load();
  assert.throws(() => patch('let orchestrator;\nasync function initialize() { orchestrator = getOrchestrator(); }\n'),
    /does not declare/);
});

test('patch() refuses when the assignment does not occur exactly once', async () => {
  const { patch } = await load();
  const twoAssignments = SYNTHETIC.replace('isInitialized = true;', 'orchestrator = getOrchestrator();');
  assert.throws(() => patch(twoAssignments), /expected exactly 1 occurrence/);
  assert.throws(() => patch(SYNTHETIC.replace('  orchestrator = getOrchestrator();\n', '')), /expected exactly 1 occurrence/);
});

test('patch() refuses an accessor that does neither the right nor the recursive thing', async () => {
  const { patch } = await load();
  const weird = 'let orchestrator = null;\nfunction requireOrchestrator() { return null; }\n';
  assert.throws(() => patch(weird), /refusing to touch it/);
});

// ── F. the repository source tree must stay in the correct state ─────────────────────────────
test('the repository background.js carries a correct, non-recursive accessor', async () => {
  const { classify, countAccessorCalls } = await load();
  const bg = fs.readFileSync(path.join(__dirname, '..', 'js', 'background.js'), 'utf8');
  const c = classify(bg);
  assert.equal(c.state, 'correct', 'the source tree must never regress into the shipped defect');
  assert.ok(countAccessorCalls(bg) >= 1, 'call sites are routed through the accessor');
});

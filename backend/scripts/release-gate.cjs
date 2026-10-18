#!/usr/bin/env node
'use strict';
/**
 * THE RELEASE GATE RUNNER.
 *
 * Runs the artifact-dependent suites with WH_RELEASE_GATE=1, which turns "no candidate installer"
 * from an explicit skip (correct in PR CI, where dist/ is gitignored) into a FAILURE (correct when
 * cutting a release). It exits with a non-zero status unless every required suite actually ran and
 * actually passed.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, AND AN EARLIER VERSION GOT BOTH WRONG.
 *
 * 1. A SANITISED CHILD ENVIRONMENT. node:test sets NODE_TEST_CONTEXT for every file it runs. A
 *    nested `node --test` that INHERITS it believes it is a reporting child of an outer run,
 *    skips execution entirely, and exits 0. Measured on node v24.14.1 against this gate with no
 *    installer and no latest.json present:
 *
 *        clean environment                 -> exit 1, no verdict printed
 *        NODE_TEST_CONTEXT=child-v8        -> exit 0, "candidate verified", NO test summary
 *
 *    So a release cut from any context that had already run node:test — a test harness, a
 *    wrapper script, an IDE task runner, a CI job that runs tests before deploying — would have
 *    been told the candidate was verified while nothing was verified at all. The variable is
 *    stripped from the child environment here, in the runner, not merely in the tests that
 *    exercise it. Everything else in the environment is passed through untouched, because the
 *    suites legitimately need the repo's runtime configuration.
 *
 * 2. PROOF OF EXECUTION, NOT JUST A ZERO STATUS. An exit code alone cannot distinguish "all
 *    assertions passed" from "nothing ran". Each suite is therefore run on its own and its TAP
 *    summary is parsed: the run must report at least one test, zero failures, and — in gate mode —
 *    zero skips, because a skipped artifact assertion IS the hole this gate exists to close. A
 *    missing summary is treated as a suite that did not execute, and fails.
 *
 * Exit codes: 0 = every required suite ran and passed. Non-zero = do not publish.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  'tests/writehumanAgentVersionDrift.test.js',
  'tests/writehumanInstallerEmbeddedSource.test.js',
];

const BACKEND = path.join(__dirname, '..');

/**
 * Variables that make a nested `node --test` believe it is a child reporter of an outer run.
 * Stripping them is what makes the child actually execute its tests.
 */
const TEST_CONTEXT_VARS = ['NODE_TEST_CONTEXT'];

function childEnv() {
  const env = { ...process.env, WH_RELEASE_GATE: '1' };
  for (const v of TEST_CONTEXT_VARS) delete env[v];
  return env;
}

/** Parse `# tests N` / `# pass N` / `# fail N` / `# skipped N` out of a TAP run. */
function summarise(output) {
  const num = (key) => {
    const m = output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'));
    return m ? Number(m[1]) : null;
  };
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
}

const failures = [];

for (const suite of SUITES) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: childEnv(),
  });

  const output = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(output);

  if (r.error) { failures.push(`${suite}: could not run (${r.error.message})`); continue; }
  if (r.signal) { failures.push(`${suite}: terminated by signal ${r.signal}`); continue; }

  const s = summarise(output);
  if (s.tests === null) {
    failures.push(`${suite}: produced no TAP summary — the suite did not execute. A required suite `
      + 'that does not run must never read as a pass.');
    continue;
  }
  if (s.tests < 1) { failures.push(`${suite}: reported 0 tests — nothing was verified`); continue; }
  if (s.fail) { failures.push(`${suite}: ${s.fail} failing test(s)`); continue; }
  if (s.skipped) {
    failures.push(`${suite}: ${s.skipped} skipped test(s). Under the release gate a skipped `
      + 'artifact assertion is the hole this gate exists to close, not an acceptable result.');
    continue;
  }
  if (r.status !== 0) { failures.push(`${suite}: exited ${r.status} despite a clean summary`); continue; }
  console.log(`[release-gate] ${suite}: ${s.pass}/${s.tests} passed`);
}

if (failures.length) {
  console.error('\n[release-gate] FAILED — this tree must not be published:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[release-gate] candidate verified: the installer carries this tree’s agent source.');

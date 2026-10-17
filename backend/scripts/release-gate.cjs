#!/usr/bin/env node
'use strict';
/**
 * THE RELEASE GATE RUNNER.
 *
 * Runs the artifact-dependent suites with WH_RELEASE_GATE=1, which turns "no candidate installer"
 * from an explicit skip (correct in PR CI, where dist/ is gitignored) into a FAILURE (correct when
 * cutting a release). It then exits with the child's status so any caller — a shell deploy script,
 * CI, or a human — can rely on `&&`.
 *
 * WHY A RUNNER AND NOT AN ENV PREFIX IN package.json. `WH_RELEASE_GATE=1 node --test …` is not
 * portable: cmd.exe treats it as a command, not an assignment, so the gate would silently run in
 * skip mode on a Windows working copy — the one platform the agent is actually built on. Setting
 * the variable in JS keeps the behaviour identical everywhere.
 *
 * Exit codes: 0 = candidate verified. Non-zero = do not publish.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  'tests/writehumanAgentVersionDrift.test.js',
  'tests/writehumanInstallerEmbeddedSource.test.js',
];

const backend = path.join(__dirname, '..');
const r = spawnSync(process.execPath, ['--test', ...SUITES], {
  cwd: backend,
  stdio: 'inherit',
  env: { ...process.env, WH_RELEASE_GATE: '1' },
});

if (r.error) {
  console.error('[release-gate] could not run the gate:', r.error.message);
  process.exit(1);
}
if (r.signal) {
  console.error(`[release-gate] gate terminated by signal ${r.signal}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('\n[release-gate] FAILED — this tree must not be published.');
  process.exit(r.status === null ? 1 : r.status);
}
console.log('\n[release-gate] candidate verified: the installer carries this tree’s agent source.');

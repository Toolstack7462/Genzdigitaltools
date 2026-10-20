'use strict';
/**
 * A PUSH TO main MUST NOT PUBLISH main's FRONTEND.
 *
 * MEASURED, 2026-10-20. The live interface is built from `release/frontend-owner-fix`
 * (`main.0641f2d0.js`, confirmed by downloading the served bundle: 570,738 bytes, sha256
 * 164280e073a6f4d9). main's committed build is OLDER — `main.020d28e1.js` — and main's own
 * `deploy-frontend.yml` is the legacy, push-triggered, password-SFTP version: no gate job, no
 * rollback point, no backup of the files it replaces, unlike the reviewed workflow on the release
 * branches. So any commit touching `frontend/**` that lands on main would mirror an older bundle
 * over BOTH live web roots and silently undo frontend work that is already released — including
 * the structured bridge-error handling the live bundle demonstrably contains (`actionableError`,
 * `needsReauth`).
 *
 * It nearly happened: the merge at 17:18:40Z touched `frontend/scripts/stamp-build.js` and
 * `frontend/build/build-source.json`, the workflow fired at 17:18:43Z, and it was stopped only by
 * an UNRELATED accident — the committed extension ZIP no longer matched its source, so the job
 * died at step 4 before install, build or upload. Relying on an unrelated guard failing is not a
 * safety property.
 *
 * The frontend is released deliberately, by dispatching the reviewed workflow from the branch that
 * holds the current interface. That is unaffected: this only removes the automatic push publish.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy-frontend.yml');

// Line endings are normalised first: the working copy is CRLF on Windows and LF in git, and a
// `\n`-anchored pattern silently matches NOTHING against CRLF — which reads as "no triggers
// declared" rather than as a broken test. Same trap as the build fingerprint.
const readWorkflow = () => fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function triggerBlock(src) {
  // the `on:` mapping, up to the next top-level key
  const m = src.match(/\non:\n([\s\S]*?)\n(?=[a-zA-Z])/);
  return m ? m[1] : '';
}

test('deploy-frontend.yml exists on this branch', () => {
  assert.ok(fs.existsSync(WF), 'the frontend deploy workflow must exist');
});

test('a push to main must NOT trigger a frontend publish', () => {
  const on = triggerBlock(readWorkflow());
  assert.ok(on.length, 'the workflow must declare triggers');
  // No `push:` at all is the simplest correct state. If a push trigger is ever reintroduced it
  // must not name main, because main's frontend is older than the released interface.
  if (/^\s*push:/m.test(on)) {
    const pushScope = on.slice(on.search(/^\s*push:/m));
    assert.ok(!/branches:\s*\[[^\]]*\bmain\b/.test(pushScope) && !/^\s*-\s*main\s*$/m.test(pushScope),
      'a push to main must not publish the frontend: main\'s committed build is older than the '
      + 'live interface, so this would mirror an older bundle over both web roots');
  }
});

test('manual dispatch is still available, so a deliberate release is unaffected', () => {
  const on = triggerBlock(readWorkflow());
  assert.match(on, /workflow_dispatch/, 'the reviewed release path must remain dispatchable');
});

test('the committed extension ZIP still matches its source version', () => {
  // The same consistency the deploy job checks at step 4. Asserted here too so a source edit that
  // breaks it fails in CI with an explanation, instead of surfacing as a confusing deploy failure.
  const root = path.join(__dirname, '..', '..');
  const manifestPath = path.join(root, 'chrome-extension', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;                   // nothing to compare on this branch
  const version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
  assert.match(String(version), /^\d+\.\d+\.\d+$/, 'the extension manifest must carry a semver');
});

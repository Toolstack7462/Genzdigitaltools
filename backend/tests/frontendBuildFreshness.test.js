'use strict';
/**
 * The committed frontend build must correspond to the committed frontend source.
 *
 * This repo deploys the tracked `frontend/build/` directory as-is, so the compiled bundle is a
 * committed artifact. That allows a failure with no visible symptom at the point it happens: edit
 * `frontend/src`, commit, deploy — and serve the OLD bundle, because nothing rebuilt it. The UI
 * silently lags the source, and every symptom points somewhere else. It is the same class of
 * mistake as the deploy manifest: an artifact that must be kept in step by hand, and therefore
 * eventually is not.
 *
 * `frontend/scripts/stamp-build.js` records a SHA-256 of every build input into
 * `build/build-source.json` as a postbuild step. This recomputes it and fails when they diverge,
 * so "you changed the UI but did not rebuild" is caught before it can be deployed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');
const BUILD = path.join(FRONTEND, 'build');
const STAMP = path.join(BUILD, 'build-source.json');

const { fingerprint } = require(path.join(FRONTEND, 'scripts', 'stamp-build.js'));

test('the committed build carries a source fingerprint', () => {
  assert.ok(fs.existsSync(BUILD), 'frontend/build must exist — it is what gets deployed');
  assert.ok(fs.existsSync(STAMP),
    'frontend/build/build-source.json is missing. Run `npm run build` in frontend/ (the postbuild ' +
    'step writes it), then commit the build.');
});

test('the committed build was produced from the committed source', () => {
  if (!fs.existsSync(STAMP)) return;               // reported by the test above
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  const current = fingerprint();
  assert.strictEqual(current.fingerprint, stamp.sourceFingerprint,
    'frontend/src has changed since the committed build was made, so deploying would ship the OLD ' +
    'compiled bundle with the NEW source. Run `npm run build` in frontend/ and commit the result. ' +
    `(build was made from ${String(stamp.sourceFingerprint).slice(0, 12)}…, source is now ` +
    `${current.fingerprint.slice(0, 12)}…, ${current.fileCount} input files)`);
});

test('the build index references the bundle the stamp recorded', () => {
  if (!fs.existsSync(STAMP)) return;
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  const html = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8');
  if (!stamp.mainBundle) return;                   // older stamp without the field
  assert.ok(html.includes(stamp.mainBundle),
    `index.html does not reference ${stamp.mainBundle} — the build directory is internally ` +
    'inconsistent (a partial or interrupted build).');
  assert.ok(fs.existsSync(path.join(BUILD, 'static', 'js', stamp.mainBundle)),
    `the referenced bundle ${stamp.mainBundle} is missing from build/static/js`);
});

test('the fingerprint is stable across repeated computation', () => {
  // Guard for the guard: a fingerprint that varies by itself would make the check meaningless
  // noise, and a noisy check gets deleted.
  assert.strictEqual(fingerprint().fingerprint, fingerprint().fingerprint);
});

test('the build carries the production API base, not a relative fallback', () => {
  // A build made without frontend/.env.production falls back to a relative /api/crm and 404s every
  // login against the app subdomain. This has shipped before; it is cheap to assert here.
  if (!fs.existsSync(STAMP)) return;
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  if (!stamp.mainBundle) return;
  const bundle = fs.readFileSync(path.join(BUILD, 'static', 'js', stamp.mainBundle), 'utf8');
  assert.ok(bundle.includes('https://api.genzdigitalstore.com'),
    'the built bundle does not contain the production API base — it was built without ' +
    'frontend/.env.production and would 404 on login.');
});

'use strict';
/**
 * The backend deploy manifest must ship every proxy util that deployed code requires.
 *
 * WHY THIS TEST EXISTS. `deploy-hostinger.sh` uploads an EXPLICIT list of backend files. If a route
 * that IS in the list gains a `require()` on a new local module that is NOT, every test still
 * passes locally and Passenger then boots the API into "Cannot find module" — taking down the whole
 * API (login, every tool), not just the feature that changed.
 *
 * It has happened repeatedly:
 *   • `middleware/rateLimiter.js` was missing while `routes/proxy/gateway.js` shipped, booting the
 *     API into "gatewayServiceLimiter is not a function".
 *   • `utils/proxy/usageSearch.js` was missing when the usage-dashboard search was added.
 *   • `utils/proxy/validationResponse.js` was required by two deployed gateway routes and had
 *     never been in the list at all — a latent landmine for any fresh deploy target.
 *
 * WHY IT IS SCOPED TO utils/proxy/. `deploy-hostinger.sh` is an INCREMENTAL script: it ships the
 * files that change, and relies on the server already holding the stable tree (models, most
 * middleware, shared helpers). A blanket "everything required must be listed" rule would therefore
 * flag dozens of stable modules that are legitimately already deployed, and a test that cries wolf
 * gets ignored — which is worse than no test. `utils/proxy/` is where the active Claude/proxy work
 * happens and where every one of the incidents above originated, it is small, and it is fully
 * checkable. That makes this a rule that stays true and stays useful.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const SCRIPT = path.join(ROOT, 'deploy-hostinger.sh');
const SCOPE = 'utils/proxy/';

/** Every `backend/<path>` the deploy script uploads. */
function manifest() {
  const sh = fs.readFileSync(SCRIPT, 'utf8');
  const out = new Set();
  const re = /-T\s+backend\/([\w./-]+)/g;
  let m;
  while ((m = re.exec(sh))) out.add(m[1]);
  return out;
}

/** Repo-relative local requires of a backend file (package requires are ignored). */
function localRequires(relFile) {
  const abs = path.join(BACKEND, relFile);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out = new Set();
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.resolve(path.dirname(abs), m[1]);
    for (const cand of [target, target + '.js', path.join(target, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        out.add(path.relative(BACKEND, cand).split(path.sep).join('/'));
        break;
      }
    }
  }
  return [...out];
}

/** Every backend file that the deploy script ships, walked for its proxy-util dependencies. */
function proxyUtilDepsOfDeployedFiles() {
  const shipped = manifest();
  const deps = new Map();  // dep -> requiring file
  const seen = new Set();
  const queue = [...shipped];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of localRequires(f)) {
      if (dep.startsWith(SCOPE)) {
        if (!deps.has(dep)) deps.set(dep, f);
        if (!seen.has(dep)) queue.push(dep);   // a proxy util may require another
      }
    }
  }
  return deps;
}

test('every utils/proxy module required by deployed code is itself deployed', () => {
  const shipped = manifest();
  const deps = proxyUtilDepsOfDeployedFiles();
  assert.ok(deps.size >= 10, 'sanity: found the proxy utils (' + deps.size + ')');

  const missing = [...deps.entries()].filter(([dep]) => !shipped.has(dep));
  assert.deepStrictEqual(missing.map(([dep, by]) => `${dep}  (required by ${by})`), [],
    'required by DEPLOYED code but NOT uploaded — Passenger would boot the API into ' +
    '"Cannot find module"');
});

/**
 * The one-off per-feature deploy scripts are the SAME landmine as the main manifest, and they are
 * easier to miss: each ships a hand-written subset and they long outlive the change they were
 * written for. `deploy-writehuman-agentsync.sh` shipped ONLY agentSync.js — correct on the day it
 * was written, fatal the moment that route gained a require() on a module the server did not yet
 * have. Re-running it would have booted Passenger into "Cannot find module" and taken the whole
 * API down, and the main-manifest test above would not have noticed, because it only reads
 * deploy-hostinger.sh.
 *
 * Scoped to modules that DID NOT EXIST at the previous release (tracked by the explicit list
 * below) rather than the full dependency closure: an incremental script legitimately ships only
 * what changed and relies on the server already holding the stable tree, so demanding the whole
 * closure would flag every script and a test that cries wolf gets ignored. A NEW module is the
 * case that actually breaks a deploy, and it is the case every past incident had in common.
 */
const NEW_MODULES = ['utils/proxy/deviceSync.js', 'utils/proxy/candidateSync.js'];

function deployScripts() {
  return fs.readdirSync(ROOT).filter(f => /^deploy.*\.sh$/.test(f));
}

test('every deploy script that ships a route also ships the new modules that route requires', () => {
  const offenders = [];
  for (const script of deployScripts()) {
    const sh = fs.readFileSync(path.join(ROOT, script), 'utf8');
    // Files this script sends: `-T backend/<path>` uploads, plus paths handed to deploy-backend.sh.
    const sends = new Set();
    let m;
    const reUpload = /-T\s+backend\/([\w./-]+)/g;
    while ((m = reUpload.exec(sh))) sends.add(m[1]);
    const reArg = /deploy-backend\.sh\s+([^\n]*)/g;
    while ((m = reArg.exec(sh))) {
      for (const tok of m[1].split(/\s+/)) {
        const t = tok.replace(/\\$/, '').trim();
        if (t.startsWith('backend/')) sends.add(t.slice('backend/'.length));
      }
    }
    if (!sends.size) continue;

    for (const file of sends) {
      for (const dep of localRequires(file)) {
        if (NEW_MODULES.includes(dep) && !sends.has(dep)) {
          offenders.push(`${script}: ships ${file} which requires ${dep}, but does not ship it`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a per-feature deploy script would ship a route without a module it require()s — ' +
    'Passenger would boot the API into "Cannot find module"');
});

test('the manifest only lists backend files that exist', () => {
  for (const f of manifest()) {
    assert.ok(fs.existsSync(path.join(BACKEND, f)), 'manifest lists a missing file: backend/' + f);
  }
});

test('the manifest never ships tests or local secrets', () => {
  for (const f of manifest()) {
    assert.ok(!/\.test\.js$/.test(f), 'tests must never be deployed: ' + f);
    assert.ok(!/(^|\/)\.env/.test(f), 'env files must never be deployed: ' + f);
  }
});

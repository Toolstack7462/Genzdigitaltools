#!/usr/bin/env node
'use strict';
/**
 * HOTFIX THE LIVE EXTENSION PACKAGE — not the repository tree.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE NORMAL RELEASE PATH.
 * The normal path is scripts/build-extension.mjs: build the ZIP from chrome-extension/. That is
 * wrong here. Measured on 2026-10-18, the served package is v3.9.35 (266,900 bytes, sha256
 * ba1f2384…, 48 entries, identical on both member origins) while this repository's
 * chrome-extension/ source is v3.9.31 with 40 entries. Its js/background.js is 171,372 bytes
 * against the repo's 158,947 — roughly 12KB of code that is not in git — and 29 files differ with
 * 10 live-only. Versions 3.9.32-3.9.35 were published from a tree that is not in this repository.
 *
 * So building from source would DELETE ten files and revert twenty-nine. This script instead takes
 * the live package, changes exactly one thing in it, and bumps the version.
 *
 * THE ONE CHANGE. The live js/background.js still carries the Access crash: `orchestrator` starts
 * null, is assigned only in initialize(), initialize() is wired to onInstalled/onStartup only, and
 * four call sites dereference it directly. A worker woken by a MESSAGE gets neither lifecycle
 * event, so Access after an idle period produces
 *
 *     Could not open tool: Cannot read properties of null (reading 'executeLogin')
 *
 * The patch adds requireOrchestrator() — the same minimal accessor committed to
 * chrome-extension/js/background.js and covered by chrome-extension/test/
 * workerWakeOrchestrator.test.js — and routes the four call sites through it.
 *
 * IT REFUSES RATHER THAN GUESSES. Every assumption about the live file is asserted first: the null
 * declaration, the assignment inside initialize(), exactly the expected number of bare call sites,
 * and no accessor already present. If the live code has changed shape or has already been fixed,
 * this exits non-zero and says so instead of patching something it does not recognise.
 *
 * AND IT VERIFIES WHAT IT PRODUCES. The rebuilt package is unzipped again and checked: same entry
 * count, identical permissions, the new version, the accessor present, zero bare call sites, and
 * every other file byte-identical to the live original.
 *
 * THIS IS A HOTFIX, NOT A FIX TO THE PROCESS. The live extension source belongs in git; until it
 * is there, every release has to be done this way and `build-extension.mjs --check` cannot pass.
 *
 *   node scripts/patch-live-extension.mjs --out <dir> [--origin https://genzdigitalstore.com]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ORIGINS = ['https://genzdigitalstore.com', 'https://app.genzdigitalstore.com'];
const ZIP_NAME = 'genz-digital-store-extension.zip';
const OUT_DIR = arg('out');
if (!OUT_DIR) { console.error('--out <dir> is required'); process.exit(2); }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const die = (msg) => { console.error(`::error::${msg}`); process.exit(1); };
const run = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

// ── 1. fetch the live package from BOTH origins and require them to agree ────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'extpatch-'));
const downloaded = [];
for (const o of ORIGINS) {
  const dest = path.join(work, `${o.replace(/[^a-z0-9]/gi, '_')}.zip`);
  run('curl', ['-sL', '--fail', '--max-time', '180', '-o', dest, `${o}/downloads/${ZIP_NAME}?cb=${Date.now()}`]);
  const buf = fs.readFileSync(dest);
  downloaded.push({ origin: o, dest, size: buf.length, sha: sha(buf) });
  console.log(`live ${o}: ${buf.length} bytes sha256 ${sha(buf)}`);
}
if (new Set(downloaded.map((d) => d.sha)).size !== 1) {
  die('the two member origins serve DIFFERENT packages; refusing to patch one of them blindly');
}
const liveZip = downloaded[0].dest;
const liveSha = downloaded[0].sha;

// ── 2. extract, and record every file so the result can be proven unchanged elsewhere ────────
const src = path.join(work, 'live');
fs.mkdirSync(src);
run('unzip', ['-q', '-o', liveZip, '-d', src]);
const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const rel = base ? `${base}/${e.name}` : e.name;
  return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
});
const before = new Map(walk(src).map((rel) => [rel, sha(fs.readFileSync(path.join(src, rel)))]));
console.log(`live entries: ${before.size}`);

const manifestPath = path.join(src, 'manifest.json');
const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
const livePerms = (manifest.permissions || []).slice().sort();
console.log(`live manifest: v${manifest.version}  perms ${livePerms.join(',')}`);

// ── 3. assert the pre-state, then patch ───────────────────────────────────────────────────────
const bgPath = path.join(src, 'js', 'background.js');
let bg = fs.readFileSync(bgPath, 'utf8');
const codeOf = (s) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

if (/function requireOrchestrator\(/.test(bg)) die('the live package is ALREADY fixed — nothing to do');
const DECL = 'let orchestrator = null;';
if (!bg.includes(DECL)) die('the live background.js does not declare `let orchestrator = null;` — its shape has changed, refusing to patch');
const CALL = 'await orchestrator.executeLogin(';
const callSites = codeOf(bg).split(CALL).length - 1;
if (callSites < 1) die('no bare `await orchestrator.executeLogin(` call sites found — refusing to patch');
console.log(`bare call sites to convert: ${callSites}`);

const ACCESSOR = `${DECL}

/**
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
function requireOrchestrator() {
  if (!orchestrator) orchestrator = getOrchestrator();
  return orchestrator;
}`;
bg = bg.replace(DECL, ACCESSOR);
bg = bg.split(CALL).join('await requireOrchestrator().executeLogin(');
// initialize() keeps its own work but reuses the one accessor, so the two paths cannot drift.
bg = bg.replace('orchestrator = getOrchestrator();', 'requireOrchestrator();');

const patchedCode = codeOf(bg);
if (/(?<!require)[Oo]rchestrator\.executeLogin\(/.test(patchedCode)) die('a bare call site survived the patch');
if ((patchedCode.match(/requireOrchestrator\(\)\.executeLogin\(/g) || []).length !== callSites) {
  die('the patched file does not route every call site through the accessor');
}
fs.writeFileSync(bgPath, bg);

// ── 4. bump the version (patch segment), preserving the manifest's formatting ─────────────────
const parts = String(manifest.version).split('.');
parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
const newVersion = parts.join('.');
const newManifestRaw = manifestRaw.replace(`"version": "${manifest.version}"`, `"version": "${newVersion}"`);
if (newManifestRaw === manifestRaw) die('could not rewrite the manifest version string');
fs.writeFileSync(manifestPath, newManifestRaw);
// Some packages carry a package.json whose version must agree.
const pkgPath = path.join(src, 'package.json');
if (fs.existsSync(pkgPath)) {
  const raw = fs.readFileSync(pkgPath, 'utf8');
  fs.writeFileSync(pkgPath, raw.replace(`"version": "${manifest.version}"`, `"version": "${newVersion}"`));
}
console.log(`version ${manifest.version} -> ${newVersion}`);

// ── 5. rebuild, then verify the result against the original ──────────────────────────────────
const outZip = path.join(work, 'patched.zip');
run('zip', ['-q', '-X', '-r', outZip, '.'], { cwd: src });
const outBuf = fs.readFileSync(outZip);

const check = path.join(work, 'check');
fs.mkdirSync(check);
run('unzip', ['-q', '-o', outZip, '-d', check]);
const after = new Map(walk(check).map((rel) => [rel, sha(fs.readFileSync(path.join(check, rel)))]));
if (after.size !== before.size) die(`entry count changed: ${before.size} -> ${after.size}`);
const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
const expectedChanges = ['js/background.js', 'manifest.json', ...(fs.existsSync(pkgPath) ? ['package.json'] : [])];
const unexpected = changed.filter((c) => !expectedChanges.includes(c));
if (unexpected.length) die(`files changed that should not have: ${unexpected.join(', ')}`);
const missing = [...before.keys()].filter((k) => !after.has(k));
if (missing.length) die(`files lost from the package: ${missing.join(', ')}`);

const vm = JSON.parse(fs.readFileSync(path.join(check, 'manifest.json'), 'utf8'));
if (vm.version !== newVersion) die('the rebuilt manifest does not carry the new version');
const newPerms = (vm.permissions || []).slice().sort();
if (newPerms.join(',') !== livePerms.join(',')) die('the permission list changed — that would force re-consent on upgrade');
if (String(vm.manifest_version) !== String(manifest.manifest_version)) die('manifest_version changed');
if ((vm.key || null) !== (manifest.key || null)) die('the extension key changed — that would change its identity');
const vbg = codeOf(fs.readFileSync(path.join(check, 'js', 'background.js'), 'utf8'));
if (!/function requireOrchestrator\(/.test(vbg)) die('the rebuilt package does not contain the accessor');
if (/(?<!require)[Oo]rchestrator\.executeLogin\(/.test(vbg)) die('the rebuilt package still has a bare call site');

fs.mkdirSync(OUT_DIR, { recursive: true });
const final = path.join(OUT_DIR, ZIP_NAME);
fs.writeFileSync(final, outBuf);

console.log(`\nPATCHED v${newVersion}  ${outBuf.length} bytes  sha256 ${sha(outBuf)}`);
console.log(`entries ${after.size} (unchanged)  changed files: ${changed.join(', ')}`);
console.log(`from live v${manifest.version} sha256 ${liveSha}`);
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV,
    `EXT_VERSION=${newVersion}\nEXT_SHA=${sha(outBuf)}\nEXT_SIZE=${outBuf.length}\nEXT_FROM=${manifest.version}\nEXT_FROM_SHA=${liveSha}\n`);
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${newVersion}\nsha=${sha(outBuf)}\nsize=${outBuf.length}\n`);
}
console.log(`::notice title=patched-package::v${newVersion}  ${outBuf.length} bytes  sha256 ${sha(outBuf)}  (from live v${manifest.version}; ${after.size} entries preserved; changed: ${changed.join(' ')})`);

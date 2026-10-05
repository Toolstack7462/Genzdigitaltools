'use strict';
/**
 * Published release metadata → downloadable ZIP → internal manifest → packaged code must all
 * describe the SAME release.
 *
 * THE INCIDENT (2026-10). The admin uploaded v3.9.29. The upload wrote the main domain's
 * docroot and a legacy `public_html/app/downloads` folder that serves nothing — NOT the app
 * subdomain's real docroot, which is where the client dashboard and the extension popup
 * download from. "Latest" was read from the main-domain copy only, so version-info said 3.9.29
 * and the save-as name was `…-v3.9.29.zip`, while app.genzdigitalstore.com kept serving the
 * 3.9.25 package (sha256 e0e169c6…, live origin response, cache MISS).
 *
 * These tests drive the real module against temporary docroots — no mocks of the logic itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { crc32, readManifestFromZip } = require('../utils/zipManifest');
const { isValidChromeVersion, compareVersions } = require('../utils/semver');

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey';

// ── tiny STORED-zip builder (same format Chrome and zipManifest accept) ───────────────
function makeZip(files) {
  const locals = []; const central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nb = Buffer.from(name); const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nb.length, 26);
    locals.push(loc, nb, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, nb);
    off += 30 + nb.length + data.length;
  }
  const lp = Buffer.concat(locals); const cp = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cp.length, 12); e.writeUInt32LE(lp.length, 16);
  return Buffer.concat([lp, cp, e]);
}

function extZip(version, { code = `/* build ${version} */`, key = KEY, extra = {}, manifest = {}, drop = [] } = {}) {
  const m = {
    manifest_version: 3, name: 'Gen Z Digital Store Access', version, key,
    background: { service_worker: 'js/background.js' },
    action: { default_popup: 'popup.html' },
    icons: { 128: 'icons/icon128.png' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['js/bridge.js'] }],
    ...manifest,
  };
  const files = {
    'manifest.json': JSON.stringify(m),
    'js/background.js': code,
    'js/bridge.js': '/* bridge */',
    'popup.html': '<html></html>',
    'icons/icon128.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ...extra,
  };
  for (const d of drop) delete files[d];
  return makeZip(files);
}

// Fresh docroots per test; the module reads its config from env at call time.
function setupDocroots(n = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genz-ext-'));
  const dirs = [];
  for (let i = 0; i < n; i++) { const d = path.join(root, `site${i}`, 'downloads'); fs.mkdirSync(d, { recursive: true }); dirs.push(d); }
  process.env.EXTENSION_DOWNLOAD_DIRS = dirs.join(':');
  process.env.EXTENSION_PUBLIC_ORIGINS = '';
  process.env.EXTENSION_PUBLISH_LOCK_DIR = root;
  return { root, dirs };
}
const ZIP = 'genz-digital-store-extension.zip';
const put = (dir, buf) => fs.writeFileSync(path.join(dir, ZIP), buf);
const served = (dir) => fs.readFileSync(path.join(dir, ZIP));

const D = require('../utils/extensionDownloads');

// EXTENSION_DOWNLOAD_DIRS is ':'-separated (the server is Linux). A Windows drive letter
// contains ':', so on Windows the docroot tests run from the temp root with relative paths.
function withDocroots(fn) {
  return async () => {
    const prevCwd = process.cwd();
    const { root, dirs } = setupDocroots();
    if (process.platform === 'win32') {
      process.chdir(root);
      const rel = dirs.map(d => path.relative(root, d));
      process.env.EXTENSION_DOWNLOAD_DIRS = rel.join(':');
      try { await fn({ root, dirs: rel }); } finally { process.chdir(prevCwd); }
    } else {
      await fn({ root, dirs });
    }
  };
}

// ── 1. The incident, reproduced ───────────────────────────────────────────────────────
test('INCIDENT: docroots serving 3.9.29 and 3.9.25 must NOT advertise 3.9.29', withDocroots(({ dirs }) => {
  const [main, app] = dirs;
  put(main, extZip('3.9.29'));
  put(app, extZip('3.9.25'));
  const rel = { version: '3.9.29', minVersion: '3.9.25', sha256: D.sha256(extZip('3.9.29')) };
  const pub = D.resolvePublishedRelease(rel);
  // Every client is guaranteed only the oldest served copy — advertising anything newer is the bug.
  assert.strictEqual(pub.latest, '3.9.25');
  assert.strictEqual(D.readDiskExtensionVersion(), '3.9.25');
  assert.strictEqual(pub.servedConsistent, false);
  assert.strictEqual(pub.metadataMatchesArtifact, false);
  // The advertised save-as name now matches the manifest clients actually receive.
  assert.strictEqual(D.versionedFilename(pub.latest), 'genz-digital-store-extension-v3.9.25.zip');
  assert.strictEqual(readManifestFromZip(served(app)).version, pub.latest);
}));

test('INCIDENT: no deploy script or workflow publishes the app to the dead public_html/app root', () => {
  // app.genzdigitalstore.com is served from its OWN docroot; genzdigitalstore.com/public_html/app
  // serves nothing, so an upload there "succeeds" while clients keep the old build.
  const repo = path.join(__dirname, '..', '..');
  const targets = [
    ...fs.readdirSync(repo).filter(f => /^deploy.*\.sh$/.test(f)),
    ...fs.readdirSync(path.join(repo, '.github', 'workflows')).map(f => path.join('.github', 'workflows', f)),
  ];
  assert.ok(targets.includes('deploy-frontend-only.sh'), 'the scan must cover deploy-frontend-only.sh');
  const offenders = targets.filter((f) => fs.readFileSync(path.join(repo, f), 'utf8')
    .split(/\r?\n/).some(l => !/^\s*#/.test(l) && /genzdigitalstore\.com\/public_html\/app\b/.test(l)));
  assert.deepStrictEqual(offenders, []);
  const script = fs.readFileSync(path.join(repo, 'deploy-frontend-only.sh'), 'utf8');
  assert.match(script, /^APP_WEB="\/home\/\$\{USER\}\/domains\/app\.genzdigitalstore\.com\/public_html"\r?$/m);
});

test('INCIDENT: the default download dirs are the real client-serving docroots', () => {
  assert.ok(D.DEFAULT_DIRS.includes('/home/u171982351/domains/app.genzdigitalstore.com/public_html/downloads'),
    'the app subdomain docroot — where the dashboard and popup download from — must be written');
  assert.ok(!D.DEFAULT_DIRS.some(d => d.includes('genzdigitalstore.com/public_html/app/')),
    'public_html/app/ is an empty legacy dir that serves nothing');
  assert.ok(!D.DEFAULT_DIRS.some(d => d.includes('api.genzdigitalstore.com')),
    'the api docroot 404s /downloads; a stale copy there would drag "latest" down');
  assert.strictEqual(D.DEFAULT_DIRS.length, D.DEFAULT_PUBLIC_ORIGINS.length);
});

test('INCIDENT: a renamed old build ("-v3.9.29 (3).zip" containing 3.9.25) is rejected, not relabelled', () => {
  const expected = D.versionFromFilename('genz-digital-store-extension-v3.9.29 (3).zip');
  assert.strictEqual(expected, '3.9.29');
  assert.throws(() => D.validateExtensionPackage(extZip('3.9.25'), { expectedVersion: expected, currentKey: KEY }),
    (e) => e.code === 'version_mismatch' && e.status === 422);
});

test('dashboard and popup download from an origin whose docroot the publish writes', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', '..', 'chrome-extension', 'js', 'popup.js'), 'utf8');
  const src = /function appOriginFromApiUrl\(apiUrl\) \{[\s\S]*?\n\}/.exec(popup)[0];
  const appOriginFromApiUrl = new Function(`${src}; return appOriginFromApiUrl;`)();
  const popupOrigin = appOriginFromApiUrl('https://api.genzdigitalstore.com');
  assert.strictEqual(popupOrigin, 'https://app.genzdigitalstore.com');
  const i = D.DEFAULT_PUBLIC_ORIGINS.indexOf(popupOrigin);
  assert.ok(i >= 0, 'the popup origin must be one the publish verifies');
  assert.ok(D.DEFAULT_DIRS[i].includes('/app.genzdigitalstore.com/'), 'and it must map to the app docroot');
});

// ── 2. Valid release: metadata == archive manifest == payload ────────────────────────
test('a valid release publishes identical bytes everywhere and metadata follows them', withDocroots(({ dirs }) => {
  for (const d of dirs) put(d, extZip('3.9.25'));
  const buf = extZip('3.9.29', { code: 'NEW-RUNTIME-CODE-3.9.29' });
  const pkg = D.validateExtensionPackage(buf, { expectedVersion: '3.9.29', currentKey: KEY });
  assert.strictEqual(pkg.version, '3.9.29');
  const w = D.publishExtensionZip(buf);
  assert.strictEqual(w.written.length, 2);
  for (const d of dirs) {
    const got = served(d);
    assert.strictEqual(D.sha256(got), w.sha256);
    assert.strictEqual(readManifestFromZip(got).version, '3.9.29');
    assert.match(got.toString('latin1'), /NEW-RUNTIME-CODE-3\.9\.29/, 'the new code is inside the served ZIP');
  }
  const pub = D.resolvePublishedRelease({ version: '3.9.29', sha256: w.sha256 });
  assert.deepStrictEqual([pub.latest, pub.sha256, pub.servedConsistent, pub.metadataMatchesArtifact], ['3.9.29', w.sha256, true, true]);
}));

// ── 3. A subsequent release uses the new version AND new bytes (warm cache path) ──────
test('a subsequent release replaces the previous artifact — no stale cached read', withDocroots(({ dirs }) => {
  const a = D.publishExtensionZip(extZip('3.9.29', { code: 'A' }));
  assert.strictEqual(D.resolveServedRelease().version, '3.9.29'); // warms the cache
  const b = D.publishExtensionZip(extZip('3.9.30', { code: 'B' }));
  assert.notStrictEqual(a.sha256, b.sha256);
  const s = D.resolveServedRelease();
  assert.deepStrictEqual([s.version, s.sha256, s.consistent], ['3.9.30', b.sha256, true]);
  // An external writer (a deploy) replacing the file is picked up too.
  put(dirs[1], extZip('3.9.29', { code: 'A' }));
  fs.utimesSync(path.join(dirs[1], ZIP), new Date(), new Date(Date.now() + 5000));
  assert.strictEqual(D.resolveServedRelease().version, '3.9.29');
}));

// ── 4. Invalid / corrupt / mismatched packages are rejected ───────────────────────────
test('corrupt, truncated, nested, incomplete, re-keyed or badly versioned packages are rejected', () => {
  const good = extZip('3.9.29');
  const flipped = Buffer.from(good); flipped[60] ^= 0xff; // payload byte → CRC mismatch
  const cases = [
    [Buffer.from('not a zip at all'), 'zip_corrupt'],
    [good.subarray(0, good.length - 40), 'zip_corrupt'],
    [flipped, 'zip_corrupt'],
    [makeZip({ 'ext/manifest.json': JSON.stringify({ manifest_version: 3, version: '3.9.29' }) }), 'manifest_not_at_root'],
    [extZip('3.9.29', { drop: ['js/background.js'] }), 'missing_runtime_files'],
    [extZip('3.9.29', { key: 'DIFFERENT' }), 'extension_identity_changed'],
    [extZip('3.9.29-beta'), 'invalid_manifest_version'],
    [extZip('3.9.29', { manifest: { manifest_version: 2 } }), 'unsupported_manifest_version'],
  ];
  for (const [buf, code] of cases) {
    assert.throws(() => D.validateExtensionPackage(buf, { currentKey: KEY }), (e) => e.code === code, `expected ${code}`);
  }
});

test('Chrome version rules and numeric (not string) ordering', () => {
  for (const v of ['3.9.29', '1', '0.1', '65535.0.0.1']) assert.ok(isValidChromeVersion(v), v);
  for (const v of ['3.9.29-beta', 'v3.9.29', '03.9.1', '1.2.3.4.5', '70000', '0.0.0', '', '3..1']) assert.ok(!isValidChromeVersion(v), v);
  assert.strictEqual(compareVersions('3.9.10', '3.9.9'), 1);
  assert.strictEqual(compareVersions('3.9', '3.9.0'), 0);
});

// ── 5. Failure leaves the working release intact ─────────────────────────────────────
test('a missing docroot fails the publish and leaves every docroot on the previous release', withDocroots(({ dirs, root }) => {
  const prev = extZip('3.9.25');
  for (const d of dirs) put(d, prev);
  process.env.EXTENSION_DOWNLOAD_DIRS = [...dirs, path.join(path.isAbsolute(dirs[0]) ? root : '.', 'gone', 'downloads')].join(':');
  assert.throws(() => D.publishExtensionZip(extZip('3.9.29')), (e) => e.code === 'download_dir_missing');
  for (const d of dirs) assert.strictEqual(D.sha256(served(d)), D.sha256(prev));
  for (const d of dirs) assert.deepStrictEqual(fs.readdirSync(d), [ZIP], 'no temp files left behind');
}));

test('a failure while swapping files in restores the docroots already swapped', withDocroots(({ dirs }) => {
  const prev = extZip('3.9.25');
  put(dirs[0], prev);
  fs.mkdirSync(path.join(dirs[1], ZIP)); // rename onto a directory fails
  assert.throws(() => D.publishExtensionZip(extZip('3.9.29')));
  assert.strictEqual(D.sha256(served(dirs[0])), D.sha256(prev));
}));

test('rollback() (used when the public check or DB write fails) restores the previous release', withDocroots(({ dirs }) => {
  const prev = extZip('3.9.25');
  put(dirs[0], prev); // dirs[1] had no file before
  const w = D.publishExtensionZip(extZip('3.9.29'));
  assert.deepStrictEqual(w.rollback(), []);
  assert.strictEqual(D.sha256(served(dirs[0])), D.sha256(prev));
  assert.ok(!fs.existsSync(path.join(dirs[1], ZIP)));
  assert.strictEqual(D.resolveServedRelease().version, '3.9.25');
}));

// ── 6. Stale / delayed / concurrent publication cannot overwrite a newer release ──────
test('publication policy: downgrade and same-version-different-bytes blocked; identical republish allowed', () => {
  const v29 = { version: '3.9.29', sha256: 'aaa' };
  const both29 = { artifacts: [v29, v29] };
  assert.strictEqual(D.decidePublish({ version: '3.9.25', sha256: 'old' }, both29).code, 'version_downgrade_blocked');
  assert.strictEqual(D.decidePublish({ version: '3.9.29', sha256: 'zzz' }, both29).code, 'version_already_published');
  assert.strictEqual(D.decidePublish({ version: '3.9.29', sha256: 'aaa' }, both29).kind, 'republish');
  assert.strictEqual(D.decidePublish({ version: '3.9.30', sha256: 'bbb' }, both29).kind, 'new');
  assert.strictEqual(D.decidePublish({ version: '3.9.25', sha256: 'old' }, both29, true).kind, 'rollback');
  assert.strictEqual(D.decidePublish({ version: '3.9.25', sha256: 'x' }, { artifacts: [] }).kind, 'first');
  // A DB row newer than disk still blocks a downgrade (an older stale publish arriving late).
  assert.strictEqual(D.decidePublish({ version: '3.9.29', sha256: 'aaa' }, { artifacts: [v29], dbVersion: '3.9.30' }).code, 'version_downgrade_blocked');
});

test('the incident state is repairable only by the real release, never by re-pushing 3.9.25 over 3.9.29', () => {
  const state = { artifacts: [{ version: '3.9.29', sha256: 'real29' }, { version: '3.9.25', sha256: 'e0e1' }] };
  assert.strictEqual(D.decidePublish({ version: '3.9.29', sha256: 'real29' }, state).kind, 'republish');
  assert.strictEqual(D.decidePublish({ version: '3.9.25', sha256: 'e0e1' }, state).code, 'version_downgrade_blocked');
  assert.strictEqual(D.decidePublish({ version: '3.9.29', sha256: 'relabelled' }, state).code, 'version_already_published');
});

test('publishes are serialised across workers; a crashed holder\'s lock goes stale', withDocroots(async ({ root }) => {
  let release;
  const first = D.withPublishLock(() => new Promise(r => { release = r; }));
  await assert.rejects(D.withPublishLock(async () => 'second'), (e) => e.code === 'publish_in_progress' && e.status === 409);
  release('done');
  assert.strictEqual(await first, 'done');
  assert.strictEqual(await D.withPublishLock(async () => 'after'), 'after');
  const lock = path.join(process.env.EXTENSION_PUBLISH_LOCK_DIR || root, 'genz-extension-publish.lock');
  fs.writeFileSync(lock, '999999');
  const old = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(lock, old, old);
  assert.strictEqual(await D.withPublishLock(async () => 'reclaimed'), 'reclaimed');
}));

// ── 7. Latest / minimum can never require an unavailable package ──────────────────────
test('minimum and force-update are clamped to the version actually served', withDocroots(({ dirs }) => {
  for (const d of dirs) put(d, extZip('3.9.25'));
  let pub = D.resolvePublishedRelease({ version: '3.9.29', minVersion: '3.9.29' });
  assert.deepStrictEqual([pub.latest, pub.effectiveMin], ['3.9.25', '3.9.25']);
  pub = D.resolvePublishedRelease({ version: '3.9.29', updateRequired: true });
  assert.deepStrictEqual([pub.latest, pub.effectiveMin], ['3.9.25', '3.9.25']);
  pub = D.resolvePublishedRelease({ version: '3.9.25', minVersion: '3.9.20' });
  assert.strictEqual(pub.effectiveMin, '3.9.20');
}));

// ── Public-URL verification (proves the folders written are the folders served) ───────
test('public check: match, wrong bytes served, unreachable, and a fetch that never settles', async () => {
  const want = D.sha256(Buffer.from('new'));
  const resp = (body, status = 200) => ({ ok: status < 400, status, arrayBuffer: async () => Buffer.from(body) });
  const r = await D.verifyPublicDownloads(want, {
    origins: ['https://ok', 'https://stale', 'https://down', 'https://hang', 'https://404'],
    timeoutMs: 200,
    fetchImpl: async (url) => {
      if (url.startsWith('https://ok/')) return resp('new');
      if (url.startsWith('https://stale/')) return resp('old');
      if (url.startsWith('https://down/')) throw new Error('ECONNRESET');
      if (url.startsWith('https://404/')) return resp('', 404);
      return new Promise(() => {}); // never settles
    },
  });
  assert.deepStrictEqual(r.map(x => x.status), ['match', 'mismatch', 'unreachable', 'unreachable', 'mismatch']);
  assert.match(D.publicOrigins.toString(), /EXTENSION_PUBLIC_ORIGINS/);
});

// ── Deploy guard: a frontend deploy never overwrites a newer live release ─────────────
test('deploy guard keeps a newer or differently-built live ZIP, ships only a strictly newer repo ZIP', async () => {
  const { decideDeploy } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'extension-live-guard.mjs')).href);
  const local = { version: '3.9.25', sha256: 'e0e1' };
  const live = (o) => ({ origin: 'https://o', status: 'ok', ...o });
  assert.strictEqual(decideDeploy(local, [live({ version: '3.9.29', sha256: '0ee5' })]).ship, false);
  assert.strictEqual(decideDeploy(local, [live({ version: '3.9.25', sha256: 'diff' })]).ship, false);
  assert.strictEqual(decideDeploy(local, [{ origin: 'https://o', status: 'error', error: 'timeout' }]).ship, false);
  assert.strictEqual(decideDeploy(local, [live({ version: '3.9.25', sha256: 'e0e1' })]).ship, true);
  assert.strictEqual(decideDeploy(local, [live({ version: '3.9.20', sha256: 'f615' }), { origin: 'x', status: 'absent' }]).ship, true);
  // The live production state on 2026-10-03: main 3.9.29, app 3.9.25 → keep live.
  assert.strictEqual(decideDeploy(local, [live({ version: '3.9.29', sha256: '0ee5' }), live({ version: '3.9.25', sha256: 'e0e1' })]).ship, false);
});

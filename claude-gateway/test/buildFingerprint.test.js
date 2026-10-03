'use strict';
/**
 * The gateway must be able to say WHICH CODE it is running.
 *
 * WHY THIS TEST EXISTS. The Cloudflare-challenge handling (Fix A: challenged XHR → non-navigating
 * 503 JSON; Fix B: /api/challenge_redirect → 204; the bounded GET-only nav retry) is deliberately
 * device-independent, so it covers MacBook Safari/Chrome, iPadOS, Android and Chromebook by the same
 * path as Windows. That makes "a MacBook still shows the verification page" a DEPLOY question before
 * it is a code question — and until now no response could answer it. From outside, these two are
 * indistinguishable:
 *
 *   (a) the fix IS live and Cloudflare is still challenging this datacenter egress IP;
 *   (b) the fix was never picked up — a Passenger worker is still serving the pre-fix code.
 *
 * Only (b) is fixable here, and mistaking (a) for (b) is how correct code gets rewritten. So the
 * build id has to be trustworthy in exactly the ways an operator relies on:
 *   - identical bytes → identical id (local↔live comparison is meaningful at all);
 *   - a changed shipped file → a different id (a partial upload cannot masquerade as current);
 *   - a MISSING shipped file → a different id (a dropped upload is the failure mode that takes the
 *     tool down with "Cannot find module", and it must not read as "same build");
 *   - obtainable without an .env, so the deploy script can compute the expected value from a bare
 *     checkout before it has any server credentials;
 *   - covering exactly the files the deploy script uploads — otherwise the id certifies the wrong set.
 *
 * It also re-asserts that the health route stayed public-safe: this is a lease-free endpoint, and the
 * fingerprint must add a content hash and a random worker id, never a secret.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const DEPLOY = path.join(GW, '..', 'deploy-claude-gateway.sh');
const SECRET = 'x'.repeat(48);
const GATEWAY_KEY = 'k'.repeat(32);

/** `node server.js --build-id` in `cwd`, with NO gateway env — as the deploy script runs it. */
function buildId(cwd) {
  const r = spawnSync(process.execPath, ['server.js', '--build-id'], {
    cwd,
    encoding: 'utf8',
    // Deliberately stripped of every gateway variable: the flag must resolve before the
    // TARGET_ORIGIN/API_BASE validation, or a bare checkout could never compute the expected id.
    env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' },
  });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
}

/** The FILES=( ... ) array the deploy script actually uploads. */
function manifest() {
  const m = fs.readFileSync(DEPLOY, 'utf8').match(/FILES=\(([\s\S]*?)\)/);
  assert.ok(m, 'deploy-claude-gateway.sh must declare a FILES=( ... ) array');
  return m[1].split(/\s+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

/** The BUILD_FILES list server.js hashes. */
function buildFiles() {
  const m = fs.readFileSync(path.join(GW, 'server.js'), 'utf8').match(/const BUILD_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'server.js must declare a BUILD_FILES array');
  return (m[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''));
}

/** A throwaway copy of just the shipped files, so mutation tests never touch the real tree. */
function stageCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genz-build-'));
  for (const rel of manifest()) {
    const src = path.join(GW, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}
const rmrf = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} };

// ── The id is computable without an .env, and is a stable short hash ──────────────────────────
test('--build-id prints a stable short hash and exits 0 with no gateway env', () => {
  const a = buildId(GW);
  assert.strictEqual(a.code, 0, 'must exit 0 from a bare checkout, not fail env validation: ' + a.err.slice(0, 300));
  assert.match(a.out, /^[0-9a-f]{12}$/, 'a 12-hex content id, got: ' + JSON.stringify(a.out));
  const b = buildId(GW);
  assert.strictEqual(b.out, a.out, 'the same bytes must always produce the same id');
});

// ── Identical bytes → identical id. This is what makes local↔live comparison mean anything. ──
test('an identical copy of the shipped files reports the identical id', () => {
  const dir = stageCopy();
  try {
    assert.strictEqual(buildId(dir).out, buildId(GW).out,
      'a byte-identical deploy must be recognisable as the same build');
  } finally { rmrf(dir); }
});

// ── A changed file → a different id. A partial upload cannot look current. ────────────────────
test('changing any shipped file changes the id', () => {
  const dir = stageCopy();
  try {
    const before = buildId(dir).out;
    // overlay.css, not server.js: the point is that the id covers the WHOLE shipped set, so a
    // stale asset beside a fresh server.js is still visibly a different build.
    fs.appendFileSync(path.join(dir, 'public/overlay.css'), '\n/* drift */\n');
    const after = buildId(dir).out;
    assert.match(after, /^[0-9a-f]{12}$/);
    assert.notStrictEqual(after, before, 'a modified shipped asset must not report the same build id');
  } finally { rmrf(dir); }
});

// ── A MISSING file → a different id. This is the failure that takes the tool down. ────────────
test('a shipped file that failed to upload changes the id (never reads as the same build)', () => {
  const dir = stageCopy();
  try {
    const before = buildId(dir).out;
    fs.rmSync(path.join(dir, 'lib/streamGuard.js'));
    const after = buildId(dir).out;
    assert.strictEqual(buildId(dir).code, 0, 'the id must still be computable when a module is missing');
    assert.notStrictEqual(after, before, 'a dropped upload must be visible as a different build');
  } finally { rmrf(dir); }
});

// ── The id must certify exactly what the deploy script uploads ────────────────────────────────
test('BUILD_FILES covers exactly the deploy manifest', () => {
  const hashed = buildFiles();
  const shipped = manifest();
  assert.ok(hashed.length >= 9, 'sanity: the BUILD_FILES scan found the list (' + hashed.join(', ') + ')');
  assert.deepStrictEqual(
    [...hashed].sort(), [...shipped].sort(),
    'the fingerprint must hash the same set the deploy script uploads — otherwise it certifies the wrong files',
  );
});

// ── Live route: the running gateway reports its build, and stays public-safe ──────────────────
let proc, upstream, backend, GW_PORT;

test.before(async () => {
  backend = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    r.end('{}');
  });
  await new Promise((res) => backend.listen(0, res));
  upstream = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>ok</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));

  // Must not collide with any other suite's fixed port — `node --test` runs files concurrently, and
  // durableSession.test.js already owns 18870/18871. 18980+ is unclaimed.
  GW_PORT = 18980;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY,
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
  });
  proc = spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const ok = await health().then((r) => r.status === 200).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  try { proc.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});

function health() {
  return new Promise((resolve) => {
    const r = http.request({ port: GW_PORT, path: '/__genz/health', method: 'GET' }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
  });
}

test('/__genz/health reports the build id the repo computes, plus the worker that answered', async () => {
  const r = await health();
  assert.strictEqual(r.status, 200, 'health must stay 200 — the fingerprint is diagnostics, not a gate');
  const j = JSON.parse(r.body);
  assert.strictEqual(j.build.id, buildId(GW).out, 'live and local must agree for the same bytes');
  assert.strictEqual(j.build.files, manifest().length, 'every shipped file was found and hashed');
  assert.match(String(j.build.worker), /^[0-9a-f]{6}$/, 'the per-worker id, so repeated polls enumerate workers');
  assert.strictEqual(typeof j.build.uptimeSec, 'number', 'uptime — a worker older than the deploy is a stale worker');
  assert.strictEqual(r.headers['cache-control'], 'no-store', 'a deploy check must never read a cached build id');
});

test('the existing health payload is unchanged beside the new field', async () => {
  const j = JSON.parse((await health()).body);
  // The mobile invariants are what a deploy check already watches; adding `build` must not disturb
  // them, nor the tool identity, nor the per-request device classification.
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.tool, 'claude');
  assert.deepStrictEqual(j.missingEnv, []);
  assert.strictEqual(j.claudeMobile.cfChallengeMode, 'passthrough');
  assert.strictEqual(typeof j.claudeMobile.mobileReady, 'boolean');
  assert.ok(j.client && j.client.device, 'the caller classification still reports');
});

test('the build report leaks no secret on this lease-free route', async () => {
  const body = (await health()).body;
  for (const secret of [SECRET, GATEWAY_KEY]) {
    assert.ok(!body.includes(secret), 'health must never echo a secret');
  }
  // Nor the absolute path of the app dir, nor a full file hash that would only add noise.
  assert.ok(!/[A-Za-z]:\\|\/home\//.test(body), 'no filesystem path in the build report');
  assert.ok(!/[0-9a-f]{40,}/.test(body), 'the id is a short digest, not a full hash dump');
});

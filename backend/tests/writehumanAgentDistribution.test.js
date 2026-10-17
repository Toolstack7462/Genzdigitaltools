'use strict';
/**
 * DISTRIBUTION READINESS: a valid LOCAL candidate is not evidence of a PUBLISHED download.
 *
 * deploy-hostinger.sh ships routes/admin/proxyTools.js, which carries EXPECTED_AGENT_VERSION —
 * the version the dashboard advertises and tells field agents to update to. It does NOT publish
 * the installer: the server serves that from WH_AGENT_DIST_DIR (default ~/writehuman-agent),
 * populated by a separate manual step.
 *
 * The earlier pre-flight got this exactly backwards. It consulted the live download ONLY when no
 * local candidate existed, so holding a perfectly verified 3.5.15 candidate SKIPPED the check and
 * let the deploy advertise 3.5.15 while the download still served an older build. Local integrity
 * and distribution readiness are different questions and are now asked separately.
 *
 * Every case here runs against a LOCAL MOCK on 127.0.0.1. Nothing contacts production, and
 * nothing is published.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACKEND = path.join(__dirname, '..');
const SCRIPT = path.join(BACKEND, 'scripts', 'verify-agent-distribution.cjs');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const EXE_315 = Buffer.from('pretend installer bytes for 3.5.15');
const SHA_315 = sha256(EXE_315);
const EXE_352 = Buffer.from('older installer bytes for 3.5.2');

/** A stand-in for the published download endpoints. `state` decides what it serves. */
/** Run a child to completion without blocking this process's event loop. */
function run(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: BACKEND });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, out }));
  });
}

function startMock(state) {
  const server = http.createServer((req, res) => {
    const base = '/api/crm/downloads/writehuman-agent/windows';
    if (req.url === `${base}/latest.json`) {
      if (state.metaStatus && state.metaStatus !== 200) { res.writeHead(state.metaStatus); return res.end('{}'); }
      if (state.metaRaw !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(state.metaRaw); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.meta));
    }
    if (req.url === `${base}/latest`) {
      if (state.bodyStatus && state.bodyStatus !== 200) { res.writeHead(state.bodyStatus); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'application/vnd.microsoft.portable-executable' });
      return res.end(state.body);
    }
    res.writeHead(404); res.end('nope');
  });
  // Node's fetch keeps connections alive, and server.close() waits for them — without this the
  // teardown never resolves and every mock-backed case times out instead of asserting.
  server.keepAliveTimeout = 1;
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

async function check(state, { version = '3.5.15', sha = SHA_315, extra = [] } = {}) {
  const server = await startMock(state);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const args = [SCRIPT, '--base', base, '--version', version];
    if (sha) args.push('--sha256', sha);
    // MUST be async. spawnSync blocks this process's event loop, and the mock server lives in
    // this same process — so a synchronous spawn means the child's fetch can never be answered and
    // both sides wait for each other for ever. That deadlock looked exactly like a hung test.
    return await run([...args, ...extra]);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

const meta315 = { product: 'WriteHuman Universal Agent', file: 'WriteHuman-Agent-Setup-x64.exe',
  version: '3.5.15', size: EXE_315.length, sha256: SHA_315, arch: 'x64', signed: false };

// ── The case named in the brief ─────────────────────────────────────────────────────────────────

test('valid local 3.5.15 candidate + remote serving an OLDER installer -> BLOCK', async () => {
  const older = { ...meta315, version: '3.5.2', size: EXE_352.length, sha256: sha256(EXE_352) };
  const { status, out } = await check({ meta: older, body: EXE_352 });
  assert.notStrictEqual(status, 0, 'advertising 3.5.15 while the download serves 3.5.2 must block');
  assert.match(out, /advertises "3\.5\.2"/);
  assert.match(out, /NOT READY for 3\.5\.15/);
});

test('valid local candidate + remote installer MISSING entirely -> BLOCK', async () => {
  const { status, out } = await check({ metaStatus: 404 });
  assert.notStrictEqual(status, 0);
  assert.match(out, /latest\.json returned HTTP 404|nothing is published/);
});

test('remote metadata unreachable -> BLOCK (never assumed healthy)', async () => {
  const r = spawnSync(process.execPath,
    [SCRIPT, '--base', 'http://127.0.0.1:1', '--version', '3.5.15', '--sha256', SHA_315],
    { encoding: 'utf8', cwd: BACKEND, env: { ...process.env, WH_DIST_TIMEOUT_MS: '2000' } });
  assert.notStrictEqual(r.status, 0);
  assert.match((r.stdout || '') + (r.stderr || ''), /could not be fetched|NOT READY/);
});

// ── Matching metadata, bad bytes: the failure mode that looks healthiest ─────────────────────────

test('MATCHING METADATA but the download is MISSING -> BLOCK', async () => {
  const { status, out } = await check({ meta: meta315, bodyStatus: 404 });
  assert.notStrictEqual(status, 0,
    'latest.json advertising a release whose bytes 404 must not pass as published');
  assert.match(out, /installer download returned HTTP 404/);
});

test('MATCHING METADATA but the downloaded BYTES differ -> BLOCK', async () => {
  const tampered = Buffer.from('these are not the advertised bytes');
  const { status, out } = await check({ meta: meta315, body: tampered });
  assert.notStrictEqual(status, 0, 'a served file that is not the published release must block');
  assert.match(out, /hashes to [0-9a-f]{64} but latest\.json advertises/);
});

test('MATCHING METADATA but the download is TRUNCATED -> BLOCK', async () => {
  const truncated = EXE_315.subarray(0, 10);
  const { status, out } = await check({ meta: meta315, body: truncated });
  assert.notStrictEqual(status, 0);
  assert.match(out, /hashes to|bytes but latest\.json says/);
});

test('SAME VERSION, DIFFERENT BYTES than the local candidate -> BLOCK', async () => {
  const other = Buffer.from('a different 3.5.15 build');
  const meta = { ...meta315, size: other.length, sha256: sha256(other) };
  const { status, out } = await check({ meta, body: other });
  assert.notStrictEqual(status, 0,
    '"published" must mean the same bytes, not merely the same version string');
  assert.match(out, /is not the local candidate/);
});

test('metadata without a sha256 -> BLOCK (nothing to verify the download against)', async () => {
  const meta = { ...meta315 }; delete meta.sha256;
  const { status, out } = await check({ meta, body: EXE_315 });
  assert.notStrictEqual(status, 0);
  assert.match(out, /no sha256/);
});

test('malformed published metadata -> BLOCK', async () => {
  const { status, out } = await check({ metaRaw: '{ not json' });
  assert.notStrictEqual(status, 0);
  assert.match(out, /not valid JSON/);
});

// ── The ready case, so the check is not merely always-red ───────────────────────────────────────

test('published metadata AND matching served bytes -> PASS', async () => {
  const { status, out } = await check({ meta: meta315, body: EXE_315 });
  assert.strictEqual(status, 0, `a genuinely published release must pass:\n${out}`);
  assert.match(out, /3\.5\.15 is published and the served bytes match/);
});

test('--skip-body says so in the verdict instead of implying the bytes were checked', async () => {
  const { status, out } = await check({ meta: meta315, bodyStatus: 404 }, { extra: ['--skip-body'] });
  assert.strictEqual(status, 0, 'metadata-only mode still passes on matching metadata');
  assert.match(out, /METADATA ONLY/);
  assert.match(out, /bytes were NOT verified/);
});

// ── The deploy script must ask BOTH questions, always ───────────────────────────────────────────

test('deploy-hostinger.sh checks distribution readiness even when a local candidate exists', () => {
  const fs = require('fs');
  const sh = fs.readFileSync(path.join(BACKEND, '..', 'deploy-hostinger.sh'), 'utf8');
  const code = sh.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
  const joined = code.join('\n');

  assert.match(joined, /verify-agent-distribution\.cjs/,
    'the deploy must verify what is actually downloadable, not only what is in dist/');

  // The old shape: distribution checked only in the "no local dist" branch. The distribution
  // check must NOT sit inside a branch that a present local candidate can skip.
  const distIdx = joined.indexOf('verify-agent-distribution.cjs');
  const elseIdx = joined.indexOf('else', joined.indexOf('latest.json'));
  const fiIdx = joined.indexOf('fi', distIdx);
  assert.ok(distIdx > -1 && fiIdx > -1, 'expected the distribution check and a closing fi');
  assert.ok(!(elseIdx > -1 && distIdx > elseIdx && distIdx < fiIdx && joined.slice(elseIdx, distIdx).includes('no candidate')),
    'the distribution check must not be confined to the no-candidate branch');

  // Local integrity is still required when a candidate is present — the two are complementary.
  assert.match(joined, /npm run --silent test:release-gate/,
    'a local candidate must still be verified for integrity');
});

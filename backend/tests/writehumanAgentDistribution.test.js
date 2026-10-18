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
const { describe } = require('node:test');
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

test('remote metadata unreachable -> BLOCK, and reported as UNVERIFIED not NOT READY', async () => {
  // An unreachable host blocks the deploy, but it is NOT evidence about what is published. The
  // script used to print "this deploy would advertise a version the download does not serve" after
  // a transport failure, which asserts something the run never observed. Exit 3 (UNVERIFIED) is
  // deliberately distinct from exit 1 (an observed readiness failure).
  const r = spawnSync(process.execPath,
    [SCRIPT, '--base', 'http://127.0.0.1:1', '--version', '3.5.15', '--sha256', SHA_315],
    { encoding: 'utf8', cwd: BACKEND, env: { ...process.env, WH_DIST_TIMEOUT_MS: '2000' } });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notStrictEqual(r.status, 0, 'a deploy must still refuse to proceed');
  assert.strictEqual(r.status, 3, 'transport failure must exit 3, not the observed-failure code 1');
  assert.match(out, /UNVERIFIED for 3\.5\.15/);
  assert.match(out, /\[TRANSPORT\]/, 'the failure class must be named');
  assert.match(out, /could not be reached/);
  assert.ok(!/would advertise a version the download does not serve/.test(out),
    'nothing was observed about production, so no claim about it may be printed');
  assert.ok(!/Publish the installer and its metadata/.test(out),
    'publishing is not the remedy for an unreachable host');
  assert.match(out, /readiness is UNKNOWN/);
});

describe('failure classes are separated, and all of them still block', () => {
  // Each class gets its own exit code and its own named remedy, so a deploy log cannot be read as
  // the wrong kind of problem. Exit 1 = the host answered and contradicted readiness.
  test('HTTP failure: metadata 404 -> exit 1, NOT READY, [HTTP]', async () => {
    const { status, out } = await check({ metaStatus: 404 });
    assert.strictEqual(status, 1);
    assert.match(out, /NOT READY for 3\.5\.15/);
    assert.match(out, /\[HTTP\] latest\.json returned HTTP 404/);
    assert.match(out, /HTTP failure — the host answered/);
  });

  test('VERSION mismatch: remote serves 3.5.2 -> exit 1, [VERSION], named as a version mismatch', async () => {
    const older = { ...meta315, version: '3.5.2', size: EXE_352.length, sha256: sha256(EXE_352) };
    const { status, out } = await check({ meta: older, body: EXE_352 });
    assert.strictEqual(status, 1);
    assert.match(out, /\[VERSION\]/);
    assert.match(out, /VERSION mismatch — published metadata names a different release/);
    assert.ok(!/UNVERIFIED/.test(out), 'the host WAS reached, so this is an observed failure');
  });

  test('BYTE/HASH mismatch: metadata matches but bytes differ -> exit 1, [HASH]', async () => {
    const { status, out } = await check({ meta: meta315, body: Buffer.from('different bytes') });
    assert.strictEqual(status, 1);
    assert.match(out, /\[HASH\]/);
    assert.match(out, /BYTE\/HASH mismatch — the served file is not the published release/);
  });

  test('METADATA invalid: a falsy body -> exit 1, [METADATA], never a pass', async () => {
    const { status, out } = await check({ metaRaw: 'null' });
    assert.strictEqual(status, 1);
    assert.match(out, /\[METADATA\]/);
    assert.match(out, /METADATA invalid — the descriptor cannot be trusted/);
  });

  test('a usage error stays exit 2, distinct from both verdicts', async () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: BACKEND });
    assert.strictEqual(r.status, 2);
  });
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
  assert.match(out, /no valid sha256/);
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
  assert.match(out, /BYTES WERE NOT VERIFIED/);
  assert.ok(!/is published and the served bytes match/.test(out),
    'metadata-only output must not carry the full readiness verdict');
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

/**
 * FALSY JSON BODIES: absent evidence must never read as verified evidence.
 *
 * REPRODUCED on node v24.14.1 against the previous script. Every check AND the download itself sat
 * behind `if (meta)`, and a 200 response whose JSON body is null / false / 0 / "" is falsy — so the
 * branch was skipped entirely, no problem was recorded, the installer was NEVER REQUESTED, and the
 * run printed "published and the served bytes match" and exited 0. With --sha256 supplied and
 * without --skip-body:
 *
 *     body: null    -> exit 0, success verdict, installer_requested=false
 *     body: false   -> exit 0, success verdict, installer_requested=false
 *     body: 0       -> exit 0, success verdict, installer_requested=false
 *     body: ""      -> exit 0, success verdict, installer_requested=false
 *
 * A placeholder endpoint, a misconfigured CDN returning an empty document, or a route that answers
 * 200 with a null body would all have certified a release as downloadable. These cases pin the
 * exit code for each one.
 */
describe('falsy and malformed published metadata', () => {
  for (const [label, raw] of [['null', 'null'], ['false', 'false'], ['0', '0'], ['empty string', '""']]) {
    test(`JSON body of ${label} -> BLOCK, and the installer is never certified`, async () => {
      const { status, out } = await check({ metaRaw: raw, body: EXE_315 });
      assert.notStrictEqual(status, 0,
        `a 200 response whose body is ${label} must not certify a release`);
      assert.ok(!/is published and the served bytes match/.test(out),
        'no success verdict may be printed for a body that is not metadata');
      assert.match(out, /not a metadata object/);
    });
  }

  test('JSON body of an ARRAY -> BLOCK with a shape error, not an incidental one', async () => {
    const { status, out } = await check({ metaRaw: '[]', body: EXE_315 });
    assert.notStrictEqual(status, 0);
    assert.match(out, /a JSON array/);
  });

  test('a JSON string body -> BLOCK', async () => {
    const { status, out } = await check({ metaRaw: '"3.5.15"', body: EXE_315 });
    assert.notStrictEqual(status, 0);
    assert.match(out, /not a metadata object/);
  });

  // ── required fields, each validated on its own ────────────────────────────────────────────────
  const base = { product: 'x', file: 'y', arch: 'x64', signed: false };

  test('version missing -> BLOCK', async () => {
    const { status, out } = await check({ meta: { ...base, sha256: SHA_315, size: EXE_315.length }, body: EXE_315 });
    assert.notStrictEqual(status, 0);
    assert.match(out, /no usable "version"/);
  });

  test('version present but not a string -> BLOCK', async () => {
    const { status, out } = await check({ meta: { ...base, version: 3515, sha256: SHA_315, size: EXE_315.length }, body: EXE_315 });
    assert.notStrictEqual(status, 0);
    assert.match(out, /no usable "version"/);
  });

  test('sha256 that is not 64 hex characters -> BLOCK', async () => {
    for (const bad of ['', 'deadbeef', SHA_315 + 'a', 'z'.repeat(64), 12345]) {
      const { status, out } = await check({
        meta: { ...base, version: '3.5.15', sha256: bad, size: EXE_315.length }, body: EXE_315,
      });
      assert.notStrictEqual(status, 0, `sha256 ${JSON.stringify(bad)} must be refused`);
      assert.match(out, /no valid sha256/);
    }
  });

  test('size that is not a positive safe integer -> BLOCK', async () => {
    for (const bad of [0, -1, 1.5, '34', null, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      const { status, out } = await check({
        meta: { ...base, version: '3.5.15', sha256: SHA_315, size: bad }, body: EXE_315,
      });
      assert.notStrictEqual(status, 0, `size ${JSON.stringify(bad)} must be refused`);
      assert.match(out, /no valid "size"/);
    }
  });

  test('POSITIVE CONTROL: a complete valid descriptor with matching bytes still PASSES', async () => {
    const { status, out } = await check({ meta: meta315, body: EXE_315 });
    assert.strictEqual(status, 0, `the checker must not be merely always-red:\n${out}`);
    assert.match(out, /3\.5\.15 is published and the served bytes match/);
  });
});

describe('the checker keeps its streaming hash and its timeout', () => {
  const src = require('fs').readFileSync(SCRIPT, 'utf8');

  test('the download is hashed INCREMENTALLY, not buffered whole', () => {
    assert.match(src, /for await \(const chunk of r\.body\)/,
      'the installer is ~92 MB; it must be hashed as it streams, not read into memory');
    assert.ok(!/arrayBuffer\(\)|\.text\(\)|\.blob\(\)/.test(src),
      'buffering the whole installer would reintroduce a memory cost this avoided');
    assert.match(src, /createHash\('sha256'\)/);
  });

  test('both requests carry the configured timeout', () => {
    const signals = src.match(/AbortSignal\.timeout\(TIMEOUT_MS\)/g) || [];
    assert.ok(signals.length >= 2,
      'latest.json AND the installer download must both time out rather than hang a deploy');
    assert.match(src, /WH_DIST_TIMEOUT_MS/, 'the timeout must stay configurable');
  });

  test('production deployment does not rely on --skip-body', () => {
    const sh = require('fs').readFileSync(path.join(BACKEND, '..', 'deploy-hostinger.sh'), 'utf8');
    const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/--skip-body/.test(code),
      'the deploy pre-flight must verify the actual bytes; --skip-body is a diagnostic only');
  });
});

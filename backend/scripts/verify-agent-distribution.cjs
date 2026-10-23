#!/usr/bin/env node
'use strict';
/**
 * DISTRIBUTION READINESS — is the version this tree ADVERTISES actually downloadable?
 *
 * This is a different question from local artifact integrity, and conflating them was a real hole.
 * `npm run test:release-gate` proves the exe in writehuman-v2/agent/dist/ carries this tree's
 * source. It says nothing whatsoever about what a field agent can download, because NOTHING in
 * this repository publishes the installer: deploy-hostinger.sh ships backend files, and the server
 * serves the exe from WH_AGENT_DIST_DIR (default ~/writehuman-agent), which is populated by a
 * separate, manual step.
 *
 * So a working copy holding a perfect 3.5.15 candidate could deploy a backend that advertises
 * 3.5.15 while the download still served 3.5.2 — every field agent told to update to a version
 * that does not exist. That is the 2026-08-26 failure with an extra step in front of it, and the
 * earlier pre-flight actively made it worse: it checked the live download ONLY when no local
 * candidate was present, so having a valid candidate SKIPPED the one check that mattered.
 *
 * What this verifies, against the real published endpoints:
 *   1. latest.json is reachable and advertises exactly the expected version.
 *   2. Its sha256/size are present and, when a local candidate is supplied, identical to it —
 *      so "published" means the same bytes, not merely the same version string.
 *   3. The installer actually downloads, and the BYTES hash to the advertised sha256. Matching
 *      metadata over a missing or truncated file is the failure mode that looks healthiest.
 *
 * Read-only: it performs GETs against published endpoints and changes nothing. Point --base at a
 * staging host or a mock for testing; never load-test production with it.
 *
 *   node scripts/verify-agent-distribution.cjs --base https://api.example.com --version 3.5.15 \
 *        [--sha256 <local candidate sha256>] [--skip-body]
 *
 * Exit codes: 0 = the advertised version is genuinely downloadable. Non-zero = do not deploy.
 *   1 = NOT READY   — host reached, readiness contradicted (HTTP / metadata / version / hash)
 *   2 = usage error
 *   3 = UNVERIFIED  — host never reached, so nothing was observed about what is published.
 *                     Deliberately distinct from 1: "unreachable" is not "serving the wrong file".
 */
const crypto = require('node:crypto');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const base = (arg('base') || '').replace(/\/+$/, '');
const expectedVersion = arg('version');
const localSha = arg('sha256');
// --skip-body exists for a slow link; it is NOT a way to pass without evidence, and it is reported
// loudly in the verdict so a reviewer can see the bytes were not checked.
const skipBody = has('skip-body');

if (!base || !expectedVersion) {
  console.error('usage: verify-agent-distribution.cjs --base <url> --version <x.y.z> [--sha256 <hex>] [--skip-body]');
  process.exit(2);
}

const ROOT = `${base}/api/crm/downloads/writehuman-agent/windows`;
// Every problem carries the CLASS of failure, because the remedies differ and an unreachable host
// is not evidence about what is published. Conflating them printed "this deploy would advertise a
// version the download does not serve" after a proxy denial — asserting something about production
// that the run never observed.
//   TRANSPORT  never reached the host (DNS, TLS, proxy/policy denial, timeout)
//   HTTP       reached it; it answered non-2xx
//   METADATA   got a body; it is not a usable descriptor
//   VERSION    descriptor valid, advertises a DIFFERENT version
//   HASH       bytes served do not match the published sha256/size
const problems = [];
const problem = (kind, message) => problems.push({ kind, message });
const kinds = () => new Set(problems.map(p => p.kind));
const TIMEOUT_MS = Number(process.env.WH_DIST_TIMEOUT_MS || 60000);

/** A transport failure is the request never completing — not completing with bad news. */
function transportDetail(e) {
  const parts = [e && e.message ? e.message : String(e)];
  const c = e && e.cause;
  if (c) {
    if (c.code) parts.push(`code ${c.code}`);
    if (c.message && c.message !== parts[0]) parts.push(c.message);
  }
  return parts.join('; ');
}

/** What a non-object JSON body actually was, for an error an operator can act on. */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a JSON array';
  return `a JSON ${typeof v} (${JSON.stringify(v)})`;
}

// WHY THIS HELPER EXISTS - the Windows exit-code crash.
//
// Measured on Windows (Node 24.14.1): every observed-failure run of this script exited
// 3221226505 (0xC0000409) instead of 1, after printing the correct verdict. The child died in
// libuv during teardown:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// `AbortSignal.timeout(ms)` arms a timer that stays live until it fires, and fetch leaves a
// keep-alive socket behind. Calling process.exit() while those handles are mid-close trips that
// assertion, and Node aborts via __fastfail - so the gate reported a crash code rather than a
// refusal. Anything reading the exit status (CI, a deploy script, the release gate) could not tell
// "the download is wrong" from "the checker broke".
//
// So: an AbortController whose timer is always cleared, `connection: close` so no socket lingers,
// and process.exitCode + a natural return instead of process.exit() mid-teardown.
async function fetchBounded(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ac.signal, headers: { connection: 'close' } });
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  // 1. Published metadata
  let body;
  let fetched = false;
  try {
    const r = await fetchBounded(`${ROOT}/latest.json`);
    if (!r.ok) problem('HTTP', `latest.json returned HTTP ${r.status} — nothing is published at ${ROOT}`);
    else {
      try { body = await r.json(); fetched = true; }
      catch (e) { problem('METADATA', `latest.json is not valid JSON: ${e.message}`); }
    }
  } catch (e) {
    problem('TRANSPORT', `${ROOT}/latest.json could not be reached: ${transportDetail(e)}`);
  }

  // 2. SHAPE AND REQUIRED FIELDS, before anything is trusted.
  //
  // An earlier version put every check AND the download itself behind `if (meta)`. A 200 response
  // whose JSON body was null, false, 0 or "" is falsy, so that branch was skipped entirely: no
  // problem was recorded, the installer was never requested, and the run printed "published and
  // the served bytes match" and exited 0 — even with --sha256 supplied and without --skip-body.
  // Absent evidence must never read as verified evidence, so the shape is now asserted explicitly
  // and each required field is validated on its own.
  let meta = null;
  if (fetched) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      problem('METADATA', `latest.json is ${describe(body)}, not a metadata object — nothing is published `
        + 'here, or the endpoint is returning a placeholder');
    } else {
      meta = body;

      if (typeof meta.version !== 'string' || meta.version.trim() === '') {
        problem('METADATA', 'published latest.json has no usable "version" string');
      } else if (meta.version !== expectedVersion) {
        problem('VERSION', `the download advertises ${JSON.stringify(meta.version)} but this tree would `
          + `advertise ${expectedVersion}. Publish the installer before deploying, or field agents `
          + 'are told to update to a version that is not downloadable.');
      }

      if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.sha256)) {
        problem('METADATA', 'published latest.json has no valid sha256 (64 hex characters) — the download '
          + 'cannot be verified against anything');
      } else if (localSha && meta.sha256.toLowerCase() !== localSha.toLowerCase()) {
        problem('HASH', `the published sha256 (${meta.sha256}) is not the local candidate `
          + `(${localSha}). Same version string, different bytes.`);
      }

      if (!Number.isSafeInteger(meta.size) || meta.size <= 0) {
        problem('METADATA', `published latest.json has no valid "size" (got ${JSON.stringify(meta.size)}) — `
          + 'a positive safe integer is required to detect a truncated download');
      }
    }
  }

  // Only a fully valid descriptor can be checked against bytes. If it is not valid we already have
  // problems recorded, so skipping the download here can never produce a successful verdict.
  const descriptorUsable = meta
    && typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(meta.sha256)
    && Number.isSafeInteger(meta.size) && meta.size > 0;

  // 3. The installer itself. Metadata that matches over a missing or truncated file is the
  //    failure mode that looks healthiest from the outside.
  if (descriptorUsable && !skipBody) {
    try {
      const r = await fetchBounded(`${ROOT}/latest`);
      if (!r.ok) {
        problem('HTTP', `the installer download returned HTTP ${r.status} — latest.json advertises a `
          + 'release whose bytes are not served');
      } else if (!r.body) {
        problem('HTTP', 'the installer download returned no body');
      } else {
        const h = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of r.body) { h.update(chunk); bytes += chunk.length; }
        const digest = h.digest('hex');
        if (digest !== meta.sha256.toLowerCase()) {
          problem('HASH', `the downloaded installer hashes to ${digest} but latest.json advertises `
            + `${meta.sha256} — the served file is not the published release`);
        }
        if (bytes !== meta.size) {
          problem('HASH', `the downloaded installer is ${bytes} bytes but latest.json says ${meta.size}`);
        }
      }
    } catch (e) {
      problem('TRANSPORT', `${ROOT}/latest could not be reached: ${transportDetail(e)}`);
    }
  }

  if (problems.length) {
    const k = kinds();
    // Reached the host and it told us something is wrong => an OBSERVED readiness failure.
    // Never reached it => nothing was observed about what is published. Both block a deploy; only
    // the first licenses any statement about production.
    const observed = k.has('HTTP') || k.has('METADATA') || k.has('VERSION') || k.has('HASH');
    console.error(`[agent-distribution] ${observed ? 'NOT READY' : 'UNVERIFIED'} for ${expectedVersion}:`);
    for (const p of problems) console.error(`  - [${p.kind}] ${p.message}`);

    if (!observed) {
      console.error('\nThe host was never reached, so this run observed NOTHING about what is');
      console.error('published. That is not evidence production serves an older installer, nor that');
      console.error('it serves the right one — distribution readiness is UNKNOWN.');
      console.error('Check DNS, TLS, timeouts and any egress proxy or network policy for this host,');
      console.error('then re-run. Do not publish anything to make this check pass.');
      process.exitCode = 3;   // still non-zero: a deploy must refuse to proceed
      return;
    }

    console.error('\nThis deploy would advertise a version the download does not serve:');
    if (k.has('VERSION'))   console.error('  VERSION mismatch — published metadata names a different release.');
    if (k.has('HASH'))      console.error('  BYTE/HASH mismatch — the served file is not the published release.');
    if (k.has('HTTP'))      console.error('  HTTP failure — the host answered, but not with the artifact.');
    if (k.has('METADATA'))  console.error('  METADATA invalid — the descriptor cannot be trusted.');
    if (k.has('TRANSPORT')) console.error('  (a request also failed in transport; see [TRANSPORT] above)');
    console.error('Publish the installer and its metadata, then re-run this check.');
    process.exitCode = 1;
    return;
  }

  // METADATA-ONLY is a diagnostic, never a readiness verdict. Said in both the wording and the
  // exit path so it cannot be mistaken for a full check in a deploy log.
  if (skipBody) {
    console.log(`[agent-distribution] METADATA ONLY for ${expectedVersion}: latest.json is `
      + 'self-consistent, but --skip-body was passed so the installer BYTES WERE NOT VERIFIED. '
      + 'This is a diagnostic, not distribution readiness, and must not gate a production deploy.');
    return;
  }
  console.log(`[agent-distribution] ${expectedVersion} is published and the served bytes match`);
}

main().catch((e) => { console.error('[agent-distribution] check crashed:', e.message); process.exitCode = 1; });

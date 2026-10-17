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
const problems = [];
const TIMEOUT_MS = Number(process.env.WH_DIST_TIMEOUT_MS || 60000);

async function main() {
  // 1. Published metadata
  let meta = null;
  try {
    const r = await fetch(`${ROOT}/latest.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) problems.push(`latest.json returned HTTP ${r.status} — nothing is published at ${ROOT}`);
    else {
      try { meta = await r.json(); } catch (e) { problems.push(`latest.json is not valid JSON: ${e.message}`); }
    }
  } catch (e) {
    problems.push(`latest.json could not be fetched: ${e.message}`);
  }

  if (meta) {
    if (meta.version !== expectedVersion) {
      problems.push(`the download advertises ${JSON.stringify(meta.version)} but this tree would `
        + `advertise ${expectedVersion}. Publish the installer before deploying, or field agents are `
        + 'told to update to a version that is not downloadable.');
    }
    if (!meta.sha256) problems.push('published latest.json has no sha256 — the download cannot be verified');
    if (localSha && meta.sha256 && meta.sha256 !== localSha) {
      problems.push(`the published sha256 (${meta.sha256}) is not the local candidate `
        + `(${localSha}). Same version string, different bytes.`);
    }
  }

  // 2. The installer itself. Metadata that matches over a missing or truncated file is the
  //    failure mode that looks healthiest from the outside.
  if (meta && meta.sha256 && !skipBody) {
    try {
      const r = await fetch(`${ROOT}/latest`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) {
        problems.push(`the installer download returned HTTP ${r.status} — latest.json advertises a `
          + 'release whose bytes are not served');
      } else {
        const h = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of r.body) { h.update(chunk); bytes += chunk.length; }
        const digest = h.digest('hex');
        if (digest !== meta.sha256) {
          problems.push(`the downloaded installer hashes to ${digest} but latest.json advertises `
            + `${meta.sha256} — the served file is not the published release`);
        }
        if (meta.size !== undefined && meta.size !== null && bytes !== meta.size) {
          problems.push(`the downloaded installer is ${bytes} bytes but latest.json says ${meta.size}`);
        }
      }
    } catch (e) {
      problems.push(`the installer download failed: ${e.message}`);
    }
  }

  if (problems.length) {
    console.error(`[agent-distribution] NOT READY for ${expectedVersion}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nThis deploy would advertise a version the download does not serve.');
    console.error('Publish the installer and its metadata, then re-run this check.');
    process.exit(1);
  }
  console.log(`[agent-distribution] ${expectedVersion} is published and the served bytes match`
    + (skipBody ? ' (METADATA ONLY — --skip-body was passed, the bytes were NOT verified)' : ''));
}

main().catch((e) => { console.error('[agent-distribution] check crashed:', e.message); process.exit(1); });

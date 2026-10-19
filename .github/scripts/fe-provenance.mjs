#!/usr/bin/env node
'use strict';
/**
 * WHAT DOES THE LIVE FRONTEND CONTAIN THAT GIT DOES NOT?
 *
 * The served bundle is main.805c579a.js (556,310 bytes, sha256 5d60643f…) and it matches no
 * committed build on any branch: main has main.020d28e1.js (545,084B), integration/genz-platform-
 * hardening main.182ffee5.js (556,450B), candidate/writehuman-3.5.15-integration and
 * feat/zee-experience-redesign main.00414481.js (556,287B), fix/wh-download-ui-device-state
 * main.12d92313.js (556,371B). Close in size, identical to none.
 *
 * So the live frontend was built from a tree that was never committed — the same divergence already
 * proven for the extension (v3.9.32–3.9.37 built from a non-repository tree) and the gateway. Until
 * the difference is known, deploying any branch's build would overwrite live code of unknown
 * provenance, which is the one thing the recovery brief forbids.
 *
 * This compares the two as sets of string literals. Minified code renames every identifier but
 * leaves user-visible text intact, so a feature present live and absent from the build shows up as
 * its own strings. That is how "Cookie Sync" and "Last Sync" were found in the build while
 * "Auto-Sync" was found in neither.
 *
 * Read-only: public assets and the checked-out ref. Nothing is written to the host.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ORIGIN = process.env.FE_ORIGIN || 'https://genzdigitalstore.com';
const BUILD = 'frontend/build';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const out = [];
const say = (s) => { out.push(s); console.log(s); };

// A literal worth comparing: printable, long enough to be meaningful, and human-looking (contains
// a space, or is a multi-word CamelCase label) — minified identifiers and hashes are excluded.
const LITERAL = /["'`]([\x20-\x7e]{6,120}?)["'`]/g;
const interesting = (s) =>
  !/^[a-z0-9+/=_-]{10,}$/i.test(s) &&          // hashes, ids, base64
  !/^[./]/.test(s) &&                           // paths
  !/^(https?:|data:|#[0-9a-f]{3,8}$)/i.test(s) &&
  !/^[\d\s.,:;%-]+$/.test(s) &&
  // Exclude code. The first pass matched minified fragments, so every "difference" it reported was
  // a renamed identifier rather than a feature; user-visible text contains none of these.
  !/[{}();=<>|&[\]]|=>|\breturn\b|\bconst\b|\bvar\b|\blet\b|\bawait\b|\bfunction\b/.test(s) &&
  !/^\s|\s$/.test(s) &&
  // Human text: a sentence, or a multi-word label.
  (/^[A-Z][A-Za-z]+(\s+[A-Za-z0-9'’,.:%-]+){1,}$/.test(s) || /^[A-Z][a-z]+[A-Z][a-z]+$/.test(s) || / [a-z]+ /.test(s));

const literalsOf = (text) => {
  const set = new Set();
  for (const m of text.matchAll(LITERAL)) {
    const v = m[1].trim();
    if (v && interesting(v)) set.add(v);
  }
  return set;
};

// ── live ──────────────────────────────────────────────────────────────────────────────────────
const liveText = [];
let liveChunks = 0;
{
  const man = await fetch(`${ORIGIN}/asset-manifest.json?cb=${Date.now()}`);
  const j = await man.json();
  const urls = [...new Set(Object.values(j.files || {}).filter((v) => String(v).endsWith('.js')))];
  let failed = 0;
  for (const u of urls) {
    // One transient fetch must not abandon the whole comparison: retry, then record and continue.
    let got = null;
    for (let attempt = 1; attempt <= 3 && !got; attempt += 1) {
      try {
        const r = await fetch(new URL(u, ORIGIN).href);
        if (r.ok) got = Buffer.from(await r.arrayBuffer());
      } catch (_) { /* retry */ }
      if (!got && attempt < 3) await new Promise((res) => setTimeout(res, 400 * attempt));
    }
    if (!got) { failed += 1; continue; }
    liveText.push(got.toString('utf8'));
    liveChunks += 1;
  }
  if (failed) say(`LIVE_FETCH_FAILED chunks=${failed} (comparison is incomplete by that much)`);
  say(`LIVE ${ORIGIN} chunks=${liveChunks} totalBytes=${liveText.reduce((a, t) => a + t.length, 0)}`);
}

// ── the checked-out ref's committed build ─────────────────────────────────────────────────────
const buildText = [];
{
  const dir = path.join(BUILD, 'static', 'js');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : [];
  for (const f of files) buildText.push(fs.readFileSync(path.join(dir, f), 'utf8'));
  const main = files.find((f) => /^main\./.test(f));
  say(`BUILD ref chunks=${files.length} main=${main || 'none'} sha=${main ? sha(fs.readFileSync(path.join(dir, main))).slice(0, 16) : '-'}`);
}

const live = literalsOf(liveText.join('\n'));
const built = literalsOf(buildText.join('\n'));
say(`LITERALS live=${live.size} build=${built.size}`);

const onlyLive = [...live].filter((s) => !built.has(s)).sort();
const onlyBuild = [...built].filter((s) => !live.has(s)).sort();
say(`ONLYLIVE count=${onlyLive.length}`);
for (const s of onlyLive.slice(0, 200)) say(`  L| ${s}`);
say(`ONLYBUILD count=${onlyBuild.length}`);
for (const s of onlyBuild.slice(0, 120)) say(`  B| ${s}`);

// Does anything live look like the panel the operator sees?
const panel = onlyLive.filter((s) => /sync|credential|auto/i.test(s));
say(`PANEL_CANDIDATES ${panel.length ? panel.join(' ~ ').slice(0, 500) : 'none'}`);

fs.writeFileSync(process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/feprov.txt` : 'feprov.txt', out.join('\n') + '\n');
const notice = (t, m) => console.log(`::notice title=${t}::${String(m).slice(0, 420)}`);
notice('prov-summary', out.filter((l) => /^(LIVE|BUILD|LITERALS|ONLYLIVE count|ONLYBUILD count|PANEL_CANDIDATES) /.test(l)).join(' | '));
notice('prov-onlylive', onlyLive.slice(0, 24).join(' ~ ') || 'NOTHING live-only: no user-visible text exists live that the build lacks');
notice('prov-onlybuild', onlyBuild.slice(0, 24).join(' ~ ') || 'NOTHING build-only');

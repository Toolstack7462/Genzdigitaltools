#!/usr/bin/env node
'use strict';
/**
 * LOCATE A FEATURE THAT IS LIVE BUT NOT IN GIT — read-only, public HTTP only.
 *
 * The operator's screenshot shows an admin section "Extension Credential Auto-Sync" reporting
 * "Could not reach the auto-sync API." Searched exhaustively, that text is in NONE of this
 * repository's 14 branches, none of its remote refs, none of the 151 committed files of
 * frontend/build (including every JS chunk that mentions "Extension"), neither tracked extension
 * ZIP, and neither gateway snapshot. The deployed build contains "Cookie Sync" and "Last Sync" but
 * no "Auto-Sync" at all.
 *
 * So the panel is served by code this repository does not have. Three things follow, and this
 * script is here to tell them apart rather than guess:
 *
 *   1. WHICH ROOT. The two member docroots are known to be able to disagree (that is why
 *      resolveServedRelease() deliberately takes the OLDEST of the two). If only one root carries
 *      the panel, the admin is looking at a root that my last frontend deploy did not replace.
 *   2. WHAT IT CALLS. The request URL is the whole point: "Could not reach" is the frontend's own
 *      wording for a failed call, so the path it asks for — and whether the running API answers it
 *      at all — is the difference between a missing route, a wrong prefix and an auth rejection.
 *   3. WHETHER MY DEPLOY WOULD DELETE IT. If the live bundle has a feature git lacks, then
 *      rebuilding from git and deploying it REMOVES that feature. That is the "preserve legitimate
 *      live-only functionality" risk, and it has to be known BEFORE the next frontend release.
 *
 * It downloads public assets and reads them. It sends no credentials, writes nothing to the host,
 * and prints no matched value — only file names, hashes, status codes and endpoint path shapes.
 */
import fs from 'fs';
import crypto from 'crypto';

const ORIGINS = ['https://genzdigitalstore.com', 'https://app.genzdigitalstore.com'];
const API = 'https://api.genzdigitalstore.com';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const out = [];
const say = (s) => { out.push(s); console.log(s); };

// The panel, spelled every way a bundler or a typographer might leave it.
const NEEDLES = [
  ['heading',  /Extension\s*Credential\s*Auto[\s‐-―-]?Sync/i],
  ['errortext',/could not reach the auto[\s‐-―-]?sync/i],
  ['autosync', /auto[‐-―-]?sync/i],
  ['credsync', /credential[\s‐-―-]?sync/i],
];

const get = async (url, asText = true) => {
  const r = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ct: r.headers.get('content-type') || '', buf, text: asText ? buf.toString('utf8') : '' };
};

const seen = {};   // origin -> {main, chunks:Map(name->sha), hits:[]}

for (const origin of ORIGINS) {
  const tag = origin.replace('https://', '');
  seen[tag] = { chunks: new Map(), hits: [], main: null };
  let urls = new Set();

  // Prefer the asset manifest; fall back to scraping index.html, because a root that was deployed
  // by a different pipeline may not have one.
  try {
    const m = await get(`${origin}/asset-manifest.json?cb=${Date.now()}`);
    if (m.status === 200 && m.ct.includes('json')) {
      const j = JSON.parse(m.text);
      for (const v of Object.values(j.files || {})) if (String(v).endsWith('.js')) urls.add(new URL(v, origin).href);
      for (const v of (j.entrypoints || [])) if (String(v).endsWith('.js')) urls.add(new URL('/' + v, origin).href);
      say(`MANIFEST ${tag} status=200 files=${Object.keys(j.files || {}).length}`);
    } else {
      say(`MANIFEST ${tag} status=${m.status} ct=${m.ct.split(';')[0]} (falling back to index.html)`);
    }
  } catch (e) { say(`MANIFEST ${tag} ERROR ${e.message}`); }

  try {
    const idx = await get(`${origin}/?cb=${Date.now()}`);
    say(`INDEX ${tag} status=${idx.status} bytes=${idx.buf.length} sha=${sha(idx.buf).slice(0, 12)}`);
    for (const m of idx.text.matchAll(/(?:src|href)="([^"]+\.js)"/g)) urls.add(new URL(m[1], origin).href);
  } catch (e) { say(`INDEX ${tag} ERROR ${e.message}`); }

  say(`CHUNKS ${tag} discovered=${urls.size}`);

  for (const u of [...urls]) {
    const name = u.split('/').pop().split('?')[0];
    let c;
    try { c = await get(u); } catch (e) { say(`CHUNK ${tag} ${name} ERROR ${e.message}`); continue; }
    if (c.status !== 200) { say(`CHUNK ${tag} ${name} status=${c.status}`); continue; }
    seen[tag].chunks.set(name, sha(c.buf));
    if (/^main\./.test(name)) seen[tag].main = { name, sha: sha(c.buf), size: c.buf.length };

    for (const [label, re] of NEEDLES) {
      const m = re.exec(c.text);
      if (!m) continue;
      // Endpoint path shapes near the hit — the request URL this panel actually asks for.
      const from = Math.max(0, m.index - 3000), to = Math.min(c.text.length, m.index + 3000);
      const paths = [...new Set([...c.text.slice(from, to).matchAll(/["'`](\/(?:api\/)?[a-z0-9][a-z0-9/_:-]{3,60})["'`]/gi)].map((x) => x[1]))];
      seen[tag].hits.push({ label, name, paths });
      say(`HIT ${tag} ${name} needle=${label} paths=${paths.slice(0, 8).join(' ') || 'none-nearby'}`);
    }
  }
  if (!seen[tag].hits.length) say(`NOHIT ${tag} — the served bundles do not contain the panel either`);
  say(`MAIN ${tag} ${seen[tag].main ? `${seen[tag].main.name} ${seen[tag].main.size}B sha=${seen[tag].main.sha.slice(0, 16)}` : 'not-found'}`);
}

// ── do the two roots serve the same frontend, and is it the one in git? ───────────────────────
const [a, b] = ORIGINS.map((o) => seen[o.replace('https://', '')]);
const am = a.main && a.main.sha, bm = b.main && b.main.sha;
say(`ROOTS main-identical=${am && bm ? String(am === bm) : 'unknown'}`);

let committed = null;
try {
  const j = JSON.parse(fs.readFileSync('frontend/build/asset-manifest.json', 'utf8'));
  const rel = String(j.files['main.js'] || '').replace(/^\//, '');
  const buf = fs.readFileSync(`frontend/build/${rel}`);
  committed = { name: rel.split('/').pop(), sha: sha(buf), size: buf.length };
  say(`COMMITTED main ${committed.name} ${committed.size}B sha=${committed.sha.slice(0, 16)}`);
  for (const o of ORIGINS) {
    const t = o.replace('https://', ''), s = seen[t].main;
    say(`MATCH ${t} serves-committed-build=${s ? String(s.sha === committed.sha) : 'unknown'}`);
  }
} catch (e) { say(`COMMITTED ERROR ${e.message}`); }

// ── the running API, through its public surface only ──────────────────────────────────────────
for (const path of ['/health', '/api/health']) {
  try {
    const r = await get(`${API}${path}?cb=${Date.now()}`);
    say(`API ${path} status=${r.status} ct=${(r.ct.split(';')[0])} bytes=${r.buf.length} body=${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  } catch (e) { say(`API ${path} ERROR ${e.message}`); }
}

// ── does the API answer anything auto-sync shaped, and HOW does it refuse? ────────────────────
// Unauthenticated on purpose: 401/403 proves the route EXISTS and is protected, 404 proves it is
// absent, and an HTML body proves a prefix/proxy problem. No credential is sent either way.
const CANDIDATES = [...new Set(
  Object.values(seen).flatMap((v) => v.hits.flatMap((h) => h.paths)).filter((p) => /sync|credential|extension/i.test(p))
)].slice(0, 10);
say(`PROBE candidates=${CANDIDATES.length ? CANDIDATES.join(' ') : 'none'}`);
for (const p of CANDIDATES) {
  const url = `${API}${p.startsWith('/api/') ? p : '/api' + p}`;
  try {
    const r = await get(url);
    say(`PROBE ${p} -> status=${r.status} ct=${r.ct.split(';')[0]} bytes=${r.buf.length} first=${r.text.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (e) { say(`PROBE ${p} ERROR ${e.message}`); }
}

fs.writeFileSync(process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/fe.txt` : 'fe.txt', out.join('\n') + '\n');
const notice = (t, m) => console.log(`::notice title=${t}::${String(m).slice(0, 420)}`);
notice('fe-roots', out.filter((l) => /^(MAIN|ROOTS|MATCH|COMMITTED) /.test(l)).join(' | '));
notice('fe-hits', out.filter((l) => /^(HIT|NOHIT) /.test(l)).join(' | ') || 'no needle matched on either root');
notice('fe-api', out.filter((l) => /^(API|PROBE) /.test(l)).join(' | '));
notice('fe-chunks', out.filter((l) => /^(MANIFEST|CHUNKS|INDEX) /.test(l)).join(' | '));

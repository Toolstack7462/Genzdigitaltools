#!/usr/bin/env node
'use strict';
/**
 * Stamp the production build with a fingerprint of the SOURCE it was built from.
 *
 * Why this exists. This repo deploys the tracked `frontend/build/` directory directly, so the
 * compiled bundle is a committed artifact rather than something the deploy generates. That makes a
 * silent, dangerous failure possible: edit `frontend/src`, commit, deploy — and ship the OLD
 * compiled bundle, because nothing rebuilt it and nothing noticed. The source and the served page
 * disagree, and every symptom points at the backend.
 *
 * A content hash of the build cannot detect this on its own: CRA emits a different chunk hash on
 * many rebuilds, and an out-of-date build is internally consistent, just wrong. So instead we
 * record what the build was made FROM. `frontend/build/build-source.json` carries a SHA-256 over
 * every input that can change the output; a test recomputes it and fails when the two disagree.
 *
 * Run automatically as the `postbuild` step. Never records file contents — only hashes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FRONTEND = path.join(__dirname, '..');
const BUILD = path.join(FRONTEND, 'build');

// Everything whose change should invalidate the build. Kept explicit rather than "the whole
// directory" so an unrelated stray file cannot make the check flap.
const INPUTS = [
  { dir: 'src', match: /\.(js|jsx|ts|tsx|css|scss|json|svg|png|jpg|jpeg|webp|woff2?)$/i },
  { dir: 'public', match: /.*/ },
  { file: 'package.json' },
  { file: 'craco.config.js' },
  { file: 'tailwind.config.js' },
  { file: '.env.production' },
];

function walk(dir, match, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out);
    else if (match.test(e.name)) out.push(p);
  }
  return out;
}

/** Deterministic SHA-256 over (relative path + content) of every build input. */
function fingerprint() {
  const files = [];
  for (const inp of INPUTS) {
    if (inp.dir) walk(path.join(FRONTEND, inp.dir), inp.match, files);
    else {
      const p = path.join(FRONTEND, inp.file);
      if (fs.existsSync(p)) files.push(p);
    }
  }
  const rels = files.map(f => path.relative(FRONTEND, f).split(path.sep).join('/')).sort();
  const h = crypto.createHash('sha256');
  for (const rel of rels) {
    h.update(rel);
    h.update('\0');
    // Normalise line endings: the working copy is CRLF on Windows and LF in git, and a build is
    // not stale merely because it was made on a different platform.
    const buf = fs.readFileSync(path.join(FRONTEND, rel));
    h.update(/\.(js|jsx|ts|tsx|css|scss|json|html|txt|md)$/i.test(rel)
      ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      : buf);
    h.update('\0');
  }
  return { fingerprint: h.digest('hex'), fileCount: rels.length };
}

function main() {
  if (!fs.existsSync(BUILD)) {
    console.error('[stamp-build] no build/ directory — run the build first');
    process.exit(1);
  }
  const { fingerprint: fp, fileCount } = fingerprint();
  const indexHtml = path.join(BUILD, 'index.html');
  let mainBundle = null;
  try {
    const html = fs.readFileSync(indexHtml, 'utf8');
    const m = html.match(/static\/js\/(main\.[a-z0-9]+\.js)/i);
    mainBundle = m ? m[1] : null;
  } catch (_) { /* index.html is checked by the test, not here */ }

  const out = { sourceFingerprint: fp, sourceFileCount: fileCount, mainBundle, stampedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(BUILD, 'build-source.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`[stamp-build] ${fileCount} source files -> ${fp.slice(0, 12)}…  bundle=${mainBundle || 'unknown'}`);
}

if (require.main === module) main();
module.exports = { fingerprint };

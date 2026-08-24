#!/usr/bin/env node
'use strict';
/**
 * Print the complete transitive `require()` closure of the backend, starting at server-crm.js.
 *
 * WHY. Every deploy script in this repo carries a hand-written file list, and every one of them has
 * eventually shipped a file whose new dependency was not on the list — booting Passenger into
 * "Cannot find module" and taking the whole API down. Eight such scripts were found in one audit.
 * A list maintained by hand is the defect; the fix is to stop maintaining one.
 *
 * This computes the list from the code itself, so it cannot go stale: add a require, and the file
 * it points at is shipped by construction. Used by deploy-writehuman-full.sh (the atomic rollout
 * manifest) and by the clean-room test that proves the closure stands up on an empty server.
 *
 * Package requires are excluded — node_modules is installed on the server, not shipped.
 * Output: one repo-relative path per line, `backend/`-prefixed, sorted.
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const ENTRY = process.env.BACKEND_ENTRY || 'server-crm.js';

/** Relative requires of one backend file, resolved to backend-relative paths. */
function localRequires(rel) {
  const abs = path.join(BACKEND, rel);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.resolve(path.dirname(abs), m[1]);
    for (const cand of [target, target + '.js', path.join(target, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        out.push(path.relative(BACKEND, cand).split(path.sep).join('/'));
        break;
      }
    }
  }
  return out;
}

function closure(entry) {
  const seen = new Set();
  const queue = [entry || ENTRY];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of localRequires(f)) if (!seen.has(dep)) queue.push(dep);
  }
  return [...seen].sort();
}

if (require.main === module) {
  for (const f of closure()) console.log(f);
}

module.exports = { closure, localRequires, BACKEND };

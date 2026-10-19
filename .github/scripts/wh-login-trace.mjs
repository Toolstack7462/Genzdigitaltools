#!/usr/bin/env node
'use strict';
/**
 * FIND THE THROW THAT IS BEING REPORTED AS "Extension error".
 *
 * The dashboard shows "Could not open tool: Extension error". That string is a fallback, not a
 * diagnosis. Its chain is:
 *
 *   background.js  catch (error) { return { success: false, error: error.message, ... } }
 *   bridge.js      sanitize() keeps `error` (it is a blocklist, and `error` is not on it)
 *   useExtension   reject(new Error(data.error || 'Extension error'))
 *
 * So "Extension error" means the thrown value had a FALSY .message. `new Error(undefined).message`
 * is the empty string, so any `throw new Error(x)` where x is undefined lands here — and the real
 * stage is destroyed on the way out.
 *
 * This reads the LIVE package, not the repository, because the served background.js is ~173KB
 * against the repo's ~159KB and LoginOrchestrator.js is one of the files that differ. It prints
 * only code: every throw whose argument is not a literal string, and the shape of the login path.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';

const ORIGIN = 'https://genzdigitalstore.com';
const dir = 'extlive';
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const r = await fetch(`${ORIGIN}/downloads/genz-digital-store-extension.zip?cb=${Date.now()}`);
const buf = Buffer.from(await r.arrayBuffer());
fs.writeFileSync('live.zip', buf);
fs.mkdirSync(dir, { recursive: true });
execFileSync('unzip', ['-q', '-o', 'live.zip', '-d', dir]);
const version = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8')).version;
say(`LIVE v${version} bytes=${buf.length}`);

const FILES = ['js/background.js', 'js/core/LoginOrchestrator.js', 'js/bridge.js', 'js/api.js'];

// 1. Every throw that can carry a falsy message.
for (const f of FILES) {
  const p = `${dir}/${f}`;
  if (!fs.existsSync(p)) { say(`MISSING ${f}`); continue; }
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  say(`--- ${f} (${lines.length} lines) ---`);
  lines.forEach((ln, i) => {
    const m = /throw new Error\(([^)]*)\)/.exec(ln);
    if (m) {
      const arg = m[1].trim();
      // A literal string always has a message; anything else might not.
      const literal = /^['"`]/.test(arg);
      if (!literal) say(`  THROW_NONLITERAL ${f}:${i + 1}  new Error(${arg.slice(0, 70)})`);
    }
    if (/throw\s+[^n\s]/.test(ln) && !/throw new /.test(ln)) {
      say(`  THROW_NON_ERROR ${f}:${i + 1}  ${ln.trim().slice(0, 90)}`);
    }
  });
}

// 2. Where the message-less error becomes the user's text.
for (const f of FILES) {
  const p = `${dir}/${f}`;
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    if (/error:\s*error\.message|error:\s*err\.message|error:\s*e\.message/.test(ln)) {
      say(`  MASKS_STAGE ${f}:${i + 1}  ${ln.trim().slice(0, 100)}`);
    }
  });
}

// 3. The login path's own shape: what executeLogin can return or throw.
{
  const p = `${dir}/js/core/LoginOrchestrator.js`;
  if (fs.existsSync(p)) {
    const src = fs.readFileSync(p, 'utf8');
    const lines = src.split('\n');
    say(`--- executeLogin control flow ---`);
    lines.forEach((ln, i) => {
      if (/executeLogin|return\s*\{\s*success|throw |success:\s*false|\.error\b/.test(ln)) {
        const t = ln.trim();
        if (t && !t.startsWith('*') && !t.startsWith('//')) say(`  L${i + 1}: ${t.slice(0, 120)}`);
      }
    });
  }
}

fs.writeFileSync(process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/whlogin.txt` : 'whlogin.txt', out.join('\n') + '\n');
const notice = (t, m) => console.log(`::notice title=${t}::${String(m).slice(0, 420)}`);
notice('throws', out.filter((l) => /THROW_NONLITERAL|THROW_NON_ERROR/.test(l)).slice(0, 10).join(' | ') || 'none');
notice('masks', out.filter((l) => /MASKS_STAGE/.test(l)).join(' | ') || 'none');
notice('version', out.filter((l) => /^LIVE /.test(l)).join(' '));

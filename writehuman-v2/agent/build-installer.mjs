// Build WriteHuman-Agent-Setup-x64.exe from wh-agent-sea.js using Node's built-in SEA.
//
// No external toolchain beyond `postject` (fetched via npx). Produces an UNSIGNED self-contained
// exe - we have no Authenticode certificate, so the build publishes a SHA-256 instead of pretending
// to be signed. Reproducible: same inputs -> same bytes, modulo the node.exe base.
//
//   node build-installer.mjs
//
// Output: dist/WriteHuman-Agent-Setup-x64.exe  +  dist/latest.json (version, sha256, size)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const AGENT_VERSION = (fs.readFileSync(path.join(HERE, 'cookie-sync-agent.js'), 'utf8')
  .match(/AGENT_VERSION\s*=\s*'([^']+)'/) || [])[1] || '0.0.0';
const OUT_EXE = path.join(DIST, 'WriteHuman-Agent-Setup-x64.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

fs.mkdirSync(DIST, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-sea-'));

// SEA config: main bootstrap + the agent carried as an asset (one source of truth).
const cfg = {
  main: path.join(HERE, 'wh-agent-sea.js'),
  output: path.join(tmp, 'sea.blob'),
  disableExperimentalSEAWarning: true,
  assets: { 'cookie-sync-agent.js': path.join(HERE, 'cookie-sync-agent.js') },
};
fs.writeFileSync(path.join(tmp, 'sea-config.json'), JSON.stringify(cfg));

console.log('[build] agent version', AGENT_VERSION);
console.log('[build] generating SEA blob…');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(tmp, 'sea-config.json')], { stdio: 'inherit' });

console.log('[build] copying node runtime…');
fs.copyFileSync(process.execPath, OUT_EXE);

console.log('[build] injecting blob…');
execFileSync('npx', ['--yes', 'postject', OUT_EXE, 'NODE_SEA_BLOB', cfg.output, '--sentinel-fuse', FUSE],
  { stdio: 'inherit', shell: process.platform === 'win32' });

const bytes = fs.readFileSync(OUT_EXE);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const meta = { product: 'WriteHuman Universal Agent', file: 'WriteHuman-Agent-Setup-x64.exe',
  version: AGENT_VERSION, size: bytes.length, sha256, arch: 'x64', signed: false,
  builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(DIST, 'latest.json'), JSON.stringify(meta, null, 2));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[build] done:');
console.log('  ' + OUT_EXE);
console.log('  size   ' + bytes.length + ' bytes');
console.log('  sha256 ' + sha256);

'use strict';
/**
 * DEPLOY WORKFLOW SAFETY PROPERTIES.
 *
 * .github/workflows/deploy-frontend.yml is the only thing that writes to the live web roots. It
 * now authenticates with an SSH key from a protected environment instead of an SFTP password, and
 * these assertions pin the properties that make that safe. They are cheap to keep and the failure
 * they prevent is a silent one: a workflow that still "works" while trusting any host key, or
 * while skipping the gate, looks identical in a green run.
 *
 * Read-only: parses the committed YAML as text. Contacts nothing and deploys nothing.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy-frontend.yml');
const wf = fs.readFileSync(WF, 'utf8');
// A view with comment lines removed. The "must not appear" assertions below run against this,
// because the file deliberately NAMES the dangerous options in prose to explain why they are not
// used — and an assertion that cannot tell a warning from a command is worse than no assertion.
const code = wf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('deploy-frontend.yml: host-key checking is strict and pinned', () => {
  test('host-key verification is never disabled or auto-accepted', () => {
    assert.ok(!/StrictHostKeyChecking\s*=\s*(no|accept-new)/i.test(code),
      'StrictHostKeyChecking must never be no/accept-new — that trusts whatever answers the port');
    assert.ok(!/sftp:auto-confirm\s+yes/.test(code),
      "lftp's sftp:auto-confirm must be off, or lftp accepts an unknown host key itself");
    assert.match(wf, /sftp:auto-confirm no/);
    assert.match(wf, /StrictHostKeyChecking=yes/,
      'the ssh transport must enforce strict host-key checking');
  });

  test('the host key comes from a secret, not from ssh-keyscan against the same host', () => {
    // Scanning the host you are about to trust authenticates nothing: a man in the middle answers
    // the scan too. The pin must come from a trusted channel and be supplied as a secret.
    // Named in prose and in an error message on purpose; what must not exist is an INVOCATION.
    const invokesKeyscan = code.split('\n').some(l =>
      /(^|[;|&(]|\$\()\s*ssh-keyscan\b/.test(l.replace(/"[^"]*"/g, '""')));
    assert.ok(!invokesKeyscan,
      'ssh-keyscan must not be RUN to build known_hosts for a production deploy');
    assert.match(wf, /not from ssh-keyscan/,
      'and the file should say why, so the next editor does not reintroduce it');
    assert.match(wf, /secrets\.HOSTINGER_SSH_KNOWN_HOSTS/,
      'the pinned host key must be supplied as a secret');
    assert.match(wf, /UserKnownHostsFile=\$SSH_DIR\/known_hosts/,
      'ssh must be pointed at the pinned known_hosts, not the runner default');
    assert.match(wf, /ssh-keygen -F/,
      'the workflow must verify the pin actually covers this host:port before connecting');
  });
});

describe('deploy-frontend.yml: credentials are protected and never exposed', () => {
  test('the deploying job runs in the protected production environment', () => {
    const deployIdx = wf.indexOf('build-and-deploy:');
    assert.ok(deployIdx > -1);
    const job = wf.slice(deployIdx, wf.indexOf('- name: Checkout', deployIdx));
    assert.match(job, /environment:\s*production/,
      'the job holding the deploy key must be bound to the protected environment');
  });

  test('the gate job has no environment, so it cannot reach the deploy key', () => {
    const gate = wf.slice(wf.indexOf('  gate:'), wf.indexOf('  build-and-deploy:'));
    assert.ok(!/environment:/.test(gate),
      'the test gate must not be granted the production credentials it has no use for');
    assert.ok(!/secrets\.HOSTINGER_/.test(gate),
      'the gate must not reference the deploy secrets at all');
  });

  test('no step prints a key, writes it into the repo, or uploads it', () => {
    assert.ok(!/upload-artifact/.test(code),
      'this workflow must not upload artifacts — a key or known_hosts file could ride along');
    assert.ok(!/cat\s+.*id_deploy|echo\s+"?\$\{?SSH_PRIVATE_KEY|echo\s+"?\$\{?SSH_PASSPHRASE/.test(wf),
      'a credential must never be echoed or cat-ed');
    // The key is written to the runner temp dir, which is outside the checkout and every web root.
    assert.match(wf, /\$RUNNER_TEMP\/deploy-ssh/,
      'the key must live in RUNNER_TEMP, not in the repository or a deployed directory');
    assert.match(wf, /chmod 600 "\$D\/id_deploy"/);
  });

  test('a missing credential stops the deploy instead of falling back', () => {
    for (const name of ['HOSTINGER_SSH_PRIVATE_KEY', 'HOSTINGER_SSH_KNOWN_HOSTS']) {
      const i = wf.indexOf(`Secret ${name} is not set`);
      assert.ok(i > -1, `a missing ${name} must produce an explicit error`);
    }
    assert.ok(!/SFTP_PASSWORD/.test(wf.split('jobs:')[1] || ''),
      'the password path must be gone from the jobs, not left as a fallback');
  });
});

describe('deploy-frontend.yml: the reviewed release behaviour is preserved', () => {
  test('the test gate still precedes the deploy', () => {
    assert.match(wf, /needs:\s*gate/,
      'build-and-deploy must still depend on the gate job');
    assert.match(wf, /npm run test:ci/, 'the gate must still run the backend suite');
    assert.match(wf, /craco test --watchAll=false/, 'the gate must still run the frontend suite');
  });

  test('both frontend destinations are still deployed, with the app root htaccess preserved', () => {
    assert.match(wf, /MAIN_WEB:/);
    assert.match(wf, /APP_WEB:/);
    assert.match(wf, /mirror_to "main root" "\$MAIN_WEB"/);
    assert.match(wf, /mirror_to "app root" "\$APP_WEB" "--exclude-glob \.htaccess"/,
      "the app subdomain's own .htaccess must never be overwritten");
    assert.ok(!/--delete/.test(code),
      'no --delete: server-only files must survive a deploy');
  });

  test('the extension safeguards are still in place', () => {
    assert.match(wf, /build-extension\.mjs --check/,
      'the committed extension ZIP must still be checked against its manifest');
    assert.match(wf, /extension-live-guard\.mjs/,
      'a newer live extension release must still never be overwritten');
  });

  test('transfers stay bounded and single-connection', () => {
    assert.match(wf, /mirror:parallel-transfer-count 1/);
    assert.match(wf, /mirror:use-pget-n 1/);
    assert.ok(!/--parallel/.test(code), 'parallel mirroring is refused by this host');
    assert.match(wf, /timeout-minutes:/, 'the job must be time-bounded');
  });

  test('a release is never cancelled mid-upload', () => {
    assert.match(wf, /cancel-in-progress:\s*false/,
      'cancelling mid-mirror leaves a web root holding half of two builds');
  });

  test('a rollback point is recorded and a targeted backup is taken before any upload', () => {
    const order = ['Record the current live build', 'Back up the files being replaced',
      'Deploy via SFTP to BOTH web roots'];
    let prev = -1;
    for (const step of order) {
      const i = wf.indexOf(step);
      assert.ok(i > prev, `${step} must come before the upload`);
      prev = i;
    }
    assert.match(wf, /deploy-backups\//,
      'the backup must live outside the public web roots');
    assert.ok(!/tar czf[^\n]*~\/(public_html|domains)/.test(wf),
      'the backup must not be written inside a served directory');
  });

  test('the live verification after deploy still asserts content types, not just status', () => {
    assert.match(wf, /Verify live bundle on both domains/);
    assert.match(wf, /javascript\*\|200:\*ecmascript\*\|200:\*text\/css\*/,
      'the asset check must assert real JS/CSS content types — a SPA fallback can answer 200');
  });
});

/**
 * SHELL SYNTAX OF EVERY `run:` BLOCK.
 *
 * A production-capable workflow step is a shell script that nothing checks until it runs against
 * the live host. One edit to this file left `echo "…continuing.` without its closing quote, which
 * swallowed the REST of that step — including the `ssh-keygen -F` host-key pin verification — into
 * a string literal. The step still exited non-zero for an unrelated reason, so the break was
 * invisible: had the known_hosts secret been present, the pin check would simply not have run.
 *
 * `bash -n` parses without executing, so this is safe and fast. A dependency-free extractor is used
 * because the backend has no YAML parser and this check must not add one.
 */
const { execFileSync } = require('child_process');
const os = require('os');

/** Pull every `run: |`-style block out of a workflow, with its step name for the failure message. */
function runBlocks(yamlText) {
  const lines = yamlText.split('\n');
  const blocks = [];
  let lastName = '<unnamed>';
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(lines[i]);
    if (nameMatch) lastName = nameMatch[1];
    const runMatch = /^(\s*)run:\s*[|>][-+]?\s*$/.exec(lines[i]);
    if (!runMatch) continue;
    const baseIndent = runMatch[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(''); continue; }
      const indent = l.length - l.trimStart().length;
      if (indent <= baseIndent) break;
      body.push(l);
    }
    // Strip the common indentation so bash sees a normal script.
    const indents = body.filter(l => l.trim()).map(l => l.length - l.trimStart().length);
    const strip = indents.length ? Math.min(...indents) : 0;
    blocks.push({ name: lastName, script: body.map(l => l.slice(strip)).join('\n') });
    i = j - 1;
  }
  return blocks;
}

describe('every workflow run: block is valid shell', () => {
  const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows');

  for (const file of fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f))) {
    test(`${file}: all run blocks parse under bash -n`, () => {
      const blocks = runBlocks(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));
      assert.ok(blocks.length > 0, `expected to find run: blocks in ${file}`);
      const failures = [];
      for (const b of blocks) {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sh-')), 'step.sh');
        fs.writeFileSync(tmp, b.script);
        try {
          execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
        } catch (e) {
          failures.push(`${b.name}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
        } finally {
          fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
        }
      }
      assert.deepEqual(failures, [],
        `shell syntax errors in ${file} — these steps would misbehave or silently skip commands`);
    });
  }

  test('the extractor really does find the deploy workflow steps it must cover', () => {
    // Guards against the extractor silently matching nothing, which would make the test vacuous.
    const blocks = runBlocks(fs.readFileSync(path.join(WORKFLOWS, 'deploy-frontend.yml'), 'utf8'));
    const names = blocks.map(b => b.name);
    for (const required of ['Install deploy key and PINNED host key',
      'Back up the files being replaced', 'Deploy via SFTP to BOTH web roots']) {
      assert.ok(names.includes(required), `extractor missed the "${required}" step`);
    }
    // Self-consistent rather than an arbitrary floor: every `run: |` in the file must be found.
    // Single-line `run: cmd` steps are intentionally not extracted — there is no multi-line script
    // to mis-parse — so they are excluded from the count too.
    const src = fs.readFileSync(path.join(WORKFLOWS, 'deploy-frontend.yml'), 'utf8');
    const declared = (src.match(/^\s*run:\s*[|>][-+]?\s*$/gm) || []).length;
    assert.equal(blocks.length, declared,
      `extractor found ${blocks.length} multi-line run blocks but the file declares ${declared}`);
    assert.ok(declared > 0, 'the deploy workflow must have multi-line run blocks to check');
  });

  test('an unterminated string IS caught (the defect this test exists for)', () => {
    const broken = 'echo "unterminated\nssh-keygen -F host -f kh || exit 1\n';
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-neg-')), 'step.sh');
    fs.writeFileSync(tmp, broken);
    assert.throws(() => execFileSync('bash', ['-n', tmp], { stdio: 'pipe' }),
      'bash -n must reject an unterminated string, or this whole check proves nothing');
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });
});

/**
 * SCRIPT INJECTION VIA WORKFLOW EXPRESSIONS.
 *
 * `${{ inputs.x }}` or `${{ github.event.* }}` pasted inside a `run:` block is substituted as TEXT
 * before the shell sees it, so a crafted value executes as a command in the job — which here is the
 * job holding the production deploy key. The safe form is to pass the value through `env:` and
 * reference it as "$VAR", which the shell treats as data.
 *
 * I introduced exactly this defect while writing the diagnostics workflow, so it is now asserted
 * across every workflow rather than remembered.
 */
describe('no workflow interpolates untrusted input into a shell block', () => {
  const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows');
  // `inputs.*` and `github.event.*` are attacker-influenceable; `secrets.*` and static `env`/`vars`
  // are not, and secrets must be passed via env anyway (asserted separately above).
  const UNSAFE = /\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)/;

  for (const file of fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f))) {
    test(`${file}: run blocks contain no untrusted expression interpolation`, () => {
      const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
      const offenders = runBlocks(text)
        .filter(b => UNSAFE.test(b.script))
        .map(b => b.name);
      assert.deepEqual(offenders, [],
        'pass the value through env: and reference it as "$VAR" instead — interpolating it into the '
        + 'script lets a crafted input run commands in a job that holds deploy credentials');
    });
  }

  test('the guard is real: it flags an interpolated input', () => {
    const sample = '- name: bad\n  run: |\n    echo "${{ inputs.note }}"\n';
    const blocks = runBlocks(sample);
    assert.equal(blocks.length, 1, 'extractor must find the sample block');
    assert.ok(UNSAFE.test(blocks[0].script), 'the pattern must match an interpolated input');
  });
});

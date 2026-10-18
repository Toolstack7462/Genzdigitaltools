'use strict';
/**
 * ROLLBACK RESTORE SEMANTICS: `git checkout <ref> -- <path>` does NOT roll a directory back.
 *
 * docs/DEPLOY-AND-ROLLBACK.md previously documented
 *     git checkout <rollback-ref> -- frontend/
 * as the way to restore the frontend while keeping the current workflows. That command uses OVERLAY
 * semantics: it writes the files the ref has, and LEAVES every tracked file the ref does not have.
 * Applied to this repository it left 182 candidate-only files in place — new hashed bundle chunks
 * among them — so the "rolled back" docroot would be a mixture of two builds, and `mirror -R`
 * would upload both sets.
 *
 * `git restore --source=<ref> --staged --worktree -- <path>` is non-overlay: files absent from the
 * source are deleted from the index and the working tree, so the result equals the source exactly.
 *
 * These tests build a tiny throwaway repository in a temp directory and demonstrate both, so the
 * difference is pinned by behaviour rather than by a claim in a comment. Nothing here touches this
 * repository, its history, its working tree or any remote.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-restore-'));
  const git = (args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git(['init', '-q', '-b', 'main']);

  // The "old" state: two frontend files and one protected file outside frontend/.
  fs.mkdirSync(path.join(dir, 'frontend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'src', 'app.js'), 'old app\n');
  fs.writeFileSync(path.join(dir, 'frontend', 'src', 'removed-later.js'), 'present in old\n');
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'gate: original\n');
  git(['add', '-A']); git(['commit', '-qm', 'old state']);
  const OLD = git(['rev-parse', 'HEAD']).trim();

  // The "candidate": changes a file, ADDS a tracked file, DELETES one, and edits the workflow.
  fs.writeFileSync(path.join(dir, 'frontend', 'src', 'app.js'), 'new app\n');
  fs.writeFileSync(path.join(dir, 'frontend', 'src', 'candidate-only.js'), 'added by candidate\n');
  fs.unlinkSync(path.join(dir, 'frontend', 'src', 'removed-later.js'));
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'gate: added by candidate\n');
  git(['add', '-A']); git(['commit', '-qm', 'candidate']);

  return { dir, git, OLD };
}

/** Tracked paths under frontend/ that differ from `ref` — the assertion the procedure must make. */
const frontendDiff = (git, ref) =>
  git(['diff', '--name-only', ref, '--', 'frontend/']).split('\n').filter(Boolean);

describe('git checkout <ref> -- <path> is an overlay and cannot roll back a directory', () => {
  test('it leaves candidate-only tracked files behind, and does not restore deletions', () => {
    const { dir, git, OLD } = makeRepo();
    try {
      git(['checkout', OLD, '--', 'frontend/']);
      assert.ok(fs.existsSync(path.join(dir, 'frontend', 'src', 'candidate-only.js')),
        'the overlay form must be shown LEAVING the candidate-only file — if this ever fails, '
        + "git's semantics changed and the documented procedure can be revisited");
      assert.notDeepEqual(frontendDiff(git, OLD), [],
        'so the frontend tree does NOT equal the rollback target');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('git restore --source=<ref> --staged --worktree is the correct restore', () => {
  test('the restored tree equals the target exactly, including deletions', () => {
    const { dir, git, OLD } = makeRepo();
    try {
      git(['restore', `--source=${OLD}`, '--staged', '--worktree', '--', 'frontend/']);

      // Assertion 1: candidate-only file gone, deleted file back, content reverted.
      assert.ok(!fs.existsSync(path.join(dir, 'frontend', 'src', 'candidate-only.js')),
        'a candidate-only tracked file must be REMOVED, not retained');
      assert.ok(fs.existsSync(path.join(dir, 'frontend', 'src', 'removed-later.js')),
        'a file the candidate deleted must be restored');
      assert.equal(fs.readFileSync(path.join(dir, 'frontend', 'src', 'app.js'), 'utf8'), 'old app\n');

      // Assertion 2: worktree AND index both match the target across frontend/.
      assert.deepEqual(frontendDiff(git, OLD), [],
        'the tracked frontend tree must match the target with zero differences');
      assert.deepEqual(
        git(['diff', '--cached', '--name-only', OLD, '--', 'frontend/']).split('\n').filter(Boolean),
        [], 'the INDEX must match too — --staged is what makes the commit correct');

      // Assertion 3: files outside frontend/ are untouched. This is the whole point of restoring
      // content rather than reverting the merge, which would delete the workflow gate.
      assert.equal(fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8'),
        'gate: added by candidate\n',
        'the safety files outside the restored path must survive the rollback');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('it does not require a blanket clean, and leaves untracked work alone', () => {
    const { dir, git, OLD } = makeRepo();
    try {
      const scratch = path.join(dir, 'frontend', 'src', 'UNCOMMITTED-WORK.js');
      fs.writeFileSync(scratch, 'not staged, not committed\n');
      git(['restore', `--source=${OLD}`, '--staged', '--worktree', '--', 'frontend/']);
      assert.ok(fs.existsSync(scratch),
        'an untracked file must survive: the procedure must never prescribe a blanket git clean');
      // It is untracked, so it does not make the TRACKED tree differ from the target.
      assert.deepEqual(frontendDiff(git, OLD), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the documented procedure matches what these tests prove', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'writehuman-v2', 'docs', 'DEPLOY-AND-ROLLBACK.md'), 'utf8');

  test('it prescribes the non-overlay restore, not the overlay checkout', () => {
    assert.match(doc, /git restore --source=/,
      'the document must prescribe git restore --source=');
    assert.match(doc, /--staged --worktree/,
      'both the index and the working tree must be restored');
    // The overlay form may still be NAMED, as the warning explaining why it is wrong. What it must
    // never be is PRESCRIBED — so it must not appear inside a fenced block an operator can copy.
    const fenced = doc.split('\n```').filter((_, i) => i % 2 === 1).join('\n');
    assert.ok(!/git checkout \S+ -- frontend\//.test(fenced),
      'the overlay form must not appear in a runnable code block — naming it in prose is fine, '
      + 'offering it as a command is the defect');
    assert.match(doc, /git checkout <ref> -- frontend\/.{0,40}DOES NOT WORK/s,
      'and the document must say explicitly that the overlay form does not work here');
  });

  test('it requires a tree-equality assertion and rejects filename-only proof', () => {
    assert.match(doc, /git diff --quiet/,
      'the document must require an explicit tree-equality check before rebuilding');
    assert.match(doc, /including deletions|incl\. deletions/i);
    assert.match(doc, /filename.{0,60}(proves|is not proof|not proof)/i,
      'the document must state that a matching bundle filename proves nothing');
  });

  test('it does not tell the operator to run a blanket clean', () => {
    assert.ok(!/git clean -[a-z]*d[a-z]*f|git clean -[a-z]*f[a-z]*d/.test(doc),
      'a blanket git clean would destroy uncommitted work and must not be prescribed');
  });
});

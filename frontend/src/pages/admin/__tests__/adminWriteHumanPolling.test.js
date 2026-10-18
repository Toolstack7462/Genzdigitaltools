// ADMIN → WRITEHUMAN: the dashboard poll must not cost the shared host more than it has to.
//
// Three gaps this pins, all of which were present in the deployed page:
//   * no visibility gating — a parked admin tab polled for as long as it was open;
//   * no overlap protection across the whole async group — setInterval fired every 30s whether or
//     not the previous loadState + loadLogs had finished, so ticks piled up exactly when the
//     database was slow;
//   * no backoff — a failing endpoint was re-asked on the same cadence indefinitely.
//
// SCOPE. A source-contract test. The behavioural guarantees it depends on (gating, paired-event
// dedupe, one-group-at-a-time, bounded backoff, listener cleanup) are tested against the real
// implementation in lib/__tests__/visiblePolling.test.js — 20 tests. Live admin verification is
// tracked separately and is NOT claimed here.
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'AdminWriteHuman.js'), 'utf8');

describe('the 30s dashboard poll uses the tested utility', () => {
  test('it polls through startVisiblePolling, not a bare setInterval', () => {
    expect(SRC).toMatch(/import startVisiblePolling from '\.\.\/\.\.\/lib\/visiblePolling'/);
    expect(SRC).toMatch(/startVisiblePolling\(tick, 30000/);
  });

  test('the 30s cadence and the ~90s log cadence are unchanged', () => {
    expect(SRC).toMatch(/startVisiblePolling\(tick, 30000/);
    expect(SRC).toMatch(/logTick\.current % 3 === 0/);
  });

  test('the initial load still runs immediately — the helper only schedules', () => {
    expect(SRC).toMatch(/tick\(\);\s*\/\/ initial load, unchanged/);
  });

  test('the poll group awaits EVERY request it issued, so non-overlap is real', () => {
    // The helper treats the returned promise as one group. A promise that settles on the first of
    // several requests would release the guard while the rest are still outstanding.
    expect(SRC).toMatch(/const jobs = \[loadState\(\)\]/);
    expect(SRC).toMatch(/jobs\.push\(loadLogs\(\)\)/);
    expect(SRC).toMatch(/await Promise\.all\(jobs\)/);
  });

  test('backoff is opted into with a bounded cap', () => {
    const m = /maxBackoffSteps: (\d+)/.exec(SRC);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(0);
    expect(Number(m[1])).toBeLessThanOrEqual(5);
  });

  test('the effect releases the poll on unmount', () => {
    expect(SRC).toMatch(/return \(\) => \{ alive = false; stop\(\); \}/);
  });

  test('no bare setInterval remains for the dashboard poll', () => {
    // The only interval left is the activation progress poll, which is deliberately ungated.
    const intervals = SRC.match(/setInterval\(/g) || [];
    expect(intervals.length).toBe(1);
    expect(SRC).toMatch(/actTimer\.current = setInterval\(poll, 3000\)/);
  });
});

describe('the activation progress poll stays timely but cannot stack', () => {
  test('it is NOT visibility-gated — progress must be current on return', () => {
    const start = SRC.indexOf('const activationInFlight');
    const block = SRC.slice(start, SRC.indexOf('const revokeDevice', start));
    expect(block).not.toMatch(/startVisiblePolling/);
    expect(block).toMatch(/NOT visibility-gated, on purpose/);
  });

  test('it guards against overlap, which matters most at a 3s cadence', () => {
    const start = SRC.indexOf('const activationInFlight');
    const block = SRC.slice(start, SRC.indexOf('const revokeDevice', start));
    expect(block).toMatch(/let busy = false/);
    expect(block).toMatch(/if \(busy \|\| !alive\) return/);
    expect(block).toMatch(/finally \{ busy = false; \}/);
    // The trailing full-state refresh must be inside the group, or the guard releases early.
    expect(block).toMatch(/await loadState\(\)/);
  });

  test('it still stops at a terminal stage and clears its timer', () => {
    expect(SRC).toMatch(/if \(!activationInFlight\)/);
    expect(SRC).toMatch(/clearInterval\(actTimer\.current\)/);
  });
});

describe('nothing else about the page changed', () => {
  test('deliberate Refresh is still immediate and unconditional', () => {
    expect(SRC).toMatch(/loadState/);
    // No gating helper wrapped around the manual refresh path.
    expect(SRC).not.toMatch(/startVisiblePolling\(\s*loadState/);
  });

  test('presence, security and recovery call sites were not touched by this change', () => {
    // These strings exist elsewhere in the page; their presence proves the edit was scoped to the
    // two polling effects rather than rewriting the component.
    for (const anchor of ['revokeDevice', 'writeHumanV2Admin']) {
      expect(SRC).toMatch(new RegExp(anchor));
    }
  });
});

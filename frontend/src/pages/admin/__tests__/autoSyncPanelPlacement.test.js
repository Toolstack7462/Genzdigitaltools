// ADMIN → WRITEHUMAN: the Extension Credential Auto-Sync panel's POSITION and SINGULARITY.
//
// Two things were wrong on the real page, and neither is detectable by a unit test of the panel's
// own logic:
//   * it was mounted at the very bottom of the component, AFTER the Live logs card and OUTSIDE the
//     post-first-load fragment, so it rendered below the log stream instead of between the
//     Actions/health sections and Live logs;
//   * it was absent from the released interface entirely — `release/frontend-owner-fix`, the branch
//     that built the live bundle main.0641f2d0.js, has neither the import nor the mount.
//
// SCOPE — stated plainly. This is a SOURCE-CONTRACT test, matching the existing convention for this
// page (see adminWriteHumanPolling.test.js and adminNavReachability.test.js, both fs-based). This
// repo has no React render harness installed — no @testing-library/react, no react-test-renderer —
// and adding one to satisfy a layout assertion would be a dependency change to the production build
// pipeline for a fact that document ORDER in the source already determines: the panel and the Live
// logs card are siblings in one JSX fragment, so their source order IS their render order.
// A real rendered-DOM assertion and live acceptance on the deployed page are tracked separately and
// are NOT claimed here.
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'AdminWriteHuman.js'), 'utf8');

const MOUNT = /<WriteHumanAutoSync\s*\/>/g;

describe('the Auto-Sync panel exists exactly once', () => {
  test('one import and one mount — never a second panel', () => {
    expect(SRC.match(/import WriteHumanAutoSync from '\.\/WriteHumanAutoSync'/g) || []).toHaveLength(1);
    expect(SRC.match(MOUNT) || []).toHaveLength(1);
  });

  test('the page does not define a competing inline auto-sync section', () => {
    // The heading text belongs to WriteHumanAutoSync.js. If it appears in the page too, the panel
    // has been duplicated by hand rather than reused.
    expect(SRC).not.toMatch(/Extension Credential Auto-Sync<\/h2>/);
  });
});

describe('the panel renders directly ABOVE Live logs', () => {
  test('its mount precedes the Live logs card in source order', () => {
    const mountAt = SRC.search(MOUNT);
    const liveLogsAt = SRC.indexOf('{/* Live logs */}');
    expect(mountAt).toBeGreaterThan(-1);
    expect(liveLogsAt).toBeGreaterThan(-1);
    expect(mountAt).toBeLessThan(liveLogsAt);
  });

  test('nothing but whitespace and comments separates it from the Live logs card', () => {
    const mountAt = SRC.search(MOUNT);
    const liveLogsAt = SRC.indexOf('{/* Live logs */}');
    const between = SRC.slice(mountAt, liveLogsAt).replace(/<WriteHumanAutoSync\s*\/>/, '');
    // No other JSX element may sit between the two — "directly above" is the requirement.
    expect(between).not.toMatch(/<[A-Za-z]/);
  });

  test('it sits AFTER the status/health/actions sections, not above them', () => {
    const mountAt = SRC.search(MOUNT);
    // The six-stat status grid and the alerts Panel both belong above it.
    const statusGrid = SRC.indexOf('grid grid-cols-2 lg:grid-cols-6');
    expect(statusGrid).toBeGreaterThan(-1);
    expect(statusGrid).toBeLessThan(mountAt);
  });
});

describe('the panel is a sibling of Live logs, not conditionally hidden', () => {
  test('its mount carries no condition of its own', () => {
    const line = SRC.split('\n').find((l) => MOUNT.test(l));
    MOUNT.lastIndex = 0;
    expect(line).toBeTruthy();
    // e.g. `{policy && <WriteHumanAutoSync />}` or a ternary would make the section vanish on an
    // API failure or a missing policy, which is exactly what must not happen.
    expect(line.trim()).toBe('<WriteHumanAutoSync />');
  });

  test('the panel is inside the same post-first-load fragment as Live logs', () => {
    // Both must be in the branch that renders once the page has loaded; if the panel were outside
    // it, it would drift back below the fragment and under Live logs again.
    const fragmentAt = SRC.indexOf('{firstLoad ? (');
    const mountAt = SRC.search(MOUNT);
    const liveLogsAt = SRC.indexOf('{/* Live logs */}');
    expect(fragmentAt).toBeGreaterThan(-1);
    expect(fragmentAt).toBeLessThan(mountAt);
    expect(mountAt).toBeLessThan(liveLogsAt);
  });
});

describe('the panel talks to the real policy API through the existing service', () => {
  const PANEL = fs.readFileSync(path.join(__dirname, '..', 'WriteHumanAutoSync.js'), 'utf8');
  const SERVICE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services', 'writeHumanV2Service.js'), 'utf8');

  test('it uses writeHumanV2Admin, not its own fetch or a second endpoint', () => {
    expect(PANEL).toMatch(/writeHumanV2Admin/);
    expect(PANEL).not.toMatch(/\bfetch\(/);
    expect(PANEL).not.toMatch(/axios\./);
  });

  test('the service points at the effective mount /admin/proxy-tools/<tool>/extension-autosync', () => {
    expect(SERVICE).toMatch(/\/admin\/proxy-tools\/\$\{TOOL\}\/extension-autosync/);
    expect(SERVICE).toMatch(/getAutoSync/);
    expect(SERVICE).toMatch(/setAutoSync/);
  });

  test('writes go through the CSRF retry wrapper', () => {
    expect(PANEL).toMatch(/withCsrfRetry/);
  });

  test('the supported controls are all still present', () => {
    for (const label of [
      'Refresh Status', 'Enable (Observe)', 'Pause / Disable',
      'Approve this account', 'Switch to Enforce', 'Back to Observe',
      'Save target', 'Clear selection',
    ]) {
      expect(PANEL).toContain(label);
    }
  });

  test('a failed read keeps the panel and does not blank the policy', () => {
    // The catch must not setData(null): that would turn an unknown state into writable empties.
    expect(PANEL).toMatch(/a failed read must not fabricate empty settings/);
  });
});

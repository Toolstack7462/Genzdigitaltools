// ZEE MUST NOT CLAIM A CHECK IT DID NOT MAKE.
//
// The shipped provider classified extension status with a function that returned a problem code or
// `null`, and `null` was then read as "all good":
//
//     if (!status) return null;              // the bridge has not answered
//     if (ei) return startIssueByCode(ei);
//     // else -> flow EXTENSION_OK, "Your extension is installed and connected."
//
// So an unknown status produced a confident, false reassurance — and `recheck-extension` reported
// "Your extension is connected now." on the same basis. These tests pin the five-way answer that
// replaces it: UNKNOWN is its own outcome and only a POSITIVE reading yields 'ok'.
import { extensionStatusKind, extensionIssueCode, EXT_KIND } from '../extensionStatusKind';
import { ISSUE } from '../diagnosticFlows';

describe('unknown status is never mistaken for a healthy extension', () => {
  test('no status object at all is UNKNOWN', () => {
    for (const s of [undefined, null, false, 0, '', 'ok', 42]) {
      expect(extensionStatusKind(s)).toBe(EXT_KIND.UNKNOWN);
    }
  });

  test('a status with no `installed` field is UNKNOWN, not ok', () => {
    // The exact shape that produced "Your extension looks good": nothing is false, so the old
    // code found no issue and reassured the client.
    expect(extensionStatusKind({})).toBe(EXT_KIND.UNKNOWN);
    expect(extensionStatusKind({ connected: true })).toBe(EXT_KIND.UNKNOWN);
    expect(extensionStatusKind({ version: '3.9.25' })).toBe(EXT_KIND.UNKNOWN);
  });

  test('a non-boolean `installed` is UNKNOWN', () => {
    for (const v of ['true', 1, 0, null, undefined, {}]) {
      expect(extensionStatusKind({ installed: v, connected: true })).toBe(EXT_KIND.UNKNOWN);
    }
  });

  test('installed with NO connected reading is UNKNOWN, not ok', () => {
    // We know it is installed; we do not know it can talk to the page. That is not a clean bill
    // of health, and claiming it would be the same defect in a narrower form.
    expect(extensionStatusKind({ installed: true })).toBe(EXT_KIND.UNKNOWN);
    expect(extensionStatusKind({ installed: true, connected: null })).toBe(EXT_KIND.UNKNOWN);
    expect(extensionStatusKind({ installed: true, connected: 'yes' })).toBe(EXT_KIND.UNKNOWN);
  });

  test("'ok' requires installed === true AND connected === true", () => {
    expect(extensionStatusKind({ installed: true, connected: true })).toBe(EXT_KIND.OK);
  });
});

describe('real problems are still classified exactly as before', () => {
  test('not installed', () => {
    expect(extensionStatusKind({ installed: false })).toBe(EXT_KIND.MISSING);
    expect(extensionStatusKind({ installed: false, connected: true })).toBe(EXT_KIND.MISSING);
  });

  test('outdated, from either field', () => {
    expect(extensionStatusKind({ installed: true, isOutdated: true, connected: true })).toBe(EXT_KIND.OUTDATED);
    expect(extensionStatusKind({ installed: true, updateAvailable: true, connected: true })).toBe(EXT_KIND.OUTDATED);
  });

  test('outdated outranks disconnected — update first, it may be the cause', () => {
    expect(extensionStatusKind({ installed: true, isOutdated: true, connected: false })).toBe(EXT_KIND.OUTDATED);
  });

  test('installed but disconnected', () => {
    expect(extensionStatusKind({ installed: true, connected: false })).toBe(EXT_KIND.DISCONNECTED);
  });

  test('a truthy-but-not-true staleness flag does not fabricate OUTDATED', () => {
    // Only an explicit true is a reading. 'maybe' is not.
    expect(extensionStatusKind({ installed: true, isOutdated: 'maybe', connected: true })).toBe(EXT_KIND.OK);
  });
});

describe('issue codes map to the existing flows, and non-problems map to nothing', () => {
  test('each problem kind yields its existing ISSUE code', () => {
    expect(extensionIssueCode({ installed: false })).toBe(ISSUE.EXTENSION_MISSING);
    expect(extensionIssueCode({ installed: true, isOutdated: true })).toBe(ISSUE.EXTENSION_OUTDATED);
    expect(extensionIssueCode({ installed: true, connected: false })).toBe(ISSUE.EXTENSION_DISCONNECTED);
  });

  test('ok and unknown produce NO issue code — they are not problems to diagnose', () => {
    expect(extensionIssueCode({ installed: true, connected: true })).toBeNull();
    expect(extensionIssueCode(null)).toBeNull();
    expect(extensionIssueCode({})).toBeNull();
  });

  test('but ok and unknown are DISTINGUISHABLE, which is the whole point', () => {
    // Both give a null issue code, so a caller that only looks at the code cannot tell them apart —
    // that is precisely how the old reassurance bug happened. The kind must be consulted.
    expect(extensionStatusKind({ installed: true, connected: true }))
      .not.toBe(extensionStatusKind(null));
  });
});

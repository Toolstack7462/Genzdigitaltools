// Three chips instead of six permanent buttons — without losing a single topic.
//
// The panel showed all six quick actions as a fixed stack (~290px of 44px buttons) that never
// reflected the client's situation. These tests pin the two properties that make the replacement
// safe: the top three come from REAL state, and everything else stays reachable under More help.
import { rankQuickActions, groupRest, ALL_ACTIONS, GROUP_ORDER, TOP_N } from '../quickActionRanking';
import { EXT_KIND } from '../extensionStatusKind';
import { INTENTS } from '../assistantIntents';
import { ISSUE } from '../diagnosticFlows';

const ids = (list) => list.map((a) => a.id);

describe('nothing becomes unreachable', () => {
  test('top + rest is always exactly ALL_ACTIONS, with no duplicates', () => {
    const contexts = [
      {}, { extensionKind: EXT_KIND.OK }, { extensionKind: EXT_KIND.UNKNOWN },
      { extensionKind: EXT_KIND.MISSING }, { extensionKind: EXT_KIND.OUTDATED },
      { extensionKind: EXT_KIND.DISCONNECTED },
      { lastIssueCode: ISSUE.ASSIGNMENT_EXPIRED },
      { lastIssueCode: ISSUE.NETWORK_ERROR, extensionKind: EXT_KIND.MISSING },
      { lastIssueCode: 'NOT_AN_ENTRY_POINT' },
    ];
    for (const ctx of contexts) {
      const { top, rest } = rankQuickActions(ctx);
      const all = [...ids(top), ...ids(rest)].sort();
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(ids(ALL_ACTIONS).sort());
    }
  });

  test('every diagnostic flow and every intent has an entry point', () => {
    const issues = new Set(ALL_ACTIONS.filter((a) => a.issue).map((a) => a.issue));
    for (const code of [ISSUE.TOOL_NOT_ASSIGNED, ISSUE.ASSIGNMENT_INACTIVE, ISSUE.ASSIGNMENT_EXPIRED,
      ISSUE.SUBSCRIPTION_EXPIRED, ISSUE.EXTENSION_MISSING, ISSUE.EXTENSION_OUTDATED,
      ISSUE.EXTENSION_DISCONNECTED, ISSUE.SESSION_EXPIRED, ISSUE.NETWORK_ERROR,
      ISSUE.UNKNOWN_CLIENT_ISSUE]) {
      expect(issues.has(code)).toBe(true);
    }
    const intents = new Set(ALL_ACTIONS.filter((a) => a.intent).map((a) => a.intent));
    for (const i of Object.values(INTENTS)) expect(intents.has(i)).toBe(true);
  });

  test('top never exceeds three', () => {
    for (const ctx of [{}, { extensionKind: EXT_KIND.MISSING, lastIssueCode: ISSUE.NETWORK_ERROR }]) {
      expect(rankQuickActions(ctx).top.length).toBe(TOP_N);
    }
  });
});

describe('the top three follow real state', () => {
  test('with no signals, a sensible default trio', () => {
    expect(ids(rankQuickActions({}).top)).toEqual(['TOOL_NOT_OPENING', 'EXTENSION', 'EXPIRED']);
  });

  test("the client's most recent real failure leads", () => {
    const { top } = rankQuickActions({ lastIssueCode: ISSUE.ASSIGNMENT_EXPIRED });
    expect(ids(top)[0]).toBe('ASSIGNMENT_EXPIRED');
  });

  test('a live extension problem surfaces its own specific flow', () => {
    expect(ids(rankQuickActions({ extensionKind: EXT_KIND.MISSING }).top)).toContain('EXTENSION_MISSING');
    expect(ids(rankQuickActions({ extensionKind: EXT_KIND.OUTDATED }).top)).toContain('EXTENSION_OUTDATED');
    expect(ids(rankQuickActions({ extensionKind: EXT_KIND.DISCONNECTED }).top)).toContain('EXTENSION_DISCONNECTED');
  });

  test('UNKNOWN extension status promotes the ASKING entry, not a specific problem', () => {
    // Promoting EXTENSION_DISCONNECTED here would assert a fault we have not observed.
    const { top } = rankQuickActions({ extensionKind: EXT_KIND.UNKNOWN });
    expect(ids(top)).toContain('EXTENSION');
    for (const asserted of ['EXTENSION_MISSING', 'EXTENSION_OUTDATED', 'EXTENSION_DISCONNECTED']) {
      expect(ids(top)).not.toContain(asserted);
    }
  });

  test('a healthy extension is NOT a reason to lead with the extension', () => {
    const { top } = rankQuickActions({ extensionKind: EXT_KIND.OK });
    expect(ids(top)).toEqual(['TOOL_NOT_OPENING', 'EXTENSION', 'EXPIRED']);
  });

  test('both signals together: the failure first, then the extension', () => {
    const { top } = rankQuickActions({ lastIssueCode: ISSUE.NETWORK_ERROR, extensionKind: EXT_KIND.DISCONNECTED });
    expect(ids(top)[0]).toBe('NETWORK_ERROR');
    expect(ids(top)).toContain('EXTENSION_DISCONNECTED');
  });

  test('an unrecognised lastIssueCode is ignored rather than breaking the trio', () => {
    expect(ids(rankQuickActions({ lastIssueCode: 'SOMETHING_ELSE_ENTIRELY' }).top))
      .toEqual(['TOOL_NOT_OPENING', 'EXTENSION', 'EXPIRED']);
  });
});

describe('More help is grouped and stable', () => {
  test('groups appear in the declared order and hold only remaining items', () => {
    const { top, rest } = rankQuickActions({});
    const groups = groupRest(rest);
    expect(groups.map((g) => g.group)).toEqual(
      GROUP_ORDER.filter((g) => rest.some((a) => a.group === g)));
    const flat = groups.flatMap((g) => ids(g.items));
    expect(flat.sort()).toEqual(ids(rest).sort());
    for (const t of ids(top)) expect(flat).not.toContain(t);
  });

  test('ordering within a group follows ALL_ACTIONS, so it does not jump between renders', () => {
    const { rest } = rankQuickActions({});
    const groups = groupRest(rest);
    for (const g of groups) {
      const expected = ALL_ACTIONS.filter((a) => a.group === g.group && rest.includes(a));
      expect(ids(g.items)).toEqual(ids(expected));
    }
  });

  test('every item carries a label a client can read', () => {
    for (const a of ALL_ACTIONS) {
      expect(typeof a.label).toBe('string');
      expect(a.label.length).toBeGreaterThan(3);
      expect(Boolean(a.intent) || Boolean(a.issue)).toBe(true);
    }
  });
});

import {
  sanitizeIssue, reportIssue, subscribeIssues, issueKey,
  shouldAutoOpen, markAutoOpened, resetAutoOpen,
} from '../assistantEvents';

describe('assistantEvents — issue sanitisation + bus', () => {
  beforeEach(() => resetAutoOpen());

  test('sanitizeIssue keeps only allowed fields, drops secrets, caps message', () => {
    const out = sanitizeIssue({
      code: 'TOOL_LAUNCH_FAILED', toolId: 't1', toolName: 'WriteHuman', message: 'm'.repeat(500),
      token: 'SECRET', cookie: 'x', password: 'y', stack: 'trace', recoverable: true,
    });
    expect(out.code).toBe('TOOL_LAUNCH_FAILED');
    expect(out.toolId).toBe('t1');
    expect(out.recoverable).toBe(true);
    expect(out.message.length).toBe(300);
    expect(out.token).toBeUndefined();
    expect(out.cookie).toBeUndefined();
    expect(out.password).toBeUndefined();
    expect(out.stack).toBeUndefined();
  });

  test('reportIssue dispatches sanitised detail to subscribers', () => {
    const seen = [];
    const off = subscribeIssues((d) => seen.push(d));
    reportIssue({ code: 'EXTENSION_MISSING', toolName: 'HIX', token: 'nope' });
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('EXTENSION_MISSING');
    expect(seen[0].token).toBeUndefined();
  });

  test('issueKey is code+tool scoped and non-sensitive', () => {
    expect(issueKey({ code: 'X', toolId: 't9' })).toBe('X:t9');
    expect(issueKey({ code: 'X' })).toBe('X:global');
  });
});

describe('assistantEvents — auto-open-once per session', () => {
  beforeEach(() => resetAutoOpen());

  test('first time may auto-open; after marking, it will not again', () => {
    const issue = { code: 'ASSIGNMENT_EXPIRED', toolId: 't1' };
    expect(shouldAutoOpen(issue)).toBe(true);
    markAutoOpened(issue);
    expect(shouldAutoOpen(issue)).toBe(false);
  });

  test('a different issue/tool is independent', () => {
    markAutoOpened({ code: 'ASSIGNMENT_EXPIRED', toolId: 't1' });
    expect(shouldAutoOpen({ code: 'ASSIGNMENT_EXPIRED', toolId: 't2' })).toBe(true);
    expect(shouldAutoOpen({ code: 'EXTENSION_MISSING', toolId: 't1' })).toBe(true);
  });
});

import {
  ISSUE, normalizeIssueCode, diagnoseToolNotOpening, flowForIssue, isExpired, ALL_ISSUE_CODES,
} from '../diagnosticFlows';

describe('diagnosticFlows — issue normalisation from REAL repo codes', () => {
  test('maps real backend/extension codes to the canonical set', () => {
    expect(normalizeIssueCode('assignment_not_found')).toBe(ISSUE.TOOL_NOT_ASSIGNED);
    expect(normalizeIssueCode('assignment_expired')).toBe(ISSUE.ASSIGNMENT_EXPIRED);
    expect(normalizeIssueCode('extension_not_detected')).toBe(ISSUE.EXTENSION_MISSING);
    expect(normalizeIssueCode('extension_update_required')).toBe(ISSUE.EXTENSION_OUTDATED);
    expect(normalizeIssueCode('extension_token_invalid')).toBe(ISSUE.SESSION_EXPIRED);
    expect(normalizeIssueCode('tool_domain_invalid')).toBe(ISSUE.TOOL_LAUNCH_FAILED);
    expect(normalizeIssueCode('no_active_session')).toBe(ISSUE.TOOL_LAUNCH_FAILED);
  });
  test('passes through already-canonical codes and defaults unknowns safely', () => {
    expect(normalizeIssueCode(ISSUE.NETWORK_ERROR)).toBe(ISSUE.NETWORK_ERROR);
    expect(normalizeIssueCode('totally made up')).toBe(ISSUE.UNKNOWN_CLIENT_ISSUE);
    expect(normalizeIssueCode(undefined)).toBe(ISSUE.UNKNOWN_CLIENT_ISSUE);
    expect(normalizeIssueCode('Extension did not respond in time')).toBe(ISSUE.NETWORK_ERROR);
  });
});

describe('diagnosticFlows — isExpired uses only real fields', () => {
  test('negative daysUntilExpiry → expired', () => {
    expect(isExpired({ tool: { daysUntilExpiry: -1 } })).toBe(true);
    expect(isExpired({ tool: { daysUntilExpiry: 3 } })).toBe(false);
  });
  test('endDate well in the past → expired (inclusive end-of-day)', () => {
    expect(isExpired({ tool: { endDate: '2000-01-01' } })).toBe(true);
    expect(isExpired({ tool: { endDate: '2999-01-01' } })).toBe(false);
    expect(isExpired({ tool: {} })).toBe(false);
  });
});

describe('diagnosticFlows — ordered "tool not opening" diagnosis', () => {
  const ext = { installed: true, connected: true, isOutdated: false };
  test('no tool → TOOL_NOT_ASSIGNED', () => {
    expect(diagnoseToolNotOpening({})).toBe(ISSUE.TOOL_NOT_ASSIGNED);
  });
  test('inactive tool → ASSIGNMENT_INACTIVE (before extension checks)', () => {
    expect(diagnoseToolNotOpening({ tool: { status: 'paused' }, extension: ext })).toBe(ISSUE.ASSIGNMENT_INACTIVE);
  });
  test('expired → ASSIGNMENT_EXPIRED', () => {
    expect(diagnoseToolNotOpening({ tool: { status: 'active', daysUntilExpiry: -2 } })).toBe(ISSUE.ASSIGNMENT_EXPIRED);
  });
  test('extension checks only when requiresExtension', () => {
    const tool = { status: 'active', daysUntilExpiry: 5 };
    expect(diagnoseToolNotOpening({ tool, requiresExtension: true, extension: { installed: false } })).toBe(ISSUE.EXTENSION_MISSING);
    expect(diagnoseToolNotOpening({ tool, requiresExtension: true, extension: { installed: true, isOutdated: true } })).toBe(ISSUE.EXTENSION_OUTDATED);
    expect(diagnoseToolNotOpening({ tool, requiresExtension: true, extension: { installed: true, connected: false } })).toBe(ISSUE.EXTENSION_DISCONNECTED);
    // without requiresExtension, a missing extension is NOT assumed to be the cause
    expect(diagnoseToolNotOpening({ tool, extension: { installed: false } })).toBe(ISSUE.UNKNOWN_CLIENT_ISSUE);
  });
  test('falls through to the launch error code', () => {
    const tool = { status: 'active', daysUntilExpiry: 5 };
    expect(diagnoseToolNotOpening({ tool, extension: ext, launchResult: { success: false, error: 'extension_token_invalid' } })).toBe(ISSUE.SESSION_EXPIRED);
  });
});

describe('diagnosticFlows — flow lookup is always safe', () => {
  test('every canonical issue has a renderable flow with steps', () => {
    for (const code of ALL_ISSUE_CODES) {
      const flow = flowForIssue(code);
      expect(flow.code).toBe(code);
      expect(typeof flow.title).toBe('string');
      expect(Array.isArray(flow.steps) && flow.steps.length).toBeTruthy();
    }
  });
  test('unknown/raw code still returns the safe fallback flow', () => {
    expect(flowForIssue('garbage').code).toBe(ISSUE.UNKNOWN_CLIENT_ISSUE);
    expect(flowForIssue('assignment_expired').code).toBe(ISSUE.ASSIGNMENT_EXPIRED);
  });
  test('no flow step leaks secrets (no token/cookie/password words)', () => {
    for (const code of ALL_ISSUE_CODES) {
      const text = flowForIssue(code).steps.map((s) => s.text).join(' ').toLowerCase();
      expect(text).not.toMatch(/token|cookie|password|secret|bearer/);
    }
  });
});

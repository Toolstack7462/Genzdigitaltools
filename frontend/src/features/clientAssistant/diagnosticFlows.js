// Gen Z Guide — deterministic, context-aware troubleshooting. NO AI, NO guessing: every flow is
// derived from the client's ACTUAL portal state and the REAL backend/extension codes this project
// already returns. Pure and unit-tested. UI components render these step descriptions; this module
// never touches the DOM and never contains credentials/tokens.

// Normalised internal issue codes (canonical set used across the assistant).
export const ISSUE = {
  TOOL_NOT_ASSIGNED: 'TOOL_NOT_ASSIGNED',
  ASSIGNMENT_INACTIVE: 'ASSIGNMENT_INACTIVE',
  ASSIGNMENT_EXPIRED: 'ASSIGNMENT_EXPIRED',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',
  EXTENSION_MISSING: 'EXTENSION_MISSING',
  EXTENSION_OUTDATED: 'EXTENSION_OUTDATED',
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
  TOOL_LAUNCH_FAILED: 'TOOL_LAUNCH_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  UNKNOWN_CLIENT_ISSUE: 'UNKNOWN_CLIENT_ISSUE',
};

// Map the REAL codes already produced by this repo (backend ACCESS_CODES, extension stages,
// useExtension openTool errors) onto the canonical set above. Unknown → UNKNOWN_CLIENT_ISSUE.
const RAW_TO_ISSUE = {
  assignment_not_found: ISSUE.TOOL_NOT_ASSIGNED,
  tool_not_synced: ISSUE.TOOL_NOT_ASSIGNED,
  assignment_expired: ISSUE.ASSIGNMENT_EXPIRED,
  tool_inactive_or_deleted: ISSUE.ASSIGNMENT_INACTIVE,
  extension_not_detected: ISSUE.EXTENSION_MISSING,
  extension_missing: ISSUE.EXTENSION_MISSING,
  extension_update_required: ISSUE.EXTENSION_OUTDATED,
  disconnected: ISSUE.EXTENSION_DISCONNECTED,
  not_connected: ISSUE.EXTENSION_DISCONNECTED,
  extension_token_invalid: ISSUE.SESSION_EXPIRED,
  session_expired: ISSUE.SESSION_EXPIRED,
  tool_domain_invalid: ISSUE.TOOL_LAUNCH_FAILED,
  session_bundle_missing: ISSUE.TOOL_LAUNCH_FAILED,
  no_active_session: ISSUE.TOOL_LAUNCH_FAILED,
  network_error: ISSUE.NETWORK_ERROR,
  server_error: ISSUE.SERVER_ERROR,
};

export function normalizeIssueCode(raw) {
  if (!raw) return ISSUE.UNKNOWN_CLIENT_ISSUE;
  if (Object.prototype.hasOwnProperty.call(ISSUE, raw)) return raw; // already canonical
  const key = String(raw).toLowerCase();
  if (RAW_TO_ISSUE[key]) return RAW_TO_ISSUE[key];
  // Heuristics for message-ish errors (never throws, never guesses an action).
  if (/network|offline|failed to fetch|timeout|did not respond/.test(key)) return ISSUE.NETWORK_ERROR;
  if (/\b5\d\d\b|server error|internal/.test(key)) return ISSUE.SERVER_ERROR;
  return ISSUE.UNKNOWN_CLIENT_ISSUE;
}

/** Is this assignment/tool expired? Uses only the real fields the client tools API returns. */
export function isExpired(ctx = {}) {
  const t = ctx.tool || {};
  if (typeof t.daysUntilExpiry === 'number' && t.daysUntilExpiry < 0) return true;
  if (t.endDate) {
    const end = new Date(t.endDate).getTime();
    // Inclusive end-of-day, matching the backend's effectiveEndBoundary semantics.
    if (Number.isFinite(end) && end + 24 * 60 * 60 * 1000 < Date.now()) return true;
  }
  return false;
}

/**
 * The ordered "tool not opening" diagnosis. Inspects available state in a SAFE order and returns
 * the first applicable normalised issue code. Uses only real fields; never fabricates state.
 * @param {{tool?:object, extension?:object, launchResult?:object, requiresExtension?:boolean}} ctx
 */
export function diagnoseToolNotOpening(ctx = {}) {
  const { tool, extension = {}, launchResult } = ctx;
  if (!tool) return ISSUE.TOOL_NOT_ASSIGNED;
  if (tool.status && tool.status !== 'active') return ISSUE.ASSIGNMENT_INACTIVE;
  if (isExpired(ctx)) return ISSUE.ASSIGNMENT_EXPIRED;
  // Extension checks only when we actually have extension status to trust.
  if (ctx.requiresExtension) {
    if (extension.installed === false) return ISSUE.EXTENSION_MISSING;
    if (extension.installed && (extension.isOutdated || extension.updateAvailable)) return ISSUE.EXTENSION_OUTDATED;
    if (extension.installed && extension.connected === false) return ISSUE.EXTENSION_DISCONNECTED;
  }
  if (launchResult && launchResult.success === false && launchResult.error) {
    return normalizeIssueCode(launchResult.error);
  }
  return ISSUE.UNKNOWN_CLIENT_ISSUE;
}

// Flow definitions: client-friendly, step-by-step. `action` is a semantic hint the panel maps to a
// real existing action (navigate / retry / check-again / renew / support) — never an invented route.
// `avatar` is a semantic AvatarRenderer state. No step contains secrets.
const FLOWS = {
  [ISSUE.TOOL_NOT_ASSIGNED]: {
    title: 'This tool isn’t on your account',
    avatar: 'warning',
    steps: [
      { text: 'This tool isn’t currently assigned to your account, so it won’t appear or open.' },
      { text: 'Open “My Tools” to see everything assigned to you right now.', action: 'navigate:/client/tools' },
      { text: 'If you believe it should be there, contact support and we’ll check your account.', action: 'support' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.ASSIGNMENT_INACTIVE]: {
    title: 'This tool is paused',
    avatar: 'warning',
    steps: [
      { text: 'Access to this tool is currently inactive on your account.' },
      { text: 'Check your tools list for its current status.', action: 'navigate:/client/tools' },
      { text: 'Contact support to re-activate it.', action: 'support' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.ASSIGNMENT_EXPIRED]: {
    title: 'Your access has expired',
    avatar: 'sad',
    steps: [
      { text: 'Your access to this tool has reached its expiry date.' },
      { text: 'You can renew in one tap — we’ll open a pre-filled WhatsApp message to support.', action: 'renew' },
      { text: 'After renewal, come back and open the tool again.' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.SUBSCRIPTION_EXPIRED]: {
    title: 'Your plan needs renewal',
    avatar: 'sad',
    steps: [
      { text: 'Your subscription/access period has ended.' },
      { text: 'Tap renew to contact support with a pre-filled request.', action: 'renew' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.EXTENSION_MISSING]: {
    title: 'Browser extension required',
    avatar: 'thinking',
    steps: [
      { text: 'This tool opens through the Gen Z browser extension, which isn’t detected yet.' },
      { text: 'Open the Extension Setup Guide and follow the install steps.', action: 'navigate:/client/extension-guide' },
      { text: 'Once installed, come back and tap “Check Again”.', action: 'recheck-extension' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.EXTENSION_OUTDATED]: {
    title: 'Update your extension',
    avatar: 'warning',
    steps: [
      { text: 'A newer extension version is available and this tool needs it.' },
      { text: 'Open the Extension Setup Guide to download and update.', action: 'navigate:/client/extension-guide' },
      { text: 'After updating, tap “Check Again” to confirm.', action: 'recheck-extension' },
    ],
    support: true, retryable: false,
  },
  [ISSUE.EXTENSION_DISCONNECTED]: {
    title: 'Reconnect the extension',
    avatar: 'thinking',
    steps: [
      { text: 'The extension is installed but not connected to your account right now.' },
      { text: 'Tap “Check Again” to reconnect.', action: 'recheck-extension' },
      { text: 'If it stays disconnected, reload the extension and refresh this page.' },
    ],
    support: true, retryable: true,
  },
  [ISSUE.SESSION_EXPIRED]: {
    title: 'Please sign in again',
    avatar: 'warning',
    steps: [
      { text: 'Your secure session has expired.' },
      { text: 'Refresh the dashboard to re-establish it, then try the tool again.', action: 'retry' },
    ],
    support: true, retryable: true,
  },
  [ISSUE.TOOL_LAUNCH_FAILED]: {
    title: 'Let’s get this tool open',
    avatar: 'thinking',
    steps: [
      { text: 'The tool didn’t finish opening. This is usually temporary.' },
      { text: 'Try opening it again — we’ll retry safely.', action: 'retry' },
      { text: 'If it still won’t open, contact support and we’ll jump in.', action: 'support' },
    ],
    support: true, retryable: true,
  },
  [ISSUE.NETWORK_ERROR]: {
    title: 'Connection problem',
    avatar: 'confused',
    steps: [
      { text: 'It looks like the connection dropped.' },
      { text: 'Check your internet and try again.', action: 'retry' },
    ],
    support: true, retryable: true,
  },
  [ISSUE.SERVER_ERROR]: {
    title: 'Something went wrong on our side',
    avatar: 'sad',
    steps: [
      { text: 'Our server hit a temporary error.' },
      { text: 'Please try again in a moment.', action: 'retry' },
      { text: 'If it keeps happening, contact support.', action: 'support' },
    ],
    support: true, retryable: true,
  },
  [ISSUE.UNKNOWN_CLIENT_ISSUE]: {
    title: 'Let’s figure this out',
    avatar: 'neutral',
    steps: [
      { text: 'I couldn’t pinpoint the exact cause from here.' },
      { text: 'Try the action again, or contact support and we’ll help directly.', action: 'retry' },
      { text: 'Contact human support.', action: 'support' },
    ],
    support: true, retryable: true,
  },
};

/** Return the flow for a normalised (or raw) issue code. Always returns a safe flow (never null). */
export function flowForIssue(code) {
  const norm = Object.prototype.hasOwnProperty.call(ISSUE, code) ? code : normalizeIssueCode(code);
  const flow = FLOWS[norm] || FLOWS[ISSUE.UNKNOWN_CLIENT_ISSUE];
  return { code: norm, ...flow };
}

export const ALL_ISSUE_CODES = Object.keys(ISSUE);

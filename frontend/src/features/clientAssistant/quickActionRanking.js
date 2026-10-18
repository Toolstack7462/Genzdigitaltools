// Which three things to offer first — and where the rest go.
//
// The panel used to show all six quick actions as a permanent stack of 44px buttons, roughly 290px
// of vertical space that never changed and never reflected the client's situation. Three chips are
// chosen from REAL state instead, and every remaining topic stays one tap away under More help.
//
// Nothing here invents context: a signal is used only when it is a positive reading. An unknown
// extension status ranks the extension chip up (there is something worth checking) but never
// implies the extension is fine — that distinction lives in extensionStatusKind.js.
import { INTENTS } from './assistantIntents';
import { ISSUE } from './diagnosticFlows';
import { EXT_KIND } from './extensionStatusKind';

export const TOP_N = 3;

// Every supported entry point, with the group it falls under in More help. Intent entries reuse
// startIntent; issue entries reuse startIssueByCode, so no flow is unreachable.
export const ALL_ACTIONS = [
  { id: 'TOOL_NOT_OPENING', label: "My tool won't open", intent: INTENTS.TOOL_NOT_OPENING, group: 'Tools & access', icon: 'tool' },
  { id: 'EXTENSION', label: 'Set up the extension', intent: INTENTS.EXTENSION, group: 'Extension', icon: 'puzzle' },
  { id: 'EXPIRED', label: 'Access or renewal', intent: INTENTS.EXPIRED, group: 'Account', icon: 'alert' },
  { id: 'TOOL_MISSING', label: "I can't find my assigned tool", intent: INTENTS.TOOL_MISSING, group: 'Tools & access' },
  { id: 'USING_A_TOOL', label: 'I need help using a tool', intent: INTENTS.USING_A_TOOL, group: 'Tools & access' },
  { id: 'TOOL_NOT_ASSIGNED', label: "This tool isn't on my account", issue: ISSUE.TOOL_NOT_ASSIGNED, group: 'Tools & access' },
  { id: 'ASSIGNMENT_INACTIVE', label: 'This tool is paused', issue: ISSUE.ASSIGNMENT_INACTIVE, group: 'Tools & access' },
  { id: 'EXTENSION_MISSING', label: 'Browser extension required', issue: ISSUE.EXTENSION_MISSING, group: 'Extension' },
  { id: 'EXTENSION_OUTDATED', label: 'Update my extension', issue: ISSUE.EXTENSION_OUTDATED, group: 'Extension' },
  { id: 'EXTENSION_DISCONNECTED', label: 'Reconnect the extension', issue: ISSUE.EXTENSION_DISCONNECTED, group: 'Extension' },
  { id: 'ASSIGNMENT_EXPIRED', label: 'My access has expired', issue: ISSUE.ASSIGNMENT_EXPIRED, group: 'Account' },
  { id: 'SUBSCRIPTION_EXPIRED', label: 'My plan needs renewal', issue: ISSUE.SUBSCRIPTION_EXPIRED, group: 'Account' },
  { id: 'SESSION_EXPIRED', label: 'Sign me in again', issue: ISSUE.SESSION_EXPIRED, group: 'Account' },
  { id: 'NETWORK_ERROR', label: 'Connection problem', issue: ISSUE.NETWORK_ERROR, group: 'Something else' },
  { id: 'UNKNOWN_CLIENT_ISSUE', label: "Something else — let's figure it out", issue: ISSUE.UNKNOWN_CLIENT_ISSUE, group: 'Something else' },
  { id: 'CONTACT_SUPPORT', label: 'Talk to a human', intent: INTENTS.CONTACT_SUPPORT, group: 'Something else' },
];

export const GROUP_ORDER = ['Tools & access', 'Extension', 'Account', 'Something else'];

// Default trio when nothing in the client's state argues otherwise.
const DEFAULT_TOP = ['TOOL_NOT_OPENING', 'EXTENSION', 'EXPIRED'];

/**
 * Rank the entry points for this client.
 *
 * @param {{ extensionKind?: string, lastIssueCode?: string|null }} ctx
 *        extensionKind   from extensionStatusKind() — a real reading or 'unknown'
 *        lastIssueCode   the code of the problem the client just hit, when there is one
 * @returns {{ top: object[], rest: object[] }} top has at most TOP_N entries; rest keeps the order
 *          of ALL_ACTIONS so More help is stable between renders.
 */
export function rankQuickActions(ctx = {}) {
  const byId = new Map(ALL_ACTIONS.map((a) => [a.id, a]));
  const picked = [];
  const take = (id) => {
    const a = byId.get(id);
    if (a && picked.length < TOP_N && !picked.includes(a)) picked.push(a);
  };

  // 1. The problem the client just had, if it is one of the entry points. Most specific signal
  //    there is: they were doing something and it failed.
  if (ctx.lastIssueCode) {
    const match = ALL_ACTIONS.find((a) => a.issue === ctx.lastIssueCode);
    if (match) take(match.id);
  }

  // 2. A live extension signal. A real problem leads with its own flow; 'unknown' leads with the
  //    general extension entry, which asks rather than asserts.
  switch (ctx.extensionKind) {
    case EXT_KIND.MISSING: take('EXTENSION_MISSING'); break;
    case EXT_KIND.OUTDATED: take('EXTENSION_OUTDATED'); break;
    case EXT_KIND.DISCONNECTED: take('EXTENSION_DISCONNECTED'); break;
    case EXT_KIND.UNKNOWN: take('EXTENSION'); break;
    default: break;   // 'ok' is not a reason to put the extension first
  }

  // 3. Fill from the defaults, skipping anything already chosen.
  for (const id of DEFAULT_TOP) take(id);
  // 4. Still short (a tiny ALL_ACTIONS in a test): fill in declaration order.
  for (const a of ALL_ACTIONS) take(a.id);

  const top = picked.slice(0, TOP_N);
  const rest = ALL_ACTIONS.filter((a) => !top.includes(a));
  return { top, rest };
}

/** More help, grouped in a stable order. Groups with no remaining entries are dropped. */
export function groupRest(rest) {
  return GROUP_ORDER
    .map((group) => ({ group, items: rest.filter((a) => a.group === group) }))
    .filter((g) => g.items.length > 0);
}

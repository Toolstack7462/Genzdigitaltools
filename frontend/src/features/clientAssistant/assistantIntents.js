// Gen Z Guide — deterministic intent matcher (NO AI). Maps a client's free-text message to one of
// the supported assistant flows. English + commonly-used Roman Urdu support phrases. Pure, isolated,
// unit-tested. It NEVER renders HTML and NEVER guesses an action it cannot back with real state.

export const MAX_INPUT_LENGTH = 300;

// Canonical flow ids the assistant understands. Kept in sync with diagnosticFlows.js.
export const INTENTS = {
  TOOL_NOT_OPENING: 'TOOL_NOT_OPENING',
  TOOL_MISSING: 'TOOL_MISSING',
  EXTENSION: 'EXTENSION',
  EXPIRED: 'EXPIRED',
  USING_A_TOOL: 'USING_A_TOOL',
  CONTACT_SUPPORT: 'CONTACT_SUPPORT',
};

// Each intent lists lowercase substrings/keywords (EN + Roman Urdu). Order matters only for the
// scoring tie-break below; matching is substring-based after normalisation.
const INTENT_KEYWORDS = [
  [INTENTS.TOOL_NOT_OPENING, [
    'not opening', 'won\'t open', 'wont open', 'can\'t open', 'cant open', 'not working',
    'does not open', 'doesnt open', 'tool error', 'launch fail', 'open nahi', 'nahi khul',
    'khul nahi', 'nhi khul', 'chal nahi', 'nahi chal', 'kaam nahi', 'open ni ho',
  ]],
  [INTENTS.TOOL_MISSING, [
    'missing', 'not there', 'cannot find', 'can\'t find', 'cant find', 'not showing', 'disappear',
    'where is my tool', 'tool nahi mil', 'nahi mil raha', 'nazar nahi', 'dikh nahi', 'ghayab',
  ]],
  [INTENTS.EXTENSION, [
    'extension', 'install', 'update', 'add-on', 'addon', 'plugin', 'chrome', 'browser',
    'extension install', 'extension update', 'extension lagan',
  ]],
  [INTENTS.EXPIRED, [
    'expired', 'expiry', 'expire', 'renew', 'renewal', 'subscription', 'plan', 'khatam', 'khtm',
    'expire ho', 'renew karn', 'plan khatam', 'access expired',
  ]],
  [INTENTS.USING_A_TOOL, [
    'how to use', 'how do i use', 'help using', 'guide', 'tutorial', 'kaise use', 'kaise chal',
    'istemaal', 'kaise karu',
  ]],
  [INTENTS.CONTACT_SUPPORT, [
    'support', 'human', 'agent', 'talk to', 'contact', 'whatsapp', 'help me', 'baat karn',
    'support se baat', 'madad', 'rabta',
  ]],
];

/** Normalise raw user text: trim, cap length, lowercase, collapse whitespace. */
export function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, MAX_INPUT_LENGTH).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Match free text to a supported intent. Returns the best intent id, or null when nothing matches.
 * Scoring: an intent scores by how many of its keywords appear; the longest matched keyword breaks
 * ties (a more specific phrase wins over a generic word like "help").
 */
export function matchIntent(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  let best = null;
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    let hits = 0;
    let longest = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) { hits += 1; longest = Math.max(longest, kw.length); }
    }
    if (hits === 0) continue;
    const score = hits * 100 + longest;
    if (!best || score > best.score) best = { intent, score };
  }
  return best ? best.intent : null;
}

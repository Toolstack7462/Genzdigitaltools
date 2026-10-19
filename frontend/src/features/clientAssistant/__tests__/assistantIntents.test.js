import { matchIntent, normalizeText, INTENTS, MAX_INPUT_LENGTH } from '../assistantIntents';

describe('assistantIntents — deterministic matcher (EN + Roman Urdu)', () => {
  test('normalizeText trims, lowercases, caps length, collapses whitespace', () => {
    expect(normalizeText('  Hello   World  ')).toBe('hello world');
    expect(normalizeText('x'.repeat(MAX_INPUT_LENGTH + 50)).length).toBe(MAX_INPUT_LENGTH);
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(42)).toBe('');
  });

  test('English phrases map to the right flow', () => {
    expect(matchIntent('my tool is not opening')).toBe(INTENTS.TOOL_NOT_OPENING);
    expect(matchIntent('my tool is missing')).toBe(INTENTS.TOOL_MISSING);
    expect(matchIntent('how do I install the extension')).toBe(INTENTS.EXTENSION);
    expect(matchIntent('my access expired, subscription renew')).toBe(INTENTS.EXPIRED);
    expect(matchIntent('how to use this tool')).toBe(INTENTS.USING_A_TOOL);
    expect(matchIntent('I want to talk to human support')).toBe(INTENTS.CONTACT_SUPPORT);
  });

  test('Roman Urdu phrases map correctly', () => {
    expect(matchIntent('tool open nahi ho raha')).toBe(INTENTS.TOOL_NOT_OPENING);
    expect(matchIntent('mera tool nahi mil raha')).toBe(INTENTS.TOOL_MISSING);
    expect(matchIntent('extension install karni hai')).toBe(INTENTS.EXTENSION);
    expect(matchIntent('plan khatam ho gaya renew karna hai')).toBe(INTENTS.EXPIRED);
    expect(matchIntent('support se baat karni hai')).toBe(INTENTS.CONTACT_SUPPORT);
  });

  test('no match returns null (caller shows options + support)', () => {
    expect(matchIntent('asdfghjkl qwerty')).toBeNull();
    expect(matchIntent('')).toBeNull();
    expect(matchIntent('   ')).toBeNull();
  });

  test('specific phrase beats a generic keyword on tie-break', () => {
    // contains "help" (support) AND "not opening" (tool) → more specific tool phrase wins
    expect(matchIntent('help, tool not opening')).toBe(INTENTS.TOOL_NOT_OPENING);
  });
});

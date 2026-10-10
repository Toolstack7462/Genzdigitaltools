import { buildAssistantSupportMessage, buildAssistantSupportUrl } from '../supportHandoff';
import { SUPPORT_WHATSAPP_NUMBER } from '../../../lib/support';

describe('supportHandoff — safe, central-number support URL', () => {
  test('message contains only non-sensitive fields', () => {
    const msg = buildAssistantSupportMessage({
      issueTitle: 'Tool launch failed', toolName: 'WriteHuman', clientName: 'Rida', clientEmail: 'r@x.com',
    });
    expect(msg).toContain('Gen Z Digital Store Support');
    expect(msg).toContain('Issue: Tool launch failed');
    expect(msg).toContain('Tool: WriteHuman');
    expect(msg).toContain('Account: Rida');
    expect(msg).not.toMatch(/token|cookie|password|secret|bearer/i);
  });

  test('omits fields that are absent', () => {
    const msg = buildAssistantSupportMessage({ issueTitle: 'Help' });
    expect(msg).toContain('Issue: Help');
    expect(msg).not.toContain('Tool:');
    expect(msg).not.toContain('Account:');
  });

  test('URL uses the central support number (no hard-coded duplicate) and encodes the message', () => {
    const url = buildAssistantSupportUrl({ issueTitle: 'Access expired', toolName: 'HIX AI' });
    expect(url.startsWith(`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=`)).toBe(true);
    expect(url).toContain(encodeURIComponent('Issue: Access expired'));
    // never a raw space (must be URL-encoded)
    expect(url.split('?text=')[1]).not.toMatch(/\s/);
  });
});

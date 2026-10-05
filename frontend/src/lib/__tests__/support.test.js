globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LIVE = { whatsappNumber: '923001112233', whatsappDisplay: '+92 300 1112233', email: 'help@genzdigitalstore.com' };

function freshModule(fetchImpl) {
  jest.resetModules();
  global.fetch = jest.fn(fetchImpl);
  try { localStorage.clear(); } catch (_) {}
  // React + react-dom are re-required with the module so the hook and the renderer share
  // one React instance (resetModules would otherwise give each its own copy).
  const s = require('../support');
  s.act = require('react').act;
  s.createRoot = require('react-dom/client').createRoot;
  return s;
}

afterEach(() => { delete global.fetch; });

describe('official support contact — bundled fallback', () => {
  it('is +92 335 5500134 / admin@genzdigitalstore.com in every derived form', () => {
    const s = freshModule(() => new Promise(() => {}));
    expect(s.SUPPORT_WHATSAPP_NUMBER).toBe('923355500134');
    expect(s.SUPPORT_WHATSAPP_DISPLAY).toBe('+92 335 5500134');
    expect(s.SUPPORT_WHATSAPP_DISPLAY.replace(/\D/g, '')).toBe(s.SUPPORT_WHATSAPP_NUMBER);
    expect(s.SUPPORT_WHATSAPP_URL).toBe('https://wa.me/923355500134');
    expect(s.getSupportContact()).toEqual({
      whatsappNumber: '923355500134', whatsappDisplay: '+92 335 5500134',
      whatsappUrl: 'https://wa.me/923355500134', email: 'admin@genzdigitalstore.com',
    });
  });

  it('keeps pre-filled messages correctly encoded (floating button, login help, renew)', () => {
    const s = freshModule(() => new Promise(() => {}));
    const floating = 'Hi Gen Z Digital Store! I need help with tools/subscription.';
    const login = "Hello, I'm having trouble connecting to my Gen Z Digital Store account.";
    expect(s.buildSupportWhatsAppUrl()).toBe('https://wa.me/923355500134');
    expect(s.buildSupportWhatsAppUrl(floating)).toBe(`https://wa.me/923355500134?text=${encodeURIComponent(floating)}`);
    expect(new URL(s.buildSupportWhatsAppUrl(login)).searchParams.get('text')).toBe(login);
    const renew = new URL(s.buildRenewWhatsAppUrl({ clientName: 'Ali & Co', toolName: 'WriteHuman', status: 'expired' }));
    expect(renew.origin + renew.pathname).toBe('https://wa.me/923355500134');
    expect(renew.searchParams.get('text')).toBe('Hello, I want to renew my plan.\nTool: WriteHuman\nStatus: expired\nAccount: Ali & Co');
  });
});

describe('sanitizeContact', () => {
  const { sanitizeContact } = require('../support');
  it('rebuilds the URL from digits and never trusts a supplied URL', () => {
    expect(sanitizeContact({ ...LIVE, whatsappUrl: 'https://evil.example' }).whatsappUrl).toBe('https://wa.me/923001112233');
  });
  it('rejects malformed numbers and falls back for a bad email/display', () => {
    expect(sanitizeContact({ whatsappNumber: 'wa.me/1' })).toBeNull();
    expect(sanitizeContact({ whatsappNumber: '12' })).toBeNull();
    expect(sanitizeContact(null)).toBeNull();
    const c = sanitizeContact({ whatsappNumber: '923001112233', email: '"><img>', whatsappDisplay: '<b>x</b>' });
    expect(c.email).toBe('admin@genzdigitalstore.com');
    expect(c.whatsappDisplay).toBe('+923001112233');
  });
});

describe('live admin value', () => {
  it('useSupportContact renders the bundled number before the API answers', async () => {
    const s = freshModule(() => new Promise(() => {}));
    const Probe = () => <a href={s.useSupportContact().whatsappUrl}>x</a>;
    const host = document.createElement('div');
    const root = s.createRoot(host);
    await s.act(async () => { root.render(<Probe />); });
    expect(host.querySelector('a').getAttribute('href')).toBe('https://wa.me/923355500134');
    s.act(() => root.unmount());
  });

  it('loadSupportContact fetches once (public, no credentials) and updates every builder', async () => {
    const s = freshModule(() => Promise.resolve({ ok: true, json: async () => ({ success: true, contact: LIVE }) }));
    await Promise.all([s.loadSupportContact(), s.loadSupportContact()]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/public\/support-contact$/);
    expect(global.fetch.mock.calls[0][1]).toEqual({ credentials: 'omit' });
    expect(s.getSupportContact().whatsappUrl).toBe('https://wa.me/923001112233');
    expect(s.buildRenewWhatsAppUrl({ toolName: 'X' })).toMatch(/^https:\/\/wa\.me\/923001112233\?text=/);
  });

  it('API down → bundled fallback stays', async () => {
    const s = freshModule(() => Promise.reject(new Error('offline')));
    await s.loadSupportContact();
    expect(s.getSupportContact().whatsappNumber).toBe('923355500134');
  });

  it('useSupportContact re-renders a component with the admin value', async () => {
    const s = freshModule(() => Promise.resolve({ ok: true, json: async () => ({ contact: LIVE }) }));
    const Probe = () => {
      const c = s.useSupportContact();
      return <a href={c.whatsappUrl} data-testid="wa">{c.email}</a>;
    };
    const host = document.createElement('div');
    const root = s.createRoot(host);
    await s.act(async () => { root.render(<Probe />); });
    const link = () => host.querySelector('a');
    // The fetch resolved inside act → the hook re-rendered with the admin value.
    await s.act(async () => { await s.loadSupportContact(); });
    expect(link().getAttribute('href')).toBe('https://wa.me/923001112233');
    expect(link().textContent).toBe('help@genzdigitalstore.com');
    s.act(() => root.unmount());
  });
});

/**
 * Official WhatsApp support contact on the extension's expired page.
 *
 * expired.js carries the ONE bundled fallback (+92 335 5500134) and then applies the
 * admin-editable live value from GET /api/crm/public/support-contact. These tests run
 * expired.js for real (node:vm, tiny element stubs, stubbed chrome.storage + fetch) and prove:
 * the link and the visible number agree, the pre-filled message stays URL-encoded and safe,
 * a valid live value replaces the fallback, junk or a failed request never does, and the
 * "Access restored → Go to Dashboard" button is never hijacked by a late contact response.
 */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(EXT, 'js', 'expired.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'expired.html'), 'utf8');

const NUMBER = '923355500134';
const DISPLAY = '+92 335 5500134';
const OLD_NUMBER = '923027467462';

function el() {
  return {
    textContent: '', innerHTML: '', href: '', target: '', rel: '', style: {},
    addEventListener() {}, removeAttribute() {},
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * @param search   query string
 * @param opts.live      body returned by the support-contact endpoint (undefined → no chrome)
 * @param opts.fail      make fetch reject
 * @param opts.apiUrl    stored apiUrl
 * @param opts.context   response for GENZ_EXPIRED_CONTEXT
 */
async function render(search, opts = {}) {
  const els = {
    title: el(), message: el(), renew: el(), 'renew-fallback': el(),
    'support-number': el(), 'tool-name': el(),
  };
  const fetched = [];
  const ctx = {
    document: { title: '', getElementById: (id) => els[id] || null },
    location: { search }, URLSearchParams, setTimeout: () => {}, console,
  };
  if (opts.live !== undefined || opts.fail || opts.context) {
    let releaseContact = () => {};
    ctx.chrome = {
      storage: { local: { get: (keys, cb) => cb({ apiUrl: opts.apiUrl }) } },
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => { releaseContact = () => cb(opts.context); },
      },
    };
    ctx.fetch = (url, init) => {
      fetched.push({ url, init });
      if (opts.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: async () => opts.live });
    };
    vm.runInNewContext(SRC, ctx);
    if (opts.contextFirst) releaseContact();
    await flush(); await flush();
    if (!opts.contextFirst) releaseContact();
  } else {
    vm.runInNewContext(SRC, ctx);
  }
  return { els, fetched };
}

test('bundled fallback: renew button + visible number use +92 335 5500134', async () => {
  const { els } = await render('?tool=WriteHuman&reason=expired');
  const url = new URL(els.renew.href);
  assert.equal(url.origin + url.pathname, `https://wa.me/${NUMBER}`);
  assert.equal(els.renew.target, '_blank');
  assert.equal(els['support-number'].textContent, DISPLAY);
  assert.equal(DISPLAY.replace(/\D/g, ''), NUMBER);
});

test('pre-filled message is URL-encoded and keeps only safe context', async () => {
  const { els } = await render('?tool=WriteHuman&reason=revoked&email=a%2Bb%40x.com&token=SECRET');
  const url = new URL(els.renew.href);
  assert.equal(url.searchParams.get('text'),
    'Hello, I want to renew my plan.\nTool: WriteHuman\nStatus: revoked\nAccount: a+b@x.com');
  assert.match(els.renew.href, /\?text=Hello%2C%20I%20want%20to%20renew%20my%20plan\.%0ATool%3A%20WriteHuman/);
  assert.doesNotMatch(els.renew.href, /SECRET|token/i);
});

test('live admin value replaces the fallback, message preserved', async () => {
  const { els, fetched } = await render('?tool=StealthWriter&reason=expired', {
    apiUrl: 'https://api.genzdigitalstore.com/api/crm',
    live: { success: true, contact: { whatsappNumber: '923001112233', whatsappDisplay: '+92 300 1112233' } },
  });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'https://api.genzdigitalstore.com/api/crm/public/support-contact');
  assert.equal(fetched[0].init.credentials, 'omit');
  const url = new URL(els.renew.href);
  assert.equal(url.pathname, '/923001112233');
  assert.match(url.searchParams.get('text'), /^Hello, I want to renew my plan\.\nTool: StealthWriter/);
  assert.equal(els['support-number'].textContent, '+92 300 1112233');
});

test('non-https stored apiUrl falls back to the production API', async () => {
  const { fetched } = await render('?reason=expired', { apiUrl: 'javascript:alert(1)', live: null });
  assert.equal(fetched[0].url, 'https://api.genzdigitalstore.com/api/crm/public/support-contact');
});

test('junk or failed live responses never replace the bundled number', async () => {
  for (const opts of [
    { live: { contact: { whatsappNumber: 'https://evil.example' } } },
    { live: { contact: { whatsappNumber: '12' } } },
    { live: null },
    { fail: true },
  ]) {
    const { els } = await render('?tool=WriteHuman&reason=expired', opts);
    assert.equal(new URL(els.renew.href).pathname, `/${NUMBER}`, JSON.stringify(opts));
    assert.equal(els['support-number'].textContent, DISPLAY);
  }
});

test('late live contact never hijacks the "Go to Dashboard" restored button', async () => {
  const { els } = await render('?tool=WriteHuman&reason=expired&toolId=abc', {
    contextFirst: true,
    context: { success: true, active: true, name: 'WriteHuman' },
    live: { contact: { whatsappNumber: '923001112233' } },
  });
  assert.equal(els.renew.textContent, 'Go to Dashboard');
  assert.equal(els.renew.href, 'https://app.genzdigitalstore.com/client/dashboard');
});

test('static expired.html fallback agrees with expired.js; old number gone', () => {
  assert.ok(HTML.includes(`href="https://wa.me/${NUMBER}"`));
  assert.ok(HTML.includes(`<strong id="support-number">${DISPLAY}</strong>`));
  assert.ok(SRC.includes(`SUPPORT_WHATSAPP_NUMBER = '${NUMBER}'`));
  assert.ok(SRC.includes(`SUPPORT_WHATSAPP_DISPLAY = '${DISPLAY}'`));
  for (const s of [HTML, SRC]) assert.ok(!s.includes(OLD_NUMBER) && !s.includes('302 7467462'));
});

test('idle-timeout session page is unchanged (no WhatsApp renew link)', async () => {
  const { els } = await render('?tool=WriteHuman&reason=idle_timeout');
  assert.doesNotMatch(els.renew.href, /wa\.me/);
});

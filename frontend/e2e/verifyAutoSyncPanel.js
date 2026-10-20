/* Rendered-browser verification of the Auto-Sync panel: real Chrome, real built bundle,
   real React mount. The API is intercepted so no production data or credential is involved. */
const { chromium } = require('playwright');
const BASE = 'http://localhost:4191';
const OUT = process.argv[2] || '.';

const policy = (over = {}) => ({
  success: true, accountId: 'acct-fixture',
  policy: Object.assign({
    enabled: true, mode: 'enforce', disabledExplicitly: false,
    officialDomain: 'writehuman.ai', boundAt: '2026-10-09T07:46:30.075Z',
    approvedAccountKey: 'uid-fixture-approved', observedAccountKey: 'uid-fixture-approved',
    approvedToolId: 'tool-fixture-A',
    eligibleToolIds: ['tool-fixture-A', 'tool-fixture-B'],
    eligibleTools: [{ id: 'tool-fixture-A', name: 'Fixture Target', domain: 'writehuman.ai' },
                    { id: 'tool-fixture-B', name: 'Fixture Other', domain: 'writehuman.ai' }],
    ambiguous: false,
    status: { stage: 'synced', lastResult: 'synced', lastCanary: 'passed', pending: false,
              lastSyncAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(),
              lastDetectedAt: new Date().toISOString(), syncedToolId: 'tool-fixture-A' },
  }, over),
});

async function run(mode) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 160)));

  await page.route('**/api/crm/**', async (route) => {
    const u = route.request().url();
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('/auth/admin/me')) return json({ success: true, user: { _id: 'admin-fixture', fullName: 'Fixture Admin', email: 'a@example.test', role: 'SUPER_ADMIN', status: 'active' } });
    if (u.includes('extension-autosync')) {
      if (mode === 'error') return json({ error: 'upstream unavailable' }, 500);
      if (mode === 'loading') { await new Promise((r) => setTimeout(r, 15000)); return json(policy()); }
      if (mode === 'ambiguous') return json(policy({ approvedToolId: null, ambiguous: true }));
      if (mode === 'observe') return json(policy({ mode: 'observe', approvedAccountKey: null,
        status: { stage: 'verified', lastResult: 'awaiting_approval', lastCanary: 'passed',
                  awaitingApproval: true, observedAccountKey: 'uid-fixture-observed', pending: false } }));
      if (mode === 'disabled') return json(policy({ enabled: false, disabledExplicitly: true }));
      if (mode === 'canenforce') return json(policy({ mode: 'observe',
        status: { stage: 'wouldSync', lastResult: 'observe', lastCanary: 'passed', pending: false,
                  wouldSync: true, lastVerifiedAt: new Date().toISOString(), syncedToolId: 'tool-fixture-A' } }));
      return json(policy());
    }
    if (u.includes('/logs')) return json({ success: true, logs: [] });
    if (u.includes('/devices')) return json({ success: true, devices: [] });
    if (u.includes('/status')) return json({ success: true, status: {} });
    if (u.includes('/alert')) return json({ success: true, alert: null });
    return json({ success: true, items: [], tools: [], clients: [], accounts: [] });
  });

  await page.goto(BASE + '/admin/writehuman', { waitUntil: 'domcontentloaded' });
  // Wait for the page's own heading, then settle.
  await page.waitForTimeout(mode === 'loading' ? 3000 : 6000);

  const r = await page.evaluate(() => {
    const txt = (el) => (el.textContent || '').trim();
    const headings = Array.from(document.querySelectorAll('h1,h2,h3'));
    const panels = headings.filter((h) => /Extension Credential Auto-Sync/i.test(txt(h)));
    const live = headings.find((h) => /^Live logs/i.test(txt(h)));
    let order = 'n/a';
    if (panels.length && live) {
      // DOCUMENT_POSITION_FOLLOWING = 4 → live comes AFTER the panel
      order = (panels[0].compareDocumentPosition(live) & 4) ? 'panel-before-livelogs' : 'panel-after-livelogs';
    }
    const section = panels[0] ? panels[0].closest('section') : null;
    const controls = ['Refresh Status', 'Enable (Observe)', 'Pause / Disable', 'Approve this account',
      'Switch to Enforce', 'Back to Observe', 'Save target', 'Clear selection']
      .filter((label) => Array.from((section || document).querySelectorAll('button,select,option'))
        .some((b) => txt(b).includes(label)));
    return {
      panelCount: panels.length,
      liveLogsPresent: !!live,
      order,
      controlsFound: controls,
      selectPresent: !!(section && section.querySelector('select')),
      panelText: section ? txt(section).replace(/\s+/g, ' ').slice(0, 220) : null,
      headingList: headings.map(txt).filter(Boolean).slice(0, 14),
    };
  });

  await page.screenshot({ path: `${OUT}/panel-${mode}.png`, fullPage: true });
  await browser.close();
  return { mode, ...r, consoleErrors: consoleErrors.slice(0, 4) };
}

(async () => {
  for (const mode of (process.argv[3] ? [process.argv[3]] : ['synced'])) {
    const out = await run(mode);
    console.log(JSON.stringify(out, null, 2));
  }
})().catch((e) => { console.log('HARNESS ERROR: ' + e.message); process.exit(1); });

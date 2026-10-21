/* Modal isolation in REAL Chromium, against a COMPLETE VALID parent sale.
   An empty/invalid sale form would refuse to submit for unrelated reasons and could hide an
   accidental submit, so the sale is filled in first and the harness proves it CAN submit. */
const { chromium } = require('playwright');
const path = require('path'); const { pathToFileURL } = require('url');
const PAGE = pathToFileURL(path.join(process.env.CRM_PREVIEW, 'dist', 'index.html')).href;

const saleCount = (p) => p.evaluate(() => window.__preview.filter((u) => u === 'POST /sales').length);
const contactCount = (p) => p.evaluate(() => window.__preview.filter((u) => u === 'POST /contacts/clients').length);

async function buildValidSale(p) {
  await p.waitForSelector('.bcrm-combo input[role="combobox"]');
  const client = p.locator('.bcrm-combo input[role="combobox"]').first();
  await client.click(); await client.fill('0300');
  await p.waitForSelector('[role="option"]');
  await p.locator('[role="option"] button').first().click();
  await p.waitForFunction(() => { const s = document.querySelector('.bcrm-clientsum'); return s && !/Checking/.test(s.textContent); });

  const cat = p.locator('input[placeholder*="atalogue"]').first();
  await cat.click(); await cat.fill('canva');
  await p.waitForSelector('[role="option"]');
  await p.locator('[role="option"] button').first().click();
  await p.waitForTimeout(300);
}

async function openModal(p) {
  const widget = p.locator('.bcrm-combo').first();
  const reopen = widget.locator('.bcrm-combo-value');
  if (await reopen.count()) await reopen.click();
  const box = widget.locator('input[role="combobox"]');
  await box.fill('zzz-no-match');
  await p.waitForTimeout(500);
  await widget.getByRole('button', { name: /create new client/i }).click();
  await p.waitForSelector('.bcrm-modal');
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.ZEE_CHROMIUM });
  const p = await b.newPage({ viewport: { width: 1440, height: 980 } });
  const fails = [];
  const check = (name, ok, extra) => { console.log(ok ? '  PASS ' + name : '  FAIL ' + name + ' ' + JSON.stringify(extra)); if (!ok) fails.push(name); };

  await p.goto(PAGE, { waitUntil: 'load' });
  await buildValidSale(p);


  const after = await saleCount(p);

  // 1. Enter in the modal's NAME field
  await openModal(p);
  await p.locator('.bcrm-modal input').first().fill('Keyboard Client');
  await p.locator('.bcrm-modal input').first().press('Enter');
  await p.waitForTimeout(500);
  check('Enter in the modal name field does not submit the sale', (await saleCount(p)) === after, await saleCount(p));
  check('Enter in the modal name field does not create a contact', (await contactCount(p)) === 0, await contactCount(p));

  // 2. Enter in a later modal field
  const inputs = p.locator('.bcrm-modal input');
  if (await inputs.count() > 1) { await inputs.nth(1).fill('kb@example.test'); await inputs.nth(1).press('Enter'); await p.waitForTimeout(400); }
  check('Enter in a second modal field does not submit the sale', (await saleCount(p)) === after, await saleCount(p));

  // 3. the X / Close control
  const closeX = p.locator('.bcrm-modal [aria-label="Close"]');
  if (await closeX.count()) { await closeX.click(); await p.waitForTimeout(400); }
  check('Close (X) does not submit the sale', (await saleCount(p)) === after, await saleCount(p));
  check('Close (X) dismisses the modal', (await p.locator('.bcrm-modal').count()) === 0);

  // 4. Cancel
  await openModal(p);
  await p.locator('.bcrm-modal input').first().fill('Cancelled Client');
  await p.getByRole('button', { name: /^cancel$/i }).last().click();
  await p.waitForTimeout(400);
  check('Cancel does not submit the sale', (await saleCount(p)) === after, await saleCount(p));
  check('Cancel creates no contact', (await contactCount(p)) === 0, await contactCount(p));

  // 5. deliberate Save and select -> exactly one contact, still no sale
  await openModal(p);
  await p.locator('.bcrm-modal input').first().fill('Deliberate Client');
  await p.getByRole('button', { name: /save and select/i }).click();
  await p.waitForTimeout(800);
  check('Save and select creates exactly ONE contact', (await contactCount(p)) === 1, await contactCount(p));
  check('Save and select does not submit the sale', (await saleCount(p)) === after, await saleCount(p));

  console.log('\nmodal-only sale submissions:', (await saleCount(p)) - after, '(must be 0)');

  // CONTROL, last because saving navigates away: the parent form really IS submittable in this
  // exact state, so every zero above means isolation rather than an invalid form refusing anyway.
  await p.getByRole('button', { name: /save sale/i }).click();
  await p.waitForTimeout(800);
  check('CONTROL: the same complete sale DOES submit when deliberately saved', (await saleCount(p)) === after + 1, await saleCount(p));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message.split('\n')[0]); process.exit(1); });

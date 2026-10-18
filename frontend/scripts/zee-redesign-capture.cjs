#!/usr/bin/env node
'use strict';
/**
 * Load the redesigned-Zee fixture in REAL Chromium, measure every state and save screenshots.
 *
 * Run the fixture builder first:
 *   cd frontend && CI=true npx craco test --watchAll=false --testPathPattern zeeRedesignFixture
 *   node scripts/zee-redesign-capture.cjs
 *
 * WHAT THIS PROVES: rendered geometry, overflow, touch-target sizes and reduced-motion handling of
 * the real markup and CSS, in a real browser. WHAT IT DOES NOT: it is server-rendered markup, so
 * there is no React runtime — no click actually advances a step here. Live interaction,
 * authenticated routing and the support handoff stay separate and unrun.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const PW = '/opt/node-tools/node_modules/playwright';
const { chromium } = require(PW);

const FIXTURE = process.env.ZEE_FIXTURE || path.join(os.tmpdir(), 'zee-redesign', 'zee-redesign.html');
const OUT = process.env.ZEE_SHOTS || path.join(os.tmpdir(), 'zee-shots');

// SSR bakes framer-motion's INITIAL style into the markup — the panel's `initial` is
// { opacity: 0, y: 16, scale: 0.98 }, and with no runtime there is nothing to animate it to
// `animate: { scale: 1 }`. Every measurement would then be 2% short (336 -> 329.28, 44 -> 43.12,
// both observed). Neutralising the transform measures the panel as the live app paints it once the
// 180ms entrance has run. Opacity is restored for the same reason.
const UNFREEZE = `
  .cga-panel { transform: none !important; opacity: 1 !important; }
`;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error('fixture not found: ' + FIXTURE + '\nRun the zeeRedesignFixture test first.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ── DESKTOP ────────────────────────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await desktop.newPage();
  await page.goto('file://' + FIXTURE);
  await page.waitForSelector('.cga-panel');
  await page.addStyleTag({ content: UNFREEZE });

  const box = async (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);

  const welcome = await box('#cell-welcome .cga-panel');
  const chat = await box('#cell-chat .cga-panel');
  check('welcome panel width is 330-350px', welcome && welcome.w >= 330 && welcome.w <= 350, welcome && welcome.w + 'px');
  check('welcome panel height is 460-520px', welcome && welcome.h >= 460 && welcome.h <= 520, welcome && welcome.h + 'px');
  check('chat panel stays within the viewport bound', chat && chat.h <= 900 - 96, chat && chat.h + 'px');

  const avatar = await page.evaluate(() => {
    const hero = document.querySelector('#cell-welcome .cga-hero svg');
    const head = document.querySelector('#cell-chat .cga-head svg');
    const r1 = hero && hero.getBoundingClientRect();
    const r2 = head && head.getBoundingClientRect();
    return { hero: r1 ? Math.round(r1.width) : null, head: r2 ? Math.round(r2.width) : null };
  });
  check('welcome avatar is ~96px (presence)', avatar.hero >= 88 && avatar.hero <= 104, avatar.hero + 'px');
  check('chat avatar compacts to ~32px', avatar.head >= 28 && avatar.head <= 36, avatar.head + 'px');

  const chips = await page.$$eval('#cell-welcome .cga-chip', (els) => els.length);
  const more = await page.$$eval('#cell-welcome .cga-morelink', (els) => els.length);
  check('exactly three quick chips, not six buttons', chips === 3, chips + ' chips');
  check('More help entry present', more === 1, more + ' link');

  const stepOnly = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('#cell-chat .cga-step-text')];
    const count = document.querySelector('#cell-chat .cga-stepcount');
    return { rendered: texts.length, label: count && count.textContent.trim() };
  });
  check('ONE step rendered, not the whole list', stepOnly.rendered === 1, stepOnly.rendered + ' step');
  check('step progress is labelled in words', /Step 1 of 3/.test(stepOnly.label || ''), stepOnly.label);

  const launcher = await box('#launcher-stage .cga-launcher');
  check('launcher is 60-64px', launcher && launcher.w >= 60 && launcher.w <= 64, launcher && launcher.w + 'px');

  const noXScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal page overflow at 1440', noXScroll, '');

  await page.screenshot({ path: path.join(OUT, '01-desktop-all-states.png'), fullPage: true });
  await page.locator('#cell-welcome .cga-panel').screenshot({ path: path.join(OUT, '02-desktop-welcome.png') });
  await page.locator('#cell-chat .cga-panel').screenshot({ path: path.join(OUT, '03-desktop-chat-step1.png') });
  await page.locator('#cell-chat2 .cga-panel').screenshot({ path: path.join(OUT, '04-desktop-chat-step2.png') });
  await page.locator('#launcher-stage').screenshot({ path: path.join(OUT, '05-launcher.png') });

  // ── MOBILE, with a keyboard-sized viewport reduction ───────────────────────────────────────
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const mp = await phone.newPage();
  await mp.goto('file://' + FIXTURE);
  await mp.waitForSelector('.cga-panel');
  await mp.addStyleTag({ content: UNFREEZE });
  // Measured in the FULL-WIDTH stage: the sheet is width:100% of its containing block, so a 336px
  // cell would understate it.
  const sheet = await mp.evaluate(() => {
    const el = document.querySelector('#mobile-stage .cga-panel');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: Math.round(r.width), radius: cs.borderTopLeftRadius, bottomRadius: cs.borderBottomLeftRadius };
  });
  check('mobile sheet spans the viewport width', sheet && sheet.w >= 386, sheet && sheet.w + 'px');
  check('mobile sheet is rounded at the top only', sheet && sheet.radius !== sheet.bottomRadius,
    sheet && (sheet.radius + ' / ' + sheet.bottomRadius));

  const touch = await mp.$$eval('#cell-welcome .cga-chip, #mobile-stage .cga-input, #mobile-stage .cga-send',
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check('every thumb target is >=44px on mobile', touch.length > 0 && touch.every((h) => h >= 44), touch.join(','));

  const noXPhone = await mp.evaluate(() => {
    const el = document.querySelector('#mobile-stage .cga-panel');
    return el ? el.scrollWidth <= el.clientWidth + 1 : false;
  });
  check('no horizontal overflow inside the sheet at 390', noXPhone, '');

  const scrollers = await mp.evaluate(() => {
    const panel = document.querySelector('#mobile-stage .cga-panel');
    if (!panel) return -1;
    return [...panel.querySelectorAll('*')].filter((e) => {
      const cs = getComputedStyle(e);
      return /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
    }).length;
  });
  check('at most ONE competing scroll region in the sheet', scrollers <= 1, scrollers + ' scrollers');

  await mp.screenshot({ path: path.join(OUT, '06-mobile-390.png'), fullPage: false });
  await mp.locator('#mobile-stage .cga-panel').screenshot({ path: path.join(OUT, '07-mobile-sheet.png') });

  // ── REDUCED MOTION ────────────────────────────────────────────────────────────────────────
  const rm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rm.newPage();
  await rp.goto('file://' + FIXTURE);
  await rp.waitForSelector('.cga-panel');
  await rp.addStyleTag({ content: UNFREEZE });
  const motion = await rp.evaluate(() => {
    const chip = document.querySelector('.cga-chip');
    const fill = document.querySelector('.cga-progress-fill');
    return {
      chip: chip ? getComputedStyle(chip).transitionDuration : null,
      fill: fill ? getComputedStyle(fill).transitionDuration : null,
    };
  });
  check('reduced motion disables chip/progress transitions',
    motion.chip === '0s' && motion.fill === '0s', JSON.stringify(motion));
  await rp.screenshot({ path: path.join(OUT, '08-reduced-motion.png'), fullPage: true });

  // ── BROWSER ZOOM (200%) ───────────────────────────────────────────────────────────────────
  const zoom = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const zp = await zoom.newPage();
  await zp.goto('file://' + FIXTURE);
  await zp.waitForSelector('.cga-panel');
  await zp.addStyleTag({ content: UNFREEZE });
  await zp.evaluate(() => { document.body.style.zoom = '2'; });
  const zoomOverflow = await zp.evaluate(() => {
    const el = document.querySelector('#cell-chat .cga-panel');
    return el ? el.scrollWidth <= el.clientWidth + 1 : false;
  });
  check('no horizontal overflow inside the panel at 200% zoom', zoomOverflow, '');
  await zp.screenshot({ path: path.join(OUT, '09-zoom-200.png'), fullPage: false });

  await browser.close();

  const pass = results.filter((r) => r.pass).length;
  for (const r of results) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  }
  console.log('\n' + pass + '/' + results.length + ' checks passed');
  console.log('screenshots: ' + OUT);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e && e.message); process.exit(1); });

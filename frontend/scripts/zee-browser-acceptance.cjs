#!/usr/bin/env node
'use strict';
/**
 * FIXTURE-BASED browser acceptance for Zee: layout, reduced motion, and the support link.
 *
 * Measures the REAL component markup (server-rendered by
 * src/features/clientAssistant/__tests__/zeeFixture.test.js) against the REAL stylesheets, in a
 * real Chromium at real viewport sizes.
 *
 * WHAT THIS IS NOT, and must not be reported as:
 *   - NOT live staging authorization. No authenticated session, no router, no API. It cannot show
 *     what a signed-out visitor sees, which is the check that proves client-only scope at runtime.
 *   - NOT screen-reader acceptance. No assistive technology is driven; only the attributes an
 *     assistive technology would read are asserted to be present.
 * Both remain unrun — see writehuman-v2/docs/ACCEPTANCE-CHECKS.md rows C4 and C6.
 *
 *   node frontend/scripts/zee-browser-acceptance.cjs [path/to/zee-fixture.html]
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PW = process.env.WH_PLAYWRIGHT || '/opt/node-tools/node_modules/playwright';
const FIXTURE = process.argv[2] || path.join(os.tmpdir(), 'zee-fixture', 'zee-fixture.html');

if (!fs.existsSync(FIXTURE)) {
  console.error(`[zee-acceptance] no fixture at ${FIXTURE}`);
  console.error('Build it first:  cd frontend && CI=true npx craco test --watchAll=false --testPathPattern=zeeFixture');
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); };

async function main() {
  const { chromium } = require(PW);
  const browser = await chromium.launch();
  try {
    // ── 1. Mobile: 390px is the viewport the brief names ────────────────────────────────────────
    for (const [label, size] of [['390x844 (mobile)', { width: 390, height: 844 }],
                                 ['1280x800 (desktop)', { width: 1280, height: 800 }]]) {
      const ctx = await browser.newContext({ viewport: size });
      const page = await ctx.newPage();
      await page.goto('file://' + FIXTURE);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      record(`${label}: no horizontal page scroll`,
        overflow.scrollWidth <= overflow.clientWidth + 1,
        `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`);

      const panel = await page.locator('.cga-panel').boundingBox();
      record(`${label}: panel within the viewport`,
        !!panel && panel.x >= -1 && panel.y >= -1
          && panel.x + panel.width <= size.width + 1,
        panel ? `x=${Math.round(panel.x)} w=${Math.round(panel.width)} vp=${size.width}` : 'panel not found');

      const launcher = await page.locator('button.cga-launcher').boundingBox();
      record(`${label}: launcher inside the viewport`,
        !!launcher && launcher.x >= 0 && launcher.y >= 0
          && launcher.x + launcher.width <= size.width + 1
          && launcher.y + launcher.height <= size.height + 1,
        launcher ? `x=${Math.round(launcher.x)} y=${Math.round(launcher.y)}` : 'launcher not found');

      // The launcher must not sit on top of the client navigation.
      const nav = await page.locator('[data-testid="host-nav"]').boundingBox();
      const overlaps = !!(launcher && nav)
        && launcher.x < nav.x + nav.width && launcher.x + launcher.width > nav.x
        && launcher.y < nav.y + nav.height && launcher.y + launcher.height > nav.y;
      record(`${label}: launcher does not cover client navigation`, !overlaps,
        overlaps ? 'launcher overlaps the nav box' : 'no overlap');

      await ctx.close();
    }

    // ── 2. Accessible attributes present (NOT screen-reader acceptance) ─────────────────────────
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto('file://' + FIXTURE);
      const a11y = await page.evaluate(() => {
        const panel = document.querySelector('.cga-panel');
        const launcher = document.querySelector('button.cga-launcher');
        const live = document.querySelector('.cga-history');
        return {
          role: panel && panel.getAttribute('role'),
          ariaModal: panel && panel.getAttribute('aria-modal'),
          panelLabel: panel && panel.getAttribute('aria-label'),
          launcherLabel: launcher && launcher.getAttribute('aria-label'),
          haspopup: launcher && launcher.getAttribute('aria-haspopup'),
          liveRegion: live && live.getAttribute('aria-live'),
        };
      });
      record('dialog role and label present', a11y.role === 'dialog' && !!a11y.panelLabel,
        `role=${a11y.role} label=${a11y.panelLabel}`);
      record('panel is non-modal (no focus trap required)', a11y.ariaModal === 'false',
        `aria-modal=${a11y.ariaModal}`);
      record('launcher is labelled and announces a dialog',
        !!a11y.launcherLabel && a11y.haspopup === 'dialog',
        `label=${a11y.launcherLabel} haspopup=${a11y.haspopup}`);
      record('guidance region is a polite live region', a11y.liveRegion === 'polite',
        `aria-live=${a11y.liveRegion}`);
      await ctx.close();
    }

    // ── 3. Reduced motion actually disables the avatar animations ──────────────────────────────
    for (const [label, media] of [['reduce', 'reduce'], ['no-preference', 'no-preference']]) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 }, reducedMotion: media === 'reduce' ? 'reduce' : 'no-preference',
      });
      const page = await ctx.newPage();
      await page.goto('file://' + FIXTURE);
      // Probe an element the stylesheet animates, under each media state.
      const anim = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'genz-avatar-breathe';
        document.body.appendChild(probe);
        const name = getComputedStyle(probe).animationName;
        probe.remove();
        return name;
      });
      if (media === 'reduce') {
        record('prefers-reduced-motion: animations disabled', anim === 'none', `animation-name=${anim}`);
      } else {
        record('no-preference: animations active (the rule is conditional, not blanket)',
          anim !== 'none', `animation-name=${anim}`);
      }
      await ctx.close();
    }

    // ── 4. Support link carries nothing sensitive ───────────────────────────────────────────────
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('file://' + FIXTURE);
      const href = await page.locator('#support-probe').getAttribute('href');
      const safe = href && href.startsWith('https://wa.me/')
        && !/sb-|auth-token|Bearer|deviceKey|keyHash|csrf|password/i.test(href);
      record('support handoff is a wa.me link with no credential material', !!safe,
        href ? href.slice(0, 96) + (href.length > 96 ? '…' : '') : 'no href');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n[zee-acceptance] FIXTURE-BASED results (not live staging, not screen-reader):');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('[zee-acceptance] crashed:', e.message); process.exit(1); });

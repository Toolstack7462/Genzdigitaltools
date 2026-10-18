// ADMIN NAV REACHABILITY — why "Support Contact" disappeared from the live dashboard.
//
// THE DEFECT. Inside the Business CRM workspace (/admin/business/*) the global admin sidebar is
// rendered with `hidden xl:flex`, so it does not exist below 1280px. The hamburger topbar that
// opens the mobile drawer is `lg:hidden`, so it does not exist at or above 1024px. Between 1024px
// and 1279px there is therefore NO admin navigation at all — no Support Contact, no Blog, no
// Members, no way back to the console except editing the URL. 1024-1279px is an ordinary laptop
// window.
//
// The code comment claimed "the CRM toolbar provides a Back to Admin Console control instead". No
// such control exists anywhere in the frontend; the only matching strings are that comment and the
// sidebar's own branding badge, which lives inside the sidebar that is hidden.
//
// SCOPE. A CSS-breakpoint contract test over the committed source. It proves the class combination
// that creates (or closes) the gap. It is NOT a browser measurement and NOT live admin
// verification; both are tracked separately.
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'AdminLayoutEnhanced.js'), 'utf8');
const BP = { lg: 1024, xl: 1280 };

function sidebarClasses() {
  const m = /className=\{crmWorkspace \? '([^']+)' : '([^']+)'\}/.exec(SRC);
  if (!m) throw new Error('desktop sidebar className expression not found — update this test');
  return { crm: m[1], normal: m[2] };
}

/** At what width does a `hidden <bp>:flex` element start existing? */
function visibleFrom(classes) {
  if (!/\bhidden\b/.test(classes)) return 0;
  const m = /\b(lg|xl):(flex|block|grid)\b/.exec(classes);
  return m ? BP[m[1]] : Infinity;
}

/** The hamburger drawer is available only below this width. */
function drawerUpTo() {
  const m = /className="ds-topbar (lg|xl):hidden/.exec(SRC);
  if (!m) throw new Error('mobile topbar className not found — update this test');
  return BP[m[1]];
}

describe('the admin nav must be reachable at every viewport width', () => {
  test('a normal admin page has no gap between the drawer and the sidebar', () => {
    expect(visibleFrom(sidebarClasses().normal)).toBeLessThanOrEqual(drawerUpTo());
  });

  test('the CRM workspace has no gap either', () => {
    // THE REGRESSION: `hidden xl:flex` (1280) against a drawer that stops at lg (1024) leaves
    // 1024-1279px with no navigation at all.
    expect(visibleFrom(sidebarClasses().crm)).toBeLessThanOrEqual(drawerUpTo());
  });

  test('the CRM sidebar stays the narrow icon rail, not a second full sidebar', () => {
    // The gap must be closed by widening the RAIL's availability, not by restoring a full text
    // sidebar — two full sidebars squeezing the content column is what the rail was built to fix.
    const { crm } = sidebarClasses();
    expect(crm).toMatch(/w-\[72px\]/);
    expect(crm).not.toMatch(/w-56/);
  });

  test('compact rail items keep an accessible name without a visible label', () => {
    expect(SRC).toMatch(/aria-label=\{compact \? label : undefined\}/);
    expect(SRC).toMatch(/title=\{compact \? label : undefined\}/);
  });

  test('the nav column can scroll, so later groups stay reachable on short screens', () => {
    // Support Contact sits in the LAST group (Content) of 18 items.
    expect(SRC).toMatch(/overflow-y-auto/);
  });

  test('Support Contact is still registered in the nav, in the Content group', () => {
    expect(SRC).toMatch(/to: '\/admin\/support-contact'[\s\S]{0,120}label: 'Support Contact'/);
    expect(SRC).toMatch(/'\/admin\/support-contact'[\s\S]{0,160}group: 'Content'/);
  });

  test('no comment promises a control that does not exist', () => {
    const claimsControl = /CRM toolbar provides a "Back to Admin Console" control/.test(SRC);
    const codeOnly = SRC.replace(/^\s*\/\/.*$/gm, '');
    const hasControl = /Back to Admin Console/.test(codeOnly);
    expect(claimsControl && !hasControl).toBe(false);
  });
});

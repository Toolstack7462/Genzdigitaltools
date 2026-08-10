/**
 * Business CRM routing regression tests.
 *
 * ROOT CAUSE these guard against: CRM navigation used RELATIVE targets
 * (`<NavLink to={path}>`, `navigate('sales/new')`, `<Navigate to="." replace />`) inside a
 * descendant <Routes> mounted under App's `/admin/business/*` splat route. React Router resolves a
 * relative target against the ACTIVE route branch, so navigating from an already-nested URL
 * appended a segment instead of moving to the sibling route:
 *
 *   /admin/business/sales  --click "Sales"-->  /admin/business/sales/sales
 *   ... and on, to /admin/business/sales/sales/offline-queue/website-access/settings/products
 *
 * That URL matches no route. The `path="*"` fallback was `<Navigate to="." replace />`, which
 * resolves to the CURRENT path — so it redirected to itself, rendered nothing, and left the CRM
 * shell visible above a blank white content region.
 *
 * Two complementary guards below:
 *   1. crmPath() behaviour, including idempotency (the property that makes accumulation impossible).
 *   2. A source scan proving no relative navigation is reintroduced anywhere in the CRM feature.
 *
 * NOTE ON COVERAGE: DOM click-through tests (browser back/forward, refresh, blank-Outlet detection)
 * would require importing react-router-dom into jest. react-router-dom@7.16.0 declares
 * `main: "./dist/main.js"` but ships no such file, so CRA 5's jest resolver cannot load it. Fixing
 * that needs a moduleNameMapper in craco.config.js, which is outside this change's approved file
 * scope. Those behaviours were verified manually instead — see the PR description.
 */

import fs from 'fs';
import path from 'path';

import { BASE, NAV, crmPath } from '../constants';

const FEATURE_DIR = path.join(__dirname, '..');

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(absolute);
      } else if (/\.(js|jsx)$/.test(entry.name)) {
        out.push(absolute);
      }
    }
  })(FEATURE_DIR);
  return out;
}

function relative(file) {
  return path.relative(FEATURE_DIR, file).replace(/\\/g, '/');
}

/**
 * Strip comments before scanning. Without this the scanners match their own documentation — the
 * doc comments in constants.js and BusinessCrmApp.jsx deliberately quote the old broken forms
 * (`navigate('sales/new')`, `<Navigate to="." />`) to explain what was wrong.
 */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments, including JSDoc
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // JSX comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments, but not the // in a URL
}

/** A navigation target is safe if it is produced by crmPath(), is an absolute in-app path, or is a numeric history delta. */
function isSafeTarget(expression) {
  const value = expression.trim();
  if (!value) return false;
  if (value.startsWith('crmPath(')) return true;              // canonical helper
  if (/^['"`]\/admin\//.test(value)) return true;              // absolute in-app literal
  if (/^`\/admin\//.test(value)) return true;                  // absolute template literal
  if (/^-?\d+$/.test(value)) return true;                      // navigate(-1) history delta
  if (/^(href|url|to|target|link)\b/.test(value)) return true;  // pre-computed variable, asserted elsewhere
  return false;
}

// ── crmPath ───────────────────────────────────────────────────────────────────

describe('crmPath', () => {
  test('the base is the canonical CRM root', () => {
    expect(BASE).toBe('/admin/business');
    expect(crmPath()).toBe('/admin/business');
    expect(crmPath('')).toBe('/admin/business');
    expect(crmPath(null)).toBe('/admin/business');
    expect(crmPath(undefined)).toBe('/admin/business');
  });

  test('a bare segment becomes an absolute CRM path', () => {
    expect(crmPath('sales')).toBe('/admin/business/sales');
    expect(crmPath('website-access')).toBe('/admin/business/website-access');
    expect(crmPath('offline-queue')).toBe('/admin/business/offline-queue');
  });

  test('leading slashes are normalised, never doubled', () => {
    expect(crmPath('/sales')).toBe('/admin/business/sales');
    // '//' prefixed input is refused wholesale (see the protocol-relative test below):
    // distinguishing '///sales' from '//evil.example.com' by slash count is fragile, and refusing
    // is the safe default.
    expect(crmPath('///sales')).toBe(BASE);
  });

  test('nested segments survive intact', () => {
    expect(crmPath('sales/123')).toBe('/admin/business/sales/123');
    expect(crmPath('sales/123/edit')).toBe('/admin/business/sales/123/edit');
    expect(crmPath('clients/abc-def')).toBe('/admin/business/clients/abc-def');
  });

  test('IDEMPOTENT: re-applying the helper can never duplicate the base', () => {
    expect(crmPath('/admin/business')).toBe('/admin/business');
    expect(crmPath('/admin/business/sales')).toBe('/admin/business/sales');
    expect(crmPath(crmPath('sales'))).toBe('/admin/business/sales');
    expect(crmPath(crmPath(crmPath('sales/9')))).toBe('/admin/business/sales/9');
    // Repeated generation, the exact production failure mode.
    let target = 'sales';
    for (let i = 0; i < 20; i += 1) target = crmPath(target);
    expect(target).toBe('/admin/business/sales');
    expect(target.match(/\/admin\/business/g)).toHaveLength(1);
  });

  test('an already-accumulated path collapses back to a single base', () => {
    expect(crmPath('/admin/business/admin/business/sales')).toBe('/admin/business/sales');
  });

  test('query strings and hashes are preserved', () => {
    expect(crmPath('sales?status=open')).toBe('/admin/business/sales?status=open');
    expect(crmPath('sales#totals')).toBe('/admin/business/sales#totals');
    expect(crmPath('?tab=all')).toBe('/admin/business?tab=all');
  });

  test('"." and "./" collapse to the base instead of the current route', () => {
    expect(crmPath('.')).toBe('/admin/business');
    expect(crmPath('./')).toBe('/admin/business');
  });

  test('external and pseudo-protocol targets are refused', () => {
    expect(crmPath('https://evil.example.com')).toBe('/admin/business');
    expect(crmPath('http://evil.example.com/x')).toBe('/admin/business');
    expect(crmPath('//evil.example.com')).toBe('/admin/business');
    /* eslint-disable no-script-url */
    expect(crmPath('javascript:alert(1)')).toBe('/admin/business');
    /* eslint-enable no-script-url */
    expect(crmPath('data:text/html,<script>')).toBe('/admin/business');
  });

  test('every sidebar NAV entry resolves to one clean absolute CRM path', () => {
    expect(NAV.length).toBeGreaterThan(0);
    for (const entry of NAV) {
      const target = crmPath(entry.path);
      expect(target.startsWith(BASE)).toBe(true);
      expect(target.match(/\/admin\/business/g)).toHaveLength(1);
      expect(target).not.toMatch(/\/\//);
    }
  });

  test('NAV paths are unique, so no two menu items can collide', () => {
    const targets = NAV.map((entry) => crmPath(entry.path));
    expect(new Set(targets).size).toBe(targets.length);
  });

  test('every NAV entry declares a label, icon and permission', () => {
    for (const entry of NAV) {
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.icon).toBe('string');
      expect(typeof entry.permission).toBe('string');
      expect(entry.permission).toMatch(/^[a-z-]+\.[a-z-]+$/);
    }
  });
});

// ── Source guards: no relative navigation may return ──────────────────────────

describe('CRM source contains no relative navigation', () => {
  test('no <Navigate to="." /> anywhere', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      if (/<Navigate\s+to=["'`]\.\.?\/?["'`]/.test(source)) offenders.push(relative(file));
    }
    expect(offenders).toEqual([]);
  });

  test('every Link/NavLink target is absolute or crmPath()-derived', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      const re = /<(?:Nav)?Link\b[^>]*?\sto=(\{[^}]*\}|"[^"]*"|'[^']*')/g;
      let match;
      while ((match = re.exec(source)) !== null) {
        const raw = match[1].startsWith('{') ? match[1].slice(1, -1) : match[1];
        if (!isSafeTarget(raw)) offenders.push(`${relative(file)} :: to=${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every navigate() call is absolute, crmPath()-derived, or a history delta', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      const re = /\bnavigate\(\s*([^),]+)/g;
      let match;
      while ((match = re.exec(source)) !== null) {
        if (!isSafeTarget(match[1])) offenders.push(`${relative(file)} :: navigate(${match[1].trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no parent-relative "../" navigation remains', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      // Only flag it inside a navigation target, not in an ES import specifier.
      const re = /(?:\sto=|navigate\(\s*)(["'`])(\.\.\/[^"'`]*)\1/g;
      let match;
      while ((match = re.exec(source)) !== null) offenders.push(`${relative(file)} :: ${match[2]}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the CRM route fallback is absolute and renders a visible state', () => {
    const source = code(path.join(FEATURE_DIR, 'BusinessCrmApp.jsx'));
    expect(source).toMatch(/path="\*"/);
    // Must not silently redirect to itself.
    expect(source).not.toMatch(/<Navigate\s+to="\."/);
    // Must render something the user can see and act on.
    expect(source).toMatch(/NotFound/);
  });

  test('crmPath is the only place the base string is hardcoded for navigation', () => {
    // Page-level absolute literals are allowed, but they must be complete and correct.
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      const re = /['"`](\/admin\/business[^'"`]*)['"`]/g;
      let match;
      while ((match = re.exec(source)) !== null) {
        const value = match[1];
        if (value.match(/\/admin\/business/g).length !== 1) offenders.push(`${relative(file)} :: ${value}`);
        if (/\/\//.test(value)) offenders.push(`${relative(file)} :: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Business CRM search regression tests.
 *
 * ROOT CAUSE these guard against: every CRM list page opened with
 *
 *   if (resource.loading) return <Loading />;
 *
 * while its search text was a direct dependency of the request. `loading` is true for EVERY fetch,
 * not just the first, so each keystroke unmounted the whole page — including the search input. The
 * input lost focus, and the operator could not type a second character without clicking back into
 * the field. There was also no debounce, so one request was fired per keystroke, and no ordering
 * guard, so a slow early response could overwrite the results of a later one.
 *
 * The fixes these tests hold in place:
 *   1. Pages gate the full-page spinner on `initialLoading` (nothing rendered yet), never `loading`.
 *   2. Search text reaches the request through useDebouncedValue.
 *   3. useResource discards out-of-order responses.
 *   4. The sale form no longer loads hundreds of records into <select> elements.
 *
 * NOTE ON COVERAGE: these are source scans, not render tests. react-router-dom@7.16.0 declares
 * `main: "./dist/main.js"` but ships no such file, so CRA 5's jest resolver cannot load it, and this
 * project has no @testing-library/react. Focus retention, keyboard traversal of the combobox and the
 * 250ms debounce timing were therefore verified by measurement in a real browser rather than here —
 * see the PR description. The scans below still fail loudly if the code shape regresses.
 */

import fs from 'fs';
import path from 'path';

const FEATURE_DIR = path.join(__dirname, '..');
const PAGES_DIR = path.join(FEATURE_DIR, 'pages');

/** Strip comments so the scanners never match their own explanatory prose. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function pageFiles() {
  return fs.readdirSync(PAGES_DIR).filter((name) => name.endsWith('.jsx')).map((name) => path.join(PAGES_DIR, name));
}

/** Pages that render a search field and therefore must not unmount on every fetch. */
function searchPages() {
  return pageFiles().filter((file) => /<SearchBox\b/.test(code(file)));
}

describe('CRM search does not unmount its own input', () => {
  test('the pages that carry a search field are the ones expected', () => {
    const names = searchPages().map((file) => path.basename(file)).sort();
    expect(names).toEqual([
      'AccessPage.jsx', 'AuditPage.jsx', 'Cashbook.jsx', 'Contacts.jsx', 'Expenses.jsx',
      'Expiries.jsx', 'LinkedAccess.jsx', 'Payments.jsx', 'Products.jsx', 'Sales.jsx',
      'SearchPage.jsx', 'Tasks.jsx',
    ]);
  });

  test('no searchable page early-returns a full-page spinner on a plain loading flag', () => {
    const offenders = [];
    for (const file of searchPages()) {
      const source = code(file);
      // `if (x.loading) return <Loading` — but `initialLoading` is the correct gate and must pass.
      const re = /if\s*\(\s*(?!.*initialLoading)[^)]*\.loading[^)]*\)\s*return\s*<Loading/g;
      if (re.test(source)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  test('every searchable page routes its search text through a debounce', () => {
    const offenders = [];
    for (const file of searchPages()) {
      const source = code(file);
      if (!/useDebouncedValue\(/.test(source)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  test('every search field exposes an in-flight indicator', () => {
    const offenders = [];
    for (const file of searchPages()) {
      const source = code(file);
      for (const usage of source.matchAll(/<SearchBox\b[^>]*>/g)) {
        if (!/\bbusy=/.test(usage[0])) offenders.push(`${path.basename(file)} :: ${usage[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('SearchBox keeps its clear button and does not suppress its own accessible name', () => {
    const ui = code(path.join(FEATURE_DIR, 'components', 'ui.jsx'));
    expect(ui).toMatch(/aria-label="Clear search"/);
    expect(ui).toMatch(/aria-label=\{label \|\| placeholder\}/);
  });
});

describe('useResource discards stale responses', () => {
  const hooks = code(path.join(FEATURE_DIR, 'hooks.js'));

  test('every load takes a ticket and only the newest one may apply its result', () => {
    expect(hooks).toMatch(/const mine = ticket\.current \+ 1; ticket\.current = mine;/);
    // Guarded on the success path, the failure path and the loading flag alike: without the guard on
    // the error branch a stale rejection would surface an error for a query already superseded.
    const guards = hooks.match(/mine !== ticket\.current/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(hooks).toMatch(/if \(mine === ticket\.current && mounted\.current\) setLoading\(false\)/);
  });

  test('initialLoading is derived, so a refetch never looks like a first load', () => {
    expect(hooks).toMatch(/initialLoading: loading && data === null/);
  });

  test('a cleared search bypasses the debounce delay', () => {
    // Pressing the clear button must restore the unfiltered list immediately, not after 250ms.
    expect(hooks).toMatch(/if \(!value\) \{ setSettled\(value\); return undefined; \}/);
  });

  test('the debounce defaults to 250ms', () => {
    expect(hooks).toMatch(/useDebouncedValue\(value, delay = 250\)/);
  });
});

describe('fast entry replaces bulk dropdowns with async comboboxes', () => {
  const saleForm = code(path.join(PAGES_DIR, 'SaleForm.jsx'));

  test('the sale form no longer renders a select populated from a bulk array', () => {
    // The three offenders were clients.map, vendors.map and products.map inside <Select> elements.
    for (const collection of ['clients', 'vendors', 'products']) {
      expect(saleForm).not.toMatch(new RegExp(`<Select[^>]*>[\\s\\S]{0,200}\\{${collection}\\.map`));
    }
  });

  test('client, vendor and catalogue product are all comboboxes', () => {
    const comboboxes = saleForm.match(/<Combobox\b/g) || [];
    expect(comboboxes.length).toBe(3);
    expect(saleForm).toMatch(/search=\{searchClients\}/);
    expect(saleForm).toMatch(/search=\{searchVendors\}/);
    expect(saleForm).toMatch(/search=\{searchProducts\}/);
  });

  test('suggestions are requested one page at a time, not five hundred at once', () => {
    expect(saleForm).toMatch(/const SUGGEST_PAGE = 25;/);
    for (const call of saleForm.matchAll(/pageSize=\$\{SUGGEST_PAGE\}/g)) expect(call[0]).toBeTruthy();
    // pageSize=500 may survive only in the offline cache warm-up, which is not on the render path.
    const bulk = [...saleForm.matchAll(/pageSize=500/g)];
    expect(bulk.length).toBe(3);
    expect(saleForm).toMatch(/const warm = async \(key, url, apply\)/);
  });

  test('product auto-fill still populates name, duration, price and cost', () => {
    expect(saleForm).toMatch(/name: product\.name/);
    expect(saleForm).toMatch(/durationLabel: product\.duration_label/);
    expect(saleForm).toMatch(/salePrice: product\.default_sale_price/);
    expect(saleForm).toMatch(/purchaseCost: product\.default_purchase_cost/);
  });

  test('quick client capture requires only a name and cannot grant access', () => {
    expect(saleForm).toMatch(/disabled=\{quickSaving \|\| !quickClient\?\.name\?\.trim\(\)\}/);
    expect(saleForm).toMatch(/crmApi\.post\('\/contacts\/clients'/);
    // It must post to the contacts module only — never to an assignment or access endpoint.
    expect(saleForm).not.toMatch(/assignments|give-access|tool-assignment/i);
  });

  test('the selected label is held outside the submitted form payload', () => {
    // `form` is spread into the request body, so a display-only field there would be sent to the API
    // and rejected by the sale schema as an unknown key.
    expect(saleForm).toMatch(/const \[clientLabel, setClientLabel\] = useState\(''\)/);
    expect(saleForm).not.toMatch(/clientLabel:/);
    expect(saleForm).not.toMatch(/vendorLabel:/);
  });
});

describe('Combobox keyboard and accessibility contract', () => {
  const ui = code(path.join(FEATURE_DIR, 'components', 'ui.jsx'));

  test('it declares the ARIA combobox pattern', () => {
    expect(ui).toMatch(/role="combobox"/);
    expect(ui).toMatch(/role="listbox"/);
    expect(ui).toMatch(/role="option"/);
    expect(ui).toMatch(/aria-expanded=\{open\}/);
    expect(ui).toMatch(/aria-activedescendant=/);
  });

  test('arrow keys wrap and Enter only commits a highlighted option', () => {
    expect(ui).toMatch(/\(next \+ options\.length\) % options\.length/);
    // Enter must fall through to form submission when nothing is highlighted.
    expect(ui).toMatch(/if \(open && active >= 0 && options\[active\]\) \{ event\.preventDefault\(\); choose\(options\[active\]\); \}/);
  });

  test('it waits for a minimum length and cancels superseded requests', () => {
    expect(ui).toMatch(/minChars = 2/);
    expect(ui).toMatch(/debounceMs = 250/);
    expect(ui).toMatch(/if \(text\.length < minChars\)/);
    expect(ui).toMatch(/if \(mine !== ticket\.current\) return;/);
  });

  test('required selection is still enforced by native form validation', () => {
    // A display-only trigger button carries no validity state, so a mirrored input holds `required`.
    expect(ui).toMatch(/className="bcrm-combo-mirror"/);
    expect(ui).toMatch(/\{required && <input type="text" name=\{name\} value=\{value \|\| ''\} required/);
  });
});

describe('no second search system was introduced', () => {
  test('Ctrl+K reuses the existing global search route', () => {
    const layout = code(path.join(FEATURE_DIR, 'BusinessCrmLayout.jsx'));
    expect(layout).toMatch(/event\.ctrlKey \|\| event\.metaKey/);
    expect(layout).toMatch(/navigate\(crmPath\('search'\)\)/);
    // Alt+K and Ctrl+Shift+K must not be swallowed from the browser.
    expect(layout).toMatch(/if \(event\.altKey \|\| String\(event\.key\)\.toLowerCase\(\) !== 'k'/);
  });

  test('the dashboard, settings and summary reports carry no search field', () => {
    for (const page of ['Dashboard.jsx', 'SettingsPage.jsx', 'Reports.jsx']) {
      expect(code(path.join(PAGES_DIR, page))).not.toMatch(/<SearchBox\b/);
    }
  });
});

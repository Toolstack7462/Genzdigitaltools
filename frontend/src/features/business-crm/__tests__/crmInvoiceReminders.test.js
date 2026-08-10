/**
 * Guards for the reminder preview and the invoice branding preview.
 *
 * ROOT CAUSE these guard against: all three reminder flows called
 *
 *   const response = await crmApi.post('/operations/reminders/prepare', …);
 *   window.open(response.data.url, …);
 *
 * A popup opened outside a user gesture is blocked by default in Chrome and Safari, so the WhatsApp
 * tab silently never appeared — while the reminder had already been recorded as prepared, and then
 * immediately marked "opened". The operator also never saw the text before it went to a customer.
 *
 * The message now goes through a preview dialog and WhatsApp is opened from its button, which IS a
 * gesture. These scans hold that shape in place, and hold the security boundary that no customer
 * message or invoice preview may render credentials or an operator-supplied remote image.
 *
 * NOTE ON COVERAGE: source scans, not render tests — react-router-dom@7.16.0 ships no resolvable
 * `main` for CRA 5's jest resolver and this project has no @testing-library/react. Clipboard copy,
 * dialog keyboard behaviour and the mobile layout were verified by browser measurement instead.
 */

import fs from 'fs';
import path from 'path';

const FEATURE_DIR = path.join(__dirname, '..');
const PAGES_DIR = path.join(FEATURE_DIR, 'pages');

function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const REMINDER_PAGES = ['SaleDetail.jsx', 'Payments.jsx', 'Expiries.jsx'];

describe('reminder sending is reviewed and gesture-driven', () => {
  test('every page that prepares a reminder is accounted for', () => {
    const preparing = fs.readdirSync(PAGES_DIR)
      .filter((name) => name.endsWith('.jsx'))
      .filter((name) => /reminders\/prepare/.test(code(path.join(PAGES_DIR, name))))
      .sort();
    expect(preparing).toEqual([...REMINDER_PAGES].sort());
  });

  test('no page opens a window directly from the prepare response', () => {
    const offenders = [];
    for (const name of REMINDER_PAGES) {
      const source = code(path.join(PAGES_DIR, name));
      if (/window\.open\(\s*response\.data\.url/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test('each page shows the prepared message in a preview before sending', () => {
    for (const name of REMINDER_PAGES) {
      const source = code(path.join(PAGES_DIR, name));
      expect(source).toMatch(/<MessagePreview/);
      expect(source).toMatch(/setReminder\(response\.data\)/);
      // The window is opened by the dialog's own handler, which runs from a click.
      expect(source).toMatch(/const sendReminder = async \(url\) =>|const sendReminder=async url=>/);
      expect(source).toMatch(/window\.open\(url, '_blank', 'noopener,noreferrer'\)|window\.open\(url,'_blank','noopener,noreferrer'\)/);
    }
  });

  test('the reminder is only marked opened once it has actually been opened', () => {
    for (const name of REMINDER_PAGES) {
      const source = code(path.join(PAGES_DIR, name));
      const open = source.search(/window\.open\(url/);
      const marked = source.search(/reminders\/\$\{reminder\.id\}\/opened/);
      expect(open).toBeGreaterThan(-1);
      expect(marked).toBeGreaterThan(open);
      // A failed audit ping must not throw away the message the operator just sent.
      expect(source).toMatch(/catch\s*\{/);
    }
  });

  test('every window.open carries noopener so the opened tab cannot reach back', () => {
    // Without noopener the new tab keeps a live window.opener handle to the admin session. Scanned
    // across the whole feature, not just the reminder pages, because the invoice-PDF buttons had the
    // same gap. The argument list is read to the end of the statement rather than to the first ')',
    // so a call wrapping a helper — window.open(crmApi.rawUrl(`…`), …) — is not truncated.
    const offenders = [];
    for (const name of fs.readdirSync(PAGES_DIR).filter((file) => file.endsWith('.jsx'))) {
      const source = code(path.join(PAGES_DIR, name));
      for (const call of source.matchAll(/window\.open\(/g)) {
        const tail = source.slice(call.index, source.indexOf('\n', call.index));
        if (!/noopener/.test(tail)) offenders.push(`${name}: ${tail.trim().slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('MessagePreview contract', () => {
  const ui = code(path.join(FEATURE_DIR, 'components', 'ui.jsx'));

  test('the message is read-only, labelled, and copyable', () => {
    expect(ui).toMatch(/export function MessagePreview/);
    expect(ui).toMatch(/readOnly/);
    expect(ui).toMatch(/aria-label="Prepared message text"/);
    expect(ui).toMatch(/Copy message/);
    // A clipboard failure must be reported, not swallowed into a dead button.
    expect(ui).toMatch(/Copy is unavailable in this browser/);
    // Works without a secure context, where navigator.clipboard is undefined.
    expect(ui).toMatch(/document\.execCommand\('copy'\)/);
  });

  test('Textarea merges className so the preview keeps its base styling', () => {
    // Spreading props over a hardcoded className would replace .bcrm-input entirely.
    expect(ui).toMatch(/export function Textarea\(\{ className = '', \.\.\.props \}\)/);
    expect(ui).toMatch(/`bcrm-input bcrm-textarea \$\{className\}`/);
  });

  test('the preview renders no credential or money-internal field', () => {
    const previewBlock = ui.slice(ui.indexOf('export function MessagePreview'), ui.indexOf('export function SearchBox'));
    for (const forbidden of ['credential', 'password', 'purchase', 'profit', 'cost']) {
      expect(previewBlock.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('invoice branding preview', () => {
  const settings = code(path.join(PAGES_DIR, 'SettingsPage.jsx'));

  test('it previews the header using the bundled brand asset', () => {
    expect(settings).toMatch(/import invoiceLogo from '\.\.\/\.\.\/\.\.\/assets\/brand\/logo-genz-digital-store\.png'/);
    expect(settings).toMatch(/<img src=\{invoiceLogo\}/);
    expect(settings).toMatch(/BUSINESS INVOICE/);
    expect(settings).toMatch(/Invoice header preview/);
  });

  test('it never renders the operator-supplied logo URL as an image', () => {
    // form.logoUrl is free text an operator can set. Rendering it as an <img src> would let a
    // settings edit make every admin browser issue a request to an arbitrary host.
    expect(settings).not.toMatch(/<img[^>]*src=\{form\.logoUrl\}/);
    expect(settings).not.toMatch(/backgroundImage[^}]*logoUrl/);
  });

  test('the preview states the payment statuses the PDF can show', () => {
    for (const status of ['Paid', 'Partially Paid', 'Pending', 'Cancelled']) {
      expect(settings).toContain(status);
    }
  });

  test('the credential policy controls and their warning are untouched', () => {
    expect(settings).toMatch(/includeCredentialsInInvoice/);
    expect(settings).toMatch(/includeCredentialsInMessages/);
    expect(settings).toMatch(/Viewer access never receives decrypted credential fields/);
  });
});

describe('branding preview styling is scoped and responsive', () => {
  const css = fs.readFileSync(path.join(FEATURE_DIR, 'business-crm-responsive.css'), 'utf8');

  test('every new rule is scoped to the CRM namespace', () => {
    const blocks = [...css.matchAll(/^\.([a-z-]+)/gm)].map((m) => m[1]);
    const unscoped = blocks.filter((name) => !name.startsWith('bcrm-'));
    expect(unscoped).toEqual([]);
  });

  test('the preview stacks rather than squashing on a narrow screen', () => {
    expect(css).toMatch(/\.bcrm-invoice-preview-meta \{ margin-left: auto/);
    expect(css).toMatch(/@media \(max-width: 480px\)/);
    // Long store names and addresses must wrap, never force the page to scroll sideways.
    expect(css).toMatch(/\.bcrm-invoice-preview-bar strong \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.bcrm-invoice-preview-body p \{[^}]*overflow-wrap: anywhere/);
    // The message keeps its line breaks, which is how it arrives in WhatsApp.
    expect(css).toMatch(/\.bcrm-message-preview \{[^}]*white-space: pre-wrap/);
  });

  test('no blanket overflow suppression was introduced', () => {
    const added = css.slice(css.indexOf('Invoice header preview (Settings)'));
    expect(added).not.toMatch(/overflow-x:\s*hidden/);
  });
});

describe('the payment reminder action is gated on an outstanding balance', () => {
  const saleDetail = code(path.join(PAGES_DIR, 'SaleDetail.jsx'));
  const payments = code(path.join(PAGES_DIR, 'Payments.jsx'));

  test('SaleDetail derives an outstanding flag that excludes cancelled invoices', () => {
    expect(saleDetail).toMatch(/const clientOutstanding = sale\.status !== 'cancelled' && Number\(sale\.client_pending \?\? 0\) > 0;/);
  });

  test('SaleDetail only offers the client payment reminder when something is owed', () => {
    // The enabled button must sit on the true branch of clientOutstanding.
    expect(saleDetail).toMatch(/clientOutstanding \? <Button[^>]*onClick=\{\(\) => prepareReminder\('client_pending'\)\}/);
    // The false branch renders a disabled control that explains itself, rather than nothing at all.
    expect(saleDetail).toMatch(/: <Button variant="ghost" icon=\{MessageCircle\} disabled title=/);
    expect(saleDetail).toMatch(/fully paid, so there is no outstanding balance to remind about/);
    expect(saleDetail).toMatch(/cancelled, so no payment reminder can be sent/);
  });

  test('SaleDetail gates the vendor reminder on the field the API actually returns', () => {
    // salesService exposes vendor_due, not vendor_pending; the wrong name would disable it always.
    expect(saleDetail).toMatch(/Number\(sale\.vendor_due \?\? 0\) > 0 \?/);
    expect(saleDetail).not.toMatch(/vendor_pending/);
  });

  test('Payments hides the reminder on a settled row and refuses to prepare one', () => {
    expect(payments).toMatch(/Number\(row\.pending_amount \?\? 0\) > 0 && <Button[^>]*onClick=\{\(\) => remind\(row\)\}/);
    // Belt and braces: even if a stale row is clicked, no request is sent.
    expect(payments).toMatch(/if \(Number\(row\.pending_amount \?\? 0\) <= 0\) \{ setError\(/);
    expect(payments).toMatch(/no outstanding balance, so no payment reminder was prepared/);
  });

  test('Payments reloads when the server reports the invoice is no longer payable', () => {
    // The row was settled elsewhere; leaving a stale "Pending" figure next to an error is worse than
    // refreshing the list.
    expect(payments).toMatch(/requestError\?\.response\?\.data\?\.code === 'REMINDER_NOT_PAYABLE'/);
    expect(payments).toMatch(/resource\.reload\(\)/);
  });

  test('no reminder page invents its own message text', () => {
    // Wording lives in reminderTemplates.js on the server. A second copy in the UI would drift.
    for (const name of REMINDER_PAGES) {
      const source = code(path.join(PAGES_DIR, name));
      expect(source).not.toMatch(/Hello \$\{|friendly payment reminder|due for renewal/);
    }
  });
});

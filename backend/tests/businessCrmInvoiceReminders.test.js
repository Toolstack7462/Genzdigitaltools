'use strict';

/**
 * Guards for the branded invoice PDF and the English reminder templates.
 *
 * Each test encodes a defect that was actually present, or a boundary whose violation would be silent
 * rather than loud:
 *
 * 1. Invoice number and date were drawn in black (`0 g`) directly onto the near-black header band, so
 *    they were present in the file and invisible on screen. A colour must be set before they are
 *    written and it must not be the black reset.
 * 2. Non-ASCII text (the em dash in product names, the bullet joining footer contacts, the ellipsis
 *    added by truncate) was written as raw UTF-8 into fonts with no declared encoding, rendering as
 *    dropped characters and stray quotation marks.
 * 3. /Length was measured as utf8 while the stream is written as latin1 — equal for ASCII, wrong the
 *    moment a WinAnsi high byte appears, which produces a structurally invalid PDF.
 * 4. The customer invoice must never carry purchase cost or profit, and must not carry credentials
 *    unless BOTH the settings policy and the caller's permission allowed it (enforced in the route).
 * 5. Customer-facing templates must be English only. They were mixed Roman Urdu/English.
 * 6. A message that leaves the system cannot be recalled, so no template may interpolate credentials,
 *    cost, profit or vendor pricing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'business-crm');
const { buildInvoicePdf, pdfEscape, paymentStatus } = require('../modules/business-crm/invoicePdf');
const { loadInvoiceLogo, LOGO_PATH } = require('../modules/business-crm/invoiceLogo');
const templates = require('../modules/business-crm/reminderTemplates');

/** Strip comments so the scanners never match their own explanatory prose. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SETTINGS = {
  store_name: 'Gen Z Digital Store', store_email: 'support@example.invalid',
  store_phone: '+92 300 0000000', store_address: 'Lahore, Pakistan',
  invoice_terms: 'Payment due within 7 days.',
};
const SALE = {
  invoice_number: 'GDS-000142', sale_date: '2026-08-10', status: 'open',
  client_name: 'Ahmed Raza', client_company: 'Raza Digital', client_email: 'a@example.invalid',
  client_whatsapp: '+92 301 2345678', currency_code: 'PKR',
  subtotal_sale: '4500.00', subtotal_cost: '3333.33', client_paid: '1000.00',
  items: [{ name: 'ChatGPT Plus — Private Account', account_type: 'private', duration_label: '1 Month', expiry_date: '2026-09-10', sale_price: '4500.00', purchase_cost: '3333.33' }],
};

// ── Payment status ───────────────────────────────────────────────────────────────────────────────

test('payment status covers paid, partially paid, pending and cancelled', () => {
  assert.equal(paymentStatus({ subtotal_sale: '100.00', client_paid: '100.00' }).label, 'PAID');
  assert.equal(paymentStatus({ subtotal_sale: '100.00', client_paid: '40.00' }).label, 'PARTIALLY PAID');
  assert.equal(paymentStatus({ subtotal_sale: '100.00', client_paid: '0.00' }).label, 'PENDING');
  // Cancelled outranks the ledger: the amounts are no longer owed whatever was received.
  assert.equal(paymentStatus({ status: 'cancelled', subtotal_sale: '100.00', client_paid: '100.00' }).label, 'CANCELLED');
  assert.equal(paymentStatus({ status: 'CANCELLED', subtotal_sale: '100.00', client_paid: '0.00' }).label, 'CANCELLED');
});

test('payment status is float-safe and does not call a zero-total invoice paid', () => {
  // 0.1 + 0.2 style drift must not leave a settled invoice reading "Partially Paid".
  assert.equal(paymentStatus({ subtotal_sale: '0.30', client_paid: String(0.1 + 0.2) }).label, 'PAID');
  // An empty invoice has nothing to pay, but calling it PAID would be misleading.
  assert.equal(paymentStatus({ subtotal_sale: '0.00', client_paid: '0.00' }).label, 'PENDING');
  // Overpayment still reads as paid rather than falling through to partial.
  assert.equal(paymentStatus({ subtotal_sale: '100.00', client_paid: '150.00' }).label, 'PAID');
});

// ── PDF structure and branding ───────────────────────────────────────────────────────────────────

test('the invoice embeds the brand logo as an image with an alpha mask', () => {
  const logo = loadInvoiceLogo();
  assert.ok(logo, `logo asset must be readable at ${LOGO_PATH}`);
  assert.ok(logo.width > 0 && logo.height > 0);
  const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
  assert.match(pdf, /\/Subtype \/Image/);
  assert.match(pdf, /\/SMask \d+ 0 R/, 'transparency requires a separate soft mask');
  assert.match(pdf, /\/XObject << \/Im1 \d+ 0 R >>/);
  assert.match(pdf, /\/Im1 Do/, 'the image must actually be drawn');
  // Drawn inside a save/restore pair so the scaling matrix cannot leak into later text.
  assert.match(pdf, /q 46 0 0 46 42 776 cm \/Im1 Do Q/);
});

test('a missing logo degrades the header instead of failing the invoice', () => {
  // Proven against the real module rather than a stub: the loader swallows read/decode errors and
  // returns null, and the builder is expected to omit the image and still produce a valid document.
  const invoiceLogo = require('../modules/business-crm/invoiceLogo');
  const original = fs.readFileSync;
  invoiceLogo.resetInvoiceLogoCache();
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === invoiceLogo.LOGO_PATH) throw new Error('simulated missing asset');
    return original(file, ...rest);
  };
  try {
    assert.equal(invoiceLogo.loadInvoiceLogo(), null);
    const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
    assert.ok(!pdf.includes('/Im1 Do'), 'no image should be drawn when the asset is unavailable');
    assert.match(pdf, /^%PDF-1\.4/);
    assert.ok(pdf.includes('Gen Z Digital Store'), 'the store name must still appear');
    assert.ok(pdf.trimEnd().endsWith('%%EOF'));
  } finally {
    fs.readFileSync = original;
    invoiceLogo.resetInvoiceLogoCache();
  }
});

test('invoice number and date are written in a light colour, not the black reset', () => {
  const source = code(path.join(MODULE_DIR, 'invoicePdf.js'));
  // Locate the header block and prove a non-black fill precedes each of the two writes.
  const numberIndex = source.indexOf('numberText, \'F2\'');
  const dateIndex = source.indexOf('dateText, \'F1\'');
  assert.ok(numberIndex > 0 && dateIndex > 0, 'header writes not found');
  const beforeNumber = source.slice(0, numberIndex);
  const beforeDate = source.slice(0, dateIndex);
  assert.match(beforeNumber.slice(-160), /1 1 1 rg/, 'the invoice number must be set to white first');
  assert.match(beforeDate.slice(-200), /0\.78 0\.88 0\.95 rg/, 'the date must be set to a light tint first');
  const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
  const drawn = pdf.slice(pdf.indexOf('GDS-000142') - 80, pdf.indexOf('GDS-000142'));
  assert.ok(!/\b0 g\s*$/.test(drawn), 'the invoice number must not be drawn immediately after a black reset');
});

test('fonts declare WinAnsiEncoding and typography maps to WinAnsi bytes', () => {
  const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
  assert.match(pdf, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  // Escapes, not raw UTF-8: em dash 0x97 = \227, bullet 0x95 = \225, ellipsis 0x85 = \205.
  assert.equal(pdfEscape('a — b'), 'a \\227 b');
  assert.equal(pdfEscape('x • y'), 'x \\225 y');
  assert.equal(pdfEscape('cut…'), 'cut\\205');
  // The em dash in the item name must reach the stream as an escape, never as the UTF-8 bytes.
  assert.ok(pdf.includes('ChatGPT Plus \\227 Private Account'));
  assert.ok(!pdf.includes('—'), 'no raw UTF-8 em dash may appear in the content stream');
});

test('pdfEscape neutralises PDF string syntax and unrepresentable characters', () => {
  assert.equal(pdfEscape('a(b)c'), 'a\\(b\\)c');
  assert.equal(pdfEscape('back\\slash'), 'back\\\\slash');
  assert.equal(pdfEscape('line\nbreak'), 'line break');
  // Latin-1 accents survive as WinAnsi bytes; scripts with no glyph become a visible marker rather
  // than an unrelated letter.
  assert.equal(pdfEscape('é'), '\\351');
  assert.equal(pdfEscape('عربى'), '????');
  assert.equal(pdfEscape(null), '');
});

test('every content stream declares its true byte length and stays pure ASCII', () => {
  // A /Length that disagrees with the bytes written produces a file some viewers silently repair and
  // others reject.
  //
  // HONEST SCOPE: /Length is now measured as latin1 to match how the stream is written, but that
  // change is defensive rather than observable — pdfEscape emits every non-ASCII character as an
  // ASCII octal escape (\227 is four ASCII bytes), so utf8 and latin1 byte counts are currently
  // identical and swapping them back does NOT fail this test. The invariant that actually keeps the
  // two measurements equal is asserted directly below: content streams contain no byte above 0x7e.
  // If that ever stops holding, the latin1 measurement is the correct one and this test will catch
  // the disagreement.
  const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
  const declarations = [...pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)];
  assert.ok(declarations.length >= 1, 'no content streams found');
  for (const match of declarations) {
    const start = match.index + match[0].length;
    const end = pdf.indexOf('\nendstream', start);
    assert.ok(end > start, 'unterminated stream');
    const stream = pdf.slice(start, end);
    assert.equal(stream.length, Number(match[1]), 'declared /Length must equal the bytes written');
    assert.equal(Buffer.byteLength(stream, 'latin1'), Buffer.byteLength(stream, 'utf8'), 'content streams must be ASCII-only, which is what makes the two measurements agree');
    const offending = [...stream].find((character) => character.charCodeAt(0) > 0x7e);
    assert.equal(offending, undefined, `content stream must not contain a raw high byte (${JSON.stringify(offending)})`);
  }
});

test('the customer invoice never exposes purchase cost or profit', () => {
  const pdf = buildInvoicePdf({ sale: SALE, settings: SETTINGS }).toString('latin1');
  assert.ok(!pdf.includes('3333.33'), 'purchase cost must not appear');
  assert.ok(!pdf.includes('1166.67'), 'derived profit must not appear');
  assert.ok(!/profit/i.test(pdf), 'the word profit must not appear');
  assert.ok(!/purchase cost/i.test(pdf.replace(/Purchase date/gi, '')), 'no cost label on a customer document');
  // The customer-facing figures ARE present.
  assert.ok(pdf.includes('PKR 4500.00') && pdf.includes('PKR 1000.00'));
});

test('credentials appear only when explicitly requested', () => {
  const withCredentials = { ...SALE, items: [{ ...SALE.items[0], credential_email: 'login@example.invalid', credential_password: 'Secret123' }] };
  const off = buildInvoicePdf({ sale: withCredentials, settings: SETTINGS, includeCredentials: false }).toString('latin1');
  assert.ok(!off.includes('login@example.invalid') && !off.includes('Secret123'));
  assert.ok(!/CREDENTIALS/.test(off));
  const on = buildInvoicePdf({ sale: withCredentials, settings: SETTINGS, includeCredentials: true }).toString('latin1');
  assert.ok(on.includes('login@example.invalid') && on.includes('Secret123'));
  assert.match(on, /ACCESS CREDENTIALS/);
});

test('the invoice PDF route keeps its permission, policy and caching guarantees', () => {
  const source = code(path.join(MODULE_DIR, 'routes', 'sales.js'));
  assert.match(source, /router\.get\('\/:id\/invoice\.pdf', requirePermission\('invoice\.view'\)/);
  // Credentials need the settings policy AND both permissions — three independent conditions.
  assert.match(source, /Boolean\(settings\.include_credentials_in_invoice\)/);
  assert.match(source, /has\(req, 'invoice\.credentials'\)/);
  assert.match(source, /has\(req, 'credentials\.view'\)/);
  assert.match(source, /Cache-Control', 'private, no-store'/);
});

test('the logo is loaded from a fixed path, never from settings, env or a URL', () => {
  const source = code(path.join(MODULE_DIR, 'invoiceLogo.js'));
  // Matched as a WHOLE assignment, not a substring: `process.env.X || path.join(...)` still contains
  // the join and would otherwise slip through this guard.
  const assignment = source.match(/^const LOGO_PATH = (.+);$/m);
  assert.ok(assignment, 'LOGO_PATH assignment not found');
  assert.equal(assignment[1], "path.join(__dirname, 'assets', 'invoice-logo.png')");
  // An operator-supplied path or URL here would be an arbitrary file read / SSRF triggerable by
  // anyone who can edit settings.
  assert.ok(!/logo_url|logoUrl/.test(source), 'the settings logo_url must not reach the filesystem');
  assert.ok(!/process\.env/.test(source), 'the logo path must not be overridable by environment');
  assert.ok(!/https?:\/\/|fetch\(|axios|http\.get/.test(source), 'no outbound request may be made to fetch a logo');
  assert.ok(!/loadInvoiceLogo\([^)]+\)/.test(code(path.join(MODULE_DIR, 'invoicePdf.js'))), 'the loader takes no caller-supplied argument');
  // Only ever reads; an invoice render must not be able to write anywhere.
  assert.ok(!/writeFile|createWriteStream|unlink|rmdir|mkdir/.test(source), 'the logo loader must be read-only');
});

test('multi-page invoices keep a valid page tree', () => {
  const many = { ...SALE, items: Array.from({ length: 40 }, (_, i) => ({ ...SALE.items[0], name: `Item ${i + 1}` })) };
  const pdf = buildInvoicePdf({ sale: many, settings: SETTINGS }).toString('latin1');
  const kids = pdf.match(/\/Kids \[([^\]]+)\]/);
  const count = pdf.match(/\/Count (\d+)/);
  assert.ok(kids && count, 'page tree missing');
  assert.equal(kids[1].trim().split(/\s+0 R\s*/).filter(Boolean).length, Number(count[1]));
  assert.ok(Number(count[1]) > 1, '40 items should not fit on one page');
});


// ── English reminder templates ───────────────────────────────────────────────────────────────────
//
// These cover the scenarios a customer message can actually be sent in. Their value is that a bad
// message CANNOT be recalled once it reaches WhatsApp, so every field, omission and currency is
// asserted rather than eyeballed.

const STORE = 'Gen Z Digital Store';
const TODAY = new Date('2026-08-10T00:00:00Z');
const ITEM_ONE = [{ name: 'ChatGPT Plus — Private Account', accountEmail: 'aaminaali@gmail.com', purchaseDate: '2026-08-10', expiryDate: '2026-09-10' }];
const ITEM_MANY = [
  { name: 'ChatGPT Plus — Private Account', accountEmail: 'aaminaali@gmail.com', purchaseDate: '2026-08-10', expiryDate: '2026-09-10' },
  { name: 'Canva Pro', accountEmail: 'ahmed.raza@company.co.uk', purchaseDate: '2026-08-11', expiryDate: '2027-08-11' },
  { name: 'Lifetime Toolkit' },
];
const payment = (over = {}) => templates.paymentReminder({
  clientName: 'Aamina Ali', invoiceNumber: 'GDS-000142', currency: 'PKR',
  invoiceTotal: '12500.00', amountReceived: '2500.00', pendingAmount: '10000.00',
  items: ITEM_ONE, storeName: STORE, ...over,
});
const renewal = (over = {}) => templates.renewalReminder({
  clientName: 'Aamina Ali', productName: 'ChatGPT Plus — Private Account', accountEmail: 'aaminaali@gmail.com',
  purchaseDate: '2026-07-10', expiryDate: '2026-08-15', renewalPeriod: '1 Month', renewalAmount: '2500.00',
  currency: 'PKR', invoiceNumber: 'GDS-000142', storeName: STORE, today: TODAY, ...over,
});

const NON_ENGLISH = /assalam|alaikum|meherbani|shukriya|karein|karke|aapka|aap ka|jaldi|kripya|dhanyavad|ki taraf se/i;
const ALL_MESSAGES = () => [
  payment(), payment({ items: ITEM_MANY, currency: 'INR' }), payment({ items: [], currency: 'NGN' }),
  templates.overduePaymentReminder({ clientName: 'A', invoiceNumber: 'GDS-1', currency: 'NGN', invoiceTotal: '10.00', amountReceived: '0.00', pendingAmount: '10.00', items: ITEM_MANY, dueSince: '2026-06-01', storeName: STORE }),
  renewal(), renewal({ expiryDate: '2026-08-10' }), renewal({ expiryDate: '2026-08-01' }), renewal({ expiryDate: null }),
  templates.invoiceShareReminder({ clientName: 'A', invoiceNumber: 'GDS-1', invoiceDate: '2026-08-10', currency: 'PKR', invoiceTotal: '10.00', amountReceived: '10.00', pendingAmount: '0.00', items: ITEM_ONE, storeName: STORE }),
  templates.vendorDueReminder({ vendorName: 'Supplier', invoiceNumber: 'GDS-1', currency: 'PKR', dueAmount: '10.00', storeName: STORE }),
];

test('every template is English only and free of placeholder leakage', () => {
  for (const message of ALL_MESSAGES()) {
    assert.ok(!NON_ENGLISH.test(message), `non-English text: ${message.slice(0, 80)}`);
    assert.ok(!/[؀-ۿऀ-ॿ]/.test(message), 'no non-Latin script may appear');
    // Requirement: never "undefined", "null", an invalid date, or an empty placeholder line.
    assert.ok(!/undefined|null|NaN|Invalid Date/.test(message), `placeholder leaked: ${message}`);
    assert.ok(!/\{[a-z_]+\}/i.test(message), 'no unsubstituted {placeholder} may remain');
    assert.ok(!/\n\s*\n\s*\n/.test(message), 'no run of blank lines');
    assert.ok(message.trimEnd().endsWith(STORE), 'every message signs off as the store');
    // No label may be left dangling with nothing after it.
    for (const line of message.split('\n')) {
      if (line === 'Purchased Items:') continue;
      assert.ok(!/^\s*[A-Z][A-Za-z ]*:\s*$/.test(line), `label with no value: ${JSON.stringify(line)}`);
    }
  }
});

test('dates render as "10 August 2026" and refuse anything that is not a real date', () => {
  assert.equal(templates.formatDate('2026-08-10'), '10 August 2026');
  assert.equal(templates.formatDate('2026-01-05'), '5 January 2026');
  assert.equal(templates.formatDate('2026-12-31'), '31 December 2026');
  assert.equal(templates.formatDate('2026-08-10T18:30:00Z'), '10 August 2026');
  assert.equal(templates.formatDate(new Date('2026-08-10T00:00:00Z')), '10 August 2026');
  // Null rather than a placeholder, so the caller drops the whole line.
  for (const bad of [null, undefined, '', 'soon', 'not-a-date', '2026-13-01', '2026-00-10', '2026-02-30']) {
    assert.equal(templates.formatDate(bad), null, `${JSON.stringify(bad)} must not produce a date`);
  }
});

test('amounts group thousands, keep two decimals and always carry their currency', () => {
  assert.equal(templates.formatAmount('2500', 'PKR'), 'PKR 2,500.00');
  assert.equal(templates.formatAmount('2500.00', 'INR'), 'INR 2,500.00');
  assert.equal(templates.formatAmount('2500.5', 'NGN'), 'NGN 2,500.50');
  assert.equal(templates.formatAmount('1234567.89', 'PKR'), 'PKR 1,234,567.89');
  assert.equal(templates.formatAmount('0', 'PKR'), 'PKR 0.00');
  assert.equal(templates.formatAmount('999', 'PKR'), 'PKR 999.00');
  assert.equal(templates.formatAmount('1000', 'PKR'), 'PKR 1,000.00');
  // A non-numeric value must not become NaN in a customer's message.
  assert.equal(templates.formatAmount(undefined, 'PKR'), 'PKR 0.00');
  assert.equal(templates.formatAmount('abc', 'INR'), 'INR 0.00');
});

test('a message never mixes two currencies', () => {
  for (const currency of ['PKR', 'INR', 'NGN']) {
    const message = payment({ currency });
    assert.ok(message.includes(`${currency} 12,500.00`), `${currency} total missing`);
    for (const other of ['PKR', 'INR', 'NGN'].filter((code) => code !== currency)) {
      assert.ok(!message.includes(other), `message in ${currency} leaked ${other}`);
    }
  }
});

test('account emails are masked, and unmaskable values are omitted entirely', () => {
  assert.equal(templates.maskEmail('aaminaali@gmail.com'), 'aam***@gmail.com');
  assert.equal(templates.maskEmail('ahmed.raza@company.co.uk'), 'ahm***@company.co.uk');
  // Short local parts must not be revealed in full.
  assert.equal(templates.maskEmail('ab@x.com'), 'a***@x.com');
  assert.equal(templates.maskEmail('a@x.com'), 'a***@x.com');
  for (const bad of [null, undefined, '', 'not-an-email', 'missing@domain', '@gmail.com', 'user@']) {
    assert.equal(templates.maskEmail(bad), null, `${JSON.stringify(bad)} must not be treated as an email`);
  }
  // The full address must never survive into a rendered message.
  const message = payment();
  assert.ok(message.includes('aam***@gmail.com'));
  assert.ok(!message.includes('aaminaali@gmail.com'));
});

test('a single item is a plain block; two or more are numbered', () => {
  const single = payment({ items: ITEM_ONE });
  assert.match(single, /Purchased Items:\nChatGPT Plus — Private Account\n/);
  assert.ok(!/^1\. /m.test(single), 'a lone item should not be numbered');

  const many = payment({ items: ITEM_MANY });
  assert.match(many, /^1\. ChatGPT Plus — Private Account$/m);
  assert.match(many, /^2\. Canva Pro$/m);
  assert.match(many, /^3\. Lifetime Toolkit$/m);
  // Detail lines are indented under their numbered item.
  assert.match(many, /^ {3}Account: aam\*\*\*@gmail\.com$/m);
  assert.match(many, /^ {3}Activated: 10 August 2026$/m);
  assert.match(many, /^ {3}Expires: 10 September 2026$/m);
});

test('missing optional item fields drop their line without leaving a hole', () => {
  const message = payment({ items: [{ name: 'Bare Tool' }] });
  assert.ok(message.includes('Purchased Items:\nBare Tool\n'));
  assert.ok(!/Account:/.test(message));
  assert.ok(!/Activated:/.test(message));
  assert.ok(!/Expires:/.test(message));
  // A no-expiry tool prints no Expires line and invents no "No expiry" claim.
  const noExpiry = payment({ items: [{ name: 'Lifetime Toolkit', accountEmail: 'aaminaali@gmail.com', purchaseDate: '2026-01-05', expiryDate: null }] });
  assert.ok(noExpiry.includes('Activated: 5 January 2026'));
  assert.ok(!/Expires:/.test(noExpiry));
  assert.ok(!/No expiry/.test(noExpiry));
  // An invoice with no items at all still produces a valid message, minus the items section.
  const noItems = payment({ items: [] });
  assert.ok(!/Purchased Items:/.test(noItems));
  assert.match(noItems, /Invoice Total: PKR 12,500\.00/);
});

test('the payment reminder carries every required field in the specified order', () => {
  const message = payment({ items: ITEM_MANY });
  const expected = [
    'Hello Aamina Ali,',
    'This is a friendly payment reminder from Gen Z Digital Store.',
    'Invoice: GDS-000142',
    'Purchased Items:',
    'Invoice Total: PKR 12,500.00',
    'Amount Received: PKR 2,500.00',
    'Outstanding Balance: PKR 10,000.00',
    'Please let us know once the outstanding payment has been completed.',
    'Thank you,',
  ];
  let cursor = -1;
  for (const fragment of expected) {
    const at = message.indexOf(fragment);
    assert.ok(at > cursor, `"${fragment}" missing or out of order`);
    cursor = at;
  }
  assert.match(message, /^Hello Aamina Ali,\n\nThis is a friendly payment reminder/);
});

test('the overdue reminder is distinct, firmer, and states the same figures', () => {
  const message = templates.overduePaymentReminder({ clientName: 'Aamina Ali', invoiceNumber: 'GDS-000144', currency: 'NGN', invoiceTotal: '1500000.00', amountReceived: '500000.00', pendingAmount: '1000000.00', items: ITEM_ONE, dueSince: '2026-06-01', storeName: STORE });
  assert.match(message, /regarding an overdue payment/);
  assert.match(message, /Invoice Date: 1 June 2026/);
  assert.match(message, /Outstanding Balance: NGN 1,000,000\.00/);
  assert.ok(!/friendly payment reminder/.test(message), 'overdue must not reuse the gentle opening');
});

test('renewal variants are chosen from the expiry date and carry the service details', () => {
  const soon = renewal({ expiryDate: '2026-08-15' });
  assert.match(soon, /expires in 5 days, on 15 August 2026/);
  assert.match(soon, /Service: ChatGPT Plus — Private Account/);
  assert.match(soon, /Account: aam\*\*\*@gmail\.com/);
  assert.match(soon, /Activated: 10 July 2026/);
  assert.match(soon, /Expiry Date: 15 August 2026/);
  assert.match(soon, /Renewal Period: 1 Month/);
  assert.match(soon, /Renewal Amount: PKR 2,500\.00/);

  assert.match(renewal({ expiryDate: '2026-08-11' }), /expires in 1 day, on 11 August 2026/);
  assert.match(renewal({ expiryDate: '2026-08-10' }), /due for renewal today/);
  assert.match(renewal({ expiryDate: '2026-08-09' }), /expired on 9 August 2026 \(1 day ago\)/);
  assert.match(renewal({ expiryDate: '2026-08-01' }), /expired on 1 August 2026 \(9 days ago\)/);
  // The three states are reachable directly as well as through the dispatcher.
  assert.match(templates.expiringSoonReminder({ clientName: 'A', productName: 'P', expiryDate: '2026-08-15', storeName: STORE, today: TODAY }), /expires in 5 days/);
  assert.match(templates.renewalDueTodayReminder({ clientName: 'A', productName: 'P', storeName: STORE }), /due for renewal today/);
  assert.match(templates.expiredReminder({ clientName: 'A', productName: 'P', expiryDate: '2026-08-01', storeName: STORE, today: TODAY }), /expired on 1 August 2026/);
});

test('the renewal reminder omits an unconfigured price and never cites a date it lacks', () => {
  for (const amount of [null, undefined, '', '0', '0.00', 0]) {
    const message = renewal({ renewalAmount: amount });
    assert.ok(!/Renewal Amount/.test(message), `a renewal amount of ${JSON.stringify(amount)} must not be quoted`);
  }
  const undated = renewal({ expiryDate: null, renewalPeriod: '', renewalAmount: '0.00' });
  assert.ok(!/before the expiry date/.test(undated), 'cannot cite an expiry date when none was stated');
  assert.ok(!/Expiry Date:/.test(undated));
  assert.ok(!/Renewal Period:/.test(undated));
  assert.match(undated, /due for renewal soon/);
});

test('the invoice-sharing template adapts to whether anything is still owed', () => {
  const shared = (over) => templates.invoiceShareReminder({ clientName: 'A', invoiceNumber: 'GDS-1', invoiceDate: '2026-08-10', currency: 'PKR', invoiceTotal: '2500.00', items: ITEM_ONE, storeName: STORE, ...over });
  const settled = shared({ amountReceived: '2500.00', pendingAmount: '0.00' });
  assert.match(settled, /fully settled/);
  assert.match(settled, /Outstanding Balance: PKR 0\.00/);
  const owing = shared({ amountReceived: '1000.00', pendingAmount: '1500.00' });
  assert.ok(!/fully settled/.test(owing));
  assert.match(owing, /any questions about this invoice/);
});

test('templates tolerate missing and hostile field values', () => {
  const bare = templates.paymentReminder({});
  assert.match(bare, /^Hello there,/);
  assert.ok(bare.trimEnd().endsWith(STORE), 'store name falls back to the brand');
  assert.ok(!/undefined|null|NaN/.test(bare));
  // A newline injected through a client name must not forge extra message lines.
  const injected = payment({ clientName: 'Bad\nName: pay to 0000 instead' });
  assert.equal(injected.split('\n')[0], 'Hello Bad Name: pay to 0000 instead,');
  // Nor through a product name inside the item list. The property that matters is that a crafted name
  // cannot start a NEW line: whitespace collapses, so the text stays inside the item's own line where
  // it cannot be mistaken for one of our labels.
  const injectedItem = payment({ items: [{ name: 'Tool\nOutstanding Balance: PKR 0.00' }] });
  const balanceLines = injectedItem.split('\n').filter((line) => /^Outstanding Balance:/.test(line));
  assert.equal(balanceLines.length, 1, 'an item name must not forge a second balance line');
  assert.equal(balanceLines[0], 'Outstanding Balance: PKR 10,000.00', 'the real balance must be the surviving one');
  assert.ok(injectedItem.includes('Tool Outstanding Balance: PKR 0.00'), 'the injected text stays inside the item line');
});

test('no template can leak credentials, cost, profit or vendor pricing', () => {
  const source = code(path.join(MODULE_DIR, 'reminderTemplates.js'));
  for (const forbidden of ['credential_password', 'credentialPassword', 'cookie', 'purchase_cost', 'purchaseCost', 'subtotal_cost', 'profit', 'vendor_paid']) {
    assert.ok(!source.includes(forbidden), `templates must not reference ${forbidden}`);
  }
  for (const message of ALL_MESSAGES()) {
    assert.ok(!/password|cookie|token|session|profit|purchase cost/i.test(message), `sensitive wording in: ${message.slice(0, 80)}`);
  }
});

// ── Service wiring ───────────────────────────────────────────────────────────────────────────────

test('the service refuses a payment reminder when nothing is outstanding', () => {
  const source = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  assert.match(source, /function assertPayable/);
  assert.match(source, /money\.compare\(pending, '0\.00'\) <= 0/);
  assert.match(source, /409, 'REMINDER_NOT_PAYABLE'/);
  // A cancelled invoice is refused too: its amounts are no longer owed.
  assert.match(source, /toLowerCase\(\) === 'cancelled'/);
  // Invoice sharing is deliberately allowed for a settled invoice, so the guard must come AFTER that
  // branch returns. Matched with the trailing semicolon so this finds the CALL — searching without it
  // matched the function declaration's own parameter list, which sits earlier in the file and made
  // this assertion compare the wrong two positions.
  const callSite = source.indexOf('assertPayable(sale, pending);');
  const invoiceBranch = source.indexOf("kind === 'invoice'");
  assert.ok(callSite > 0, 'assertPayable is never called');
  assert.ok(invoiceBranch > 0 && invoiceBranch < callSite, 'invoice sharing must be handled before the payable guard');
});

test('only known reminder types are accepted', () => {
  const service = require('../modules/business-crm/services/reminderService');
  assert.deepEqual(Object.keys(service.SALE_TYPES).sort(), ['client_overdue', 'client_pending', 'invoice_share', 'vendor_due']);
  assert.deepEqual(Object.keys(service.ITEM_TYPES).sort(), ['expired', 'expiring_soon', 'expiry', 'renewal_due_today']);
  const source = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  assert.match(source, /'Unsupported reminder type', 400, 'REMINDER_UNSUPPORTED'/);
});

test('the account email is decrypted only to be masked, and never the password', () => {
  const source = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  // Only the email ciphertext is ever selected from the database.
  assert.ok(!/credential_password_ciphertext/.test(source), 'the password ciphertext must never be read here');
  assert.match(source, /vault\.decrypt\(item\.credential_email_ciphertext/);
  // A missing vault key or a failed decrypt omits the field instead of failing the reminder.
  assert.match(source, /!vault\.configured\(\)\) return null/);
  assert.match(source, /catch \{[\s\S]{0,40}return null;/);
  assert.match(source, /accountEmail: accountEmailFor\(/);
  // The plaintext reaches the message only through maskEmail.
  const templateSource = code(path.join(MODULE_DIR, 'reminderTemplates.js'));
  assert.match(templateSource, /maskEmail\(item\.accountEmail\)/);
  assert.match(templateSource, /maskEmail\(accountEmail\)/);
});

test('permissions and audit logging on the reminder routes are unchanged', () => {
  const routes = code(path.join(MODULE_DIR, 'routes', 'operations.js'));
  assert.match(routes, /router\.post\('\/reminders\/prepare', requirePermission\('reminders\.prepare'\)/);
  assert.match(routes, /router\.post\('\/reminders\/:id\/opened', requirePermission\('reminders\.prepare'\)/);
  const service = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  assert.match(service, /audit\.write\(connection, req, 'reminder\.prepare'/);
  assert.match(service, /audit\.write\(connection, req, 'reminder\.open'/);
  // The prepared message is still persisted for the audit trail, inside the same transaction.
  assert.match(service, /INSERT INTO biz_crm_reminders/);
  assert.match(service, /beginTransaction\(\)/);
});

test('the WhatsApp URL is built for mobile and encoded so the message survives intact', () => {
  const service = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  assert.match(service, /https:\/\/wa\.me\/\$\{phone\}\?text=\$\{encodeURIComponent\(message\)\}/);
  // Round-trip a real multi-line message through the same encoding the service uses.
  const message = payment({ items: ITEM_MANY });
  const encoded = encodeURIComponent(message);
  const url = `https://wa.me/923012345678?text=${encoded}`;
  assert.equal(decodeURIComponent(encoded), message, 'the message must survive a round trip');
  assert.ok(url.includes('%0A'), 'line breaks must be encoded as %0A');
  assert.ok(url.includes('%E2%80%94'), 'the em dash must be UTF-8 percent-encoded');
  // Characters that would otherwise terminate or corrupt the query string must not appear raw.
  for (const raw of ['\n', '#', '&']) {
    assert.ok(!encoded.includes(raw), `${JSON.stringify(raw)} must be encoded`);
  }
});

test('phone normalisation keeps the wa.me path numeric', () => {
  const { whatsappPhone } = require('../modules/business-crm/services/reminderService');
  assert.equal(whatsappPhone('+92 301 2345678', '92'), '923012345678');
  assert.equal(whatsappPhone('0301-2345678', '92'), '923012345678');
  assert.equal(whatsappPhone('0092 301 2345678', '92'), '923012345678');
  assert.throws(() => whatsappPhone('', '92'), /WhatsApp number is missing/);
  assert.throws(() => whatsappPhone('abc', '92'), /WhatsApp number is missing/);
});

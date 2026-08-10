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

// Tokens from the previous mixed-language templates, plus common Roman Urdu spellings.
const NON_ENGLISH = /assalam|alaikum|meherbani|shukriya|karein|karke|aapka|aap ka|jaldi|kripya|dhanyavad|ki taraf se/i;

const ALL_MESSAGES = () => [
  templates.clientPaymentReminder({ clientName: 'Ahmed Raza', invoiceNumber: 'GDS-1', currency: 'PKR', pendingAmount: '4500.00', storeName: 'Gen Z Digital Store' }),
  templates.clientPaymentReminder({ clientName: 'Ahmed Raza', invoiceNumber: 'GDS-1', currency: 'INR', pendingAmount: '99.00', dueDate: '2026-08-20', storeName: 'Gen Z Digital Store' }),
  templates.renewalReminder({ clientName: 'Ahmed Raza', productName: 'Canva Pro', expiryDate: '2026-09-10', invoiceNumber: 'GDS-1', storeName: 'Gen Z Digital Store', today: new Date('2026-08-10T00:00:00Z') }),
  templates.renewalReminder({ clientName: 'Ahmed Raza', productName: 'Canva Pro', expiryDate: '2026-08-12', storeName: 'Gen Z Digital Store', today: new Date('2026-08-10T00:00:00Z') }),
  templates.renewalReminder({ clientName: 'Ahmed Raza', productName: 'Canva Pro', expiryDate: '2026-08-05', storeName: 'Gen Z Digital Store', today: new Date('2026-08-10T00:00:00Z') }),
  templates.renewalReminder({ clientName: 'Ahmed Raza', productName: 'Lifetime Tool', expiryDate: null, storeName: 'Gen Z Digital Store' }),
  templates.vendorDueReminder({ vendorName: 'Supplier Co', invoiceNumber: 'GDS-1', currency: 'PKR', dueAmount: '3000.00', storeName: 'Gen Z Digital Store' }),
];

test('no customer-facing template contains non-English text', () => {
  for (const message of ALL_MESSAGES()) {
    assert.ok(!NON_ENGLISH.test(message), `non-English text in: ${message.slice(0, 90)}`);
    // Every character must be plain Latin text/punctuation — no Arabic or Devanagari script.
    assert.ok(!/[؀-ۿऀ-ॿ]/.test(message), 'no non-Latin script may appear');
  }
});

test('the reminder service no longer holds inline message text', () => {
  const source = code(path.join(MODULE_DIR, 'services', 'reminderService.js'));
  assert.ok(!NON_ENGLISH.test(source), 'the service still contains non-English message text');
  assert.match(source, /require\('\.\.\/reminderTemplates'\)/);
  for (const name of ['clientPaymentReminder', 'renewalReminder', 'vendorDueReminder']) {
    assert.ok(source.includes(`templates.${name}`), `${name} is not used by the service`);
  }
});

test('the payment reminder states amount, currency and invoice, and signs off as the store', () => {
  const message = templates.clientPaymentReminder({ clientName: 'Ahmed Raza', invoiceNumber: 'GDS-000142', currency: 'PKR', pendingAmount: '4500.00', storeName: 'Gen Z Digital Store' });
  assert.match(message, /^Hello Ahmed Raza,/);
  assert.ok(message.includes('PKR 4500.00'));
  assert.ok(message.includes('GDS-000142'));
  assert.ok(message.trimEnd().endsWith('Gen Z Digital Store'));
  assert.match(message, /Thank you,/);
  // No due date supplied, so no due-date sentence may be invented.
  assert.ok(!/by undefined|by null|by \./.test(message));
  assert.ok(!message.includes('Kindly arrange'));
});

test('the renewal reminder picks its variant from the date, not from a flag', () => {
  const today = new Date('2026-08-10T00:00:00Z');
  const base = { clientName: 'Ahmed Raza', productName: 'Canva Pro', storeName: 'Gen Z Digital Store', today };
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-09-10' }), /due for renewal on 2026-09-10/);
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-08-12' }), /expires in 2 days \(2026-08-12\)/);
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-08-11' }), /expires in 1 day \(2026-08-11\)/);
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-08-10' }), /expires today \(2026-08-10\)/);
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-08-09' }), /expired on 2026-08-09 \(1 day ago\)/);
  assert.match(templates.renewalReminder({ ...base, expiryDate: '2026-08-05' }), /expired on 2026-08-05 \(5 days ago\)/);
  // Every variant offers the renewal-on-request line.
  for (const date of ['2026-09-10', '2026-08-12', '2026-08-10', '2026-08-05', null]) {
    assert.match(templates.renewalReminder({ ...base, expiryDate: date }), /reply to this message/);
  }
});

test('the renewal reminder never references an expiry date it did not state', () => {
  const message = templates.renewalReminder({ clientName: 'A', productName: 'Lifetime Tool', expiryDate: null, storeName: 'Store' });
  assert.ok(!/before the expiry date/.test(message), 'cannot cite an expiry date when none exists');
  assert.ok(!/undefined|null|NaN/.test(message));
});

test('templates tolerate missing and hostile field values', () => {
  const message = templates.clientPaymentReminder({ clientName: '', invoiceNumber: '', currency: '', pendingAmount: '', storeName: '' });
  assert.match(message, /^Hello there,/);
  assert.ok(message.includes('0.00'));
  assert.ok(message.trimEnd().endsWith('Gen Z Digital Store'), 'store name falls back to the brand');
  // A newline injected through a client name must not be able to forge extra message lines.
  const injected = templates.clientPaymentReminder({ clientName: 'Bad\nName: pay here instead', invoiceNumber: 'GDS-1', currency: 'PKR', pendingAmount: '1.00', storeName: 'Store' });
  assert.match(injected, /^Hello Bad Name: pay here instead,/);
  assert.equal(injected.split('\n')[0], 'Hello Bad Name: pay here instead,');
  assert.ok(!/undefined|NaN/.test(injected));
});

test('no template can leak credentials, cost, profit or vendor pricing', () => {
  const source = code(path.join(MODULE_DIR, 'reminderTemplates.js'));
  for (const forbidden of ['credential', 'password', 'purchase_cost', 'purchaseCost', 'subtotal_cost', 'profit', 'vendorPaid', 'vendor_paid']) {
    assert.ok(!source.includes(forbidden), `templates must not reference ${forbidden}`);
  }
  for (const message of ALL_MESSAGES()) {
    assert.ok(!/password|credential|login|profit|cost/i.test(message), `sensitive wording in: ${message.slice(0, 80)}`);
  }
});

test('daysUntil handles unparseable and absent dates without throwing', () => {
  assert.equal(templates.daysUntil(null), null);
  assert.equal(templates.daysUntil('not-a-date'), null);
  assert.equal(templates.daysUntil('2026-08-12', new Date('2026-08-10T23:59:59Z')), 2);
  // A timestamp on the same calendar day must read as today, not as yesterday.
  assert.equal(templates.daysUntil('2026-08-10', new Date('2026-08-10T18:30:00Z')), 0);
});

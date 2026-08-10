'use strict';

// Dependency-free PDF writer. It deliberately supports the subset needed for a
// clean invoice, so the existing backend package.json does not need another
// runtime dependency.

const { loadInvoiceLogo } = require('./invoiceLogo');

// Gen Z Digital Store brand palette, taken from the CSS custom properties the rest of the product
// uses (--brand-navy / --brand-cyan / --brand-blue). PDF wants 0-1 components, not hex.
const BRAND = {
  navy: [0.027, 0.106, 0.200], //   #071b33
  cyan: [0.024, 0.714, 0.831], //   #06b6d4
  blue: [0.145, 0.388, 0.922], //   #2563eb
  ink: [0.043, 0.122, 0.200], //    #0b1f33
  muted: [0.357, 0.420, 0.486], //  #5b6b7c
  hairline: [0.851, 0.906, 0.941], //#d9e7f0
  band: [0.965, 0.976, 0.988], //   #f6f9fc
  green: [0.086, 0.639, 0.290], //  #16a34a
  amber: [0.851, 0.467, 0.024], //  #d97706
  red: [0.863, 0.149, 0.149], //    #dc2626
};

// The base-14 fonts below are declared with /WinAnsiEncoding, so a glyph is addressed by its WinAnsi
// byte. Typography that is common in this data (em dash in product names, the bullet used to join
// footer contact details, the ellipsis appended by truncate) is NOT ASCII and has no WinAnsi byte at
// its Unicode code point, so it must be mapped explicitly. Writing the raw UTF-8 bytes instead —
// which is what happened before — made "ChatGPT Plus — Private" render as "ChatGPT Plus  Private"
// and turned the footer bullets into stray quotation marks.
const WIN_ANSI = new Map(Object.entries({
  '…': 0x85, // …
  '–': 0x96, // –
  '—': 0x97, // —
  '•': 0x95, // •
  '‘': 0x91, '’': 0x92, // ‘ ’
  '“': 0x93, '”': 0x94, // “ ”
  '‹': 0x8b, '›': 0x9b, // ‹ ›
  '€': 0x80, // €
  '™': 0x99, // ™
  '‰': 0x89, // ‰
  '†': 0x86, '‡': 0x87, // † ‡
}));

function pdfEscape(value) {
  let out = '';
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0);
    if (character === '\\') { out += '\\\\'; continue; }
    if (character === '(') { out += '\\('; continue; }
    if (character === ')') { out += '\\)'; continue; }
    if (character === '\r' || character === '\n') { out += ' '; continue; }
    const mapped = WIN_ANSI.get(character);
    if (mapped !== undefined) { out += `\\${mapped.toString(8).padStart(3, '0')}`; continue; }
    // Latin-1 maps 1:1 onto WinAnsi above 0xA0; below 0x20 are control codes we never want.
    if (code >= 0x20 && code <= 0x7e) { out += character; continue; }
    if (code >= 0xa0 && code <= 0xff) { out += `\\${code.toString(8).padStart(3, '0')}`; continue; }
    // Anything else (e.g. Urdu or Arabic script in a client name) has no glyph in these fonts.
    // Substituting a marker is safer than emitting a byte that would render as an unrelated letter.
    out += '?';
  }
  return out;
}
function money(value, currency) { return `${currency} ${Number(value || 0).toFixed(2)}`; }
function truncate(value, max = 82) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function textCommand(x, y, size, value, font = 'F1') {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`;
}
function lineCommand(x1, y1, x2, y2, width = 0.5) { return `${width} w ${x1} ${y1} m ${x2} ${y2} l S`; }
function rectCommand(x, y, width, height, gray = 0.95) { return `${gray} g ${x} ${y} ${width} ${height} re f 0 g`; }
/** Filled rectangle in a brand colour rather than a grey level. */
function fillCommand(x, y, width, height, [r, g, b]) {
  return `${r} ${g} ${b} rg ${x} ${y} ${width} ${height} re f 0 g`;
}
function colorCommand([r, g, b]) { return `${r} ${g} ${b} rg`; }

// Helvetica digits and uppercase letters are 0.556em; bold runs a little wider. These fonts carry no
// embedded metrics here, so right-aligned text is placed from an estimate that deliberately
// OVER-estimates, and the result is clamped so a long invoice number can never cross the margin.
function estimateWidth(value, size, bold = false) {
  return String(value ?? '').length * size * (bold ? 0.60 : 0.52);
}
function rightAlignedX(value, size, rightEdge, minimumX, bold = false) {
  return Math.max(minimumX, rightEdge - estimateWidth(value, size, bold));
}

/**
 * Derives the customer-facing payment status.
 *
 * A cancelled invoice reports Cancelled whatever the ledger says, because the amounts are no longer
 * owed. Otherwise it is driven purely by received-vs-total, so it can never disagree with the totals
 * printed beside it. Comparison is in integer minor units: 0.1 + 0.2 style float drift would
 * otherwise leave a fully paid invoice reading "Partially Paid".
 */
function paymentStatus(sale) {
  if (String(sale.status || '').toLowerCase() === 'cancelled') return { label: 'CANCELLED', tone: BRAND.muted };
  const total = Math.round(Number(sale.subtotal_sale || 0) * 100);
  const paid = Math.round(Number(sale.client_paid || 0) * 100);
  if (total > 0 && paid >= total) return { label: 'PAID', tone: BRAND.green };
  if (paid > 0) return { label: 'PARTIALLY PAID', tone: BRAND.amber };
  return { label: 'PENDING', tone: BRAND.red };
}

function buildInvoicePdf({ sale, settings, includeCredentials = false }) {
  const pages = [];
  let commands = [];
  let y = 790;
  const left = 42;
  const right = 553;
  const pageWidth = 595;
  const logo = loadInvoiceLogo();
  const storeName = settings.store_name || 'Gen Z Digital Store';
  const status = paymentStatus(sale);
  const addPage = () => {
    pages.push(commands.join('\n'));
    commands = [];
    y = 790;
  };
  const ensure = (height = 30) => { if (y - height < 78) addPage(); };
  const text = (value, size = 10, x = left, font = 'F1') => { commands.push(textCommand(x, y, size, value, font)); y -= size + 5; };
  const label = (value, size = 8, x = left) => {
    commands.push(colorCommand(BRAND.muted));
    commands.push(textCommand(x, y, size, value, 'F2'));
    commands.push('0 g');
    y -= size + 4;
  };
  const row = (columns, widths, size = 8, header = false) => {
    ensure(24);
    const height = 20;
    if (header) commands.push(fillCommand(left, y - 6, right - left, height, BRAND.band));
    let x = left + 6;
    columns.forEach((value, index) => {
      if (header) commands.push(colorCommand(BRAND.navy));
      commands.push(textCommand(x, y, size, truncate(value, Math.max(8, Math.floor(widths[index] / (size * 0.52)))), header ? 'F2' : 'F1'));
      if (header) commands.push('0 g');
      x += widths[index];
    });
    commands.push(colorCommand(BRAND.hairline));
    commands.push(lineCommand(left, y - 9, right, y - 9, 0.5));
    commands.push('0 g');
    y -= height;
  };

  // ── Header band ────────────────────────────────────────────────────────────────────────────────
  commands.push(rectCommand(0, 0, pageWidth, 842, 1));
  commands.push(fillCommand(0, 752, pageWidth, 90, BRAND.navy));
  // A cyan keyline under the band ties the document to the brand gradient without a second image.
  commands.push(fillCommand(0, 748, pageWidth, 4, BRAND.cyan));

  const hasLogo = Boolean(logo);
  const logoSize = 46;
  const textX = hasLogo ? left + logoSize + 14 : left;
  if (hasLogo) {
    // Placed via a save/restore pair so the CTM scaling cannot leak into later drawing operations.
    commands.push(`q ${logoSize} 0 0 ${logoSize} ${left} ${776} cm /Im1 Do Q`);
  }
  commands.push('1 1 1 rg');
  commands.push(textCommand(textX, 806, 19, truncate(storeName, 34), 'F2'));
  commands.push('0.62 0.85 0.94 rg');
  commands.push(textCommand(textX, 788, 8.5, 'BUSINESS INVOICE', 'F2'));
  commands.push('0 g');

  // Invoice number and date sit ON the navy band, so they must be light. They were previously drawn
  // after a `0 g` reset, i.e. black on near-black — present in the file but invisible on screen.
  const numberText = truncate(String(sale.invoice_number || ''), 20);
  const numberFloor = textX + estimateWidth(truncate(storeName, 34), 19, true) + 12;
  commands.push('1 1 1 rg');
  commands.push(textCommand(rightAlignedX(numberText, 13, right, numberFloor, true), 806, 13, numberText, 'F2'));
  commands.push('0.78 0.88 0.95 rg');
  const dateText = `Date: ${sale.sale_date || '—'}`;
  commands.push(textCommand(rightAlignedX(dateText, 8.5, right, numberFloor), 788, 8.5, dateText, 'F1'));
  commands.push('0 g');

  // ── Bill to + status ──────────────────────────────────────────────────────────────────────────
  y = 716;
  const billTop = y;
  label('BILL TO');
  commands.push(colorCommand(BRAND.ink));
  text(truncate(sale.client_name || 'Client', 44), 13, left, 'F2');
  commands.push('0 g');
  commands.push(colorCommand(BRAND.muted));
  if (sale.client_company) text(truncate(sale.client_company, 52), 9);
  if (sale.client_email) text(truncate(sale.client_email, 52), 9);
  if (sale.client_whatsapp) text(truncate(sale.client_whatsapp, 52), 9);
  if (sale.client_address) text(truncate(sale.client_address, 52), 9);
  commands.push('0 g');

  // Status pill, right-aligned against the bill-to block.
  const pillWidth = Math.max(86, status.label.length * 5.6 + 22);
  const pillX = right - pillWidth;
  commands.push(fillCommand(pillX, billTop - 6, pillWidth, 22, status.tone));
  commands.push('1 1 1 rg');
  commands.push(textCommand(pillX + 11, billTop + 1, 9, status.label, 'F2'));
  commands.push('0 g');
  commands.push(colorCommand(BRAND.muted));
  commands.push(textCommand(pillX, billTop - 20, 7.5, `Currency: ${sale.currency_code || ''}`, 'F1'));
  commands.push('0 g');

  y = Math.min(y, billTop - 46);
  y -= 6;

  // ── Items ─────────────────────────────────────────────────────────────────────────────────────
  // Customer documents never expose internal purchase cost or profit.
  row(['Product / Service', 'Type', 'Duration', 'Expiry', 'Amount'], [230, 62, 72, 72, 75], 8, true);
  for (const item of sale.items || []) {
    row([
      item.name, item.account_type || 'private', item.duration_label || '—', item.expiry_date || '—',
      Number(item.sale_price || 0).toFixed(2),
    ], [230, 62, 72, 72, 75], 8, false);
  }
  y -= 10;

  // ── Totals ────────────────────────────────────────────────────────────────────────────────────
  const pending = Math.max(0, Number(sale.subtotal_sale || 0) - Number(sale.client_paid || 0));
  const profit = Number(sale.subtotal_sale || 0) - Number(sale.subtotal_cost || 0);
  ensure(96);
  const totalsTop = y;
  const totalsX = 330;
  commands.push(fillCommand(totalsX, totalsTop - 62, right - totalsX, 76, BRAND.band));
  const totalLine = (name, value, size = 9, bold = false) => {
    commands.push(colorCommand(BRAND.muted));
    commands.push(textCommand(totalsX + 12, y, 8.5, name, 'F1'));
    commands.push('0 g');
    commands.push(colorCommand(bold ? BRAND.navy : BRAND.ink));
    // Right-aligned so the decimal columns line up and a large NGN figure cannot run past the panel.
    commands.push(textCommand(rightAlignedX(value, size, right - 12, totalsX + 74, bold), y, size, value, bold ? 'F2' : 'F1'));
    commands.push('0 g');
    y -= 19;
  };
  y = totalsTop;
  totalLine('Subtotal', money(sale.subtotal_sale, sale.currency_code), 9.5);
  totalLine('Received', money(sale.client_paid, sale.currency_code), 9.5);
  commands.push(colorCommand(BRAND.hairline));
  commands.push(lineCommand(totalsX + 12, y + 12, right - 12, y + 12, 0.5));
  commands.push('0 g');
  totalLine('Amount due', money(pending, sale.currency_code), 11.5, true);
  y = totalsTop - 76;

  if (sale.invoice_instructions || settings.invoice_terms) {
    ensure(70);
    label('PAYMENT / DELIVERY NOTES');
    const notes = `${sale.invoice_instructions || ''}${sale.invoice_instructions && settings.invoice_terms ? ' — ' : ''}${settings.invoice_terms || ''}`;
    commands.push(colorCommand(BRAND.muted));
    for (const segment of String(notes).match(/.{1,96}(?:\s|$)/g) || [notes]) text(segment.trim(), 8);
    commands.push('0 g');
    y -= 5;
  }
  if (includeCredentials && (sale.items || []).some((item) => item.credential_email || item.credential_password)) {
    ensure(80);
    label('ACCESS CREDENTIALS — CONFIDENTIAL');
    row(['Product', 'Login / Email', 'Password / Code'], [185, 170, 156], 8, true);
    for (const item of sale.items || []) {
      if (item.credential_email || item.credential_password) row([item.name, item.credential_email || '—', item.credential_password || '—'], [185, 170, 156], 8);
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────────────────────────
  ensure(60);
  y -= 8;
  commands.push(colorCommand(BRAND.hairline));
  commands.push(lineCommand(left, y, right, y, 0.6));
  commands.push('0 g');
  y -= 16;
  commands.push(colorCommand(BRAND.navy));
  text(`Thank you for choosing ${truncate(storeName, 40)}.`, 9.5, left, 'F2');
  commands.push('0 g');
  const contact = [settings.store_phone, settings.store_email, settings.store_address].filter(Boolean).join(' • ');
  commands.push(colorCommand(BRAND.muted));
  if (contact) text(truncate(contact, 108), 7.5);
  text('This is a computer-generated invoice.', 7);
  commands.push('0 g');
  // Profit is never shown on the customer invoice. Keep this assignment to make
  // the deliberate exclusion explicit and testable.
  void profit;
  addPage();

  const objects = [];
  const addObject = (body) => { objects.push(body); return objects.length; };
  const catalog = addObject('<< /Type /Catalog /Pages 2 0 R >>');
  const pageObjectNumbers = [];
  const contentObjectNumbers = [];
  // Reserve pages object (object 2) before fonts/pages.
  objects.push('PAGES_PLACEHOLDER');
  const fontRegular = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  let logoNumber = null;
  if (logo) {
    // Alpha travels as a separate greyscale /SMask; PDF base images carry no alpha channel.
    const smask = addObject(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${logo.alpha.length} >>\nstream\n@@SMASK@@\nendstream`);
    logoNumber = addObject(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${smask} 0 R /Filter /FlateDecode /Length ${logo.rgb.length} >>\nstream\n@@RGB@@\nendstream`);
  }
  const resources = `<< /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${logoNumber ? ` /XObject << /Im1 ${logoNumber} 0 R >>` : ''} >>`;
  for (const stream of pages) {
    // /Length must count the bytes actually written. The stream is emitted as latin1 (one byte per
    // char), so measuring it as utf8 over-counted the moment a WinAnsi escape produced a high byte.
    const contentNumber = addObject(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    contentObjectNumbers.push(contentNumber);
    const pageNumber = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${contentNumber} 0 R >>`);
    pageObjectNumbers.push(pageNumber);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pageObjectNumbers.length} >>`;

  // The document is assembled as binary chunks. Image streams are raw deflate bytes and must NOT be
  // routed through a latin1 string round-trip, so they are spliced in as Buffers via placeholders.
  const chunks = [];
  let length = 0;
  const push = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'binary');
    chunks.push(buffer);
    length += buffer.length;
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(length);
    const header = `${index + 1} 0 obj\n`;
    if (logo && object.includes('@@RGB@@')) {
      const [before, after] = object.split('@@RGB@@');
      push(header + before); push(logo.rgb); push(`${after}\nendobj\n`);
    } else if (logo && object.includes('@@SMASK@@')) {
      const [before, after] = object.split('@@SMASK@@');
      push(header + before); push(logo.alpha); push(`${after}\nendobj\n`);
    } else {
      push(`${header}${object}\nendobj\n`);
    }
  });
  const xref = length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) tail += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  push(tail);
  return Buffer.concat(chunks);
}

module.exports = { buildInvoicePdf, pdfEscape, paymentStatus, BRAND };

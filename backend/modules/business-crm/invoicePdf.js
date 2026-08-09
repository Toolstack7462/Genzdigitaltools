'use strict';

// Dependency-free PDF writer. It deliberately supports the subset needed for a
// clean invoice, so the existing backend package.json does not need another
// runtime dependency.
function pdfEscape(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');
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

function buildInvoicePdf({ sale, settings, includeCredentials = false }) {
  const pages = [];
  let commands = [];
  let y = 790;
  const left = 42;
  const right = 553;
  const pageWidth = 595;
  const addPage = () => {
    pages.push(commands.join('\n'));
    commands = [];
    y = 790;
  };
  const ensure = (height = 30) => { if (y - height < 48) addPage(); };
  const text = (value, size = 10, x = left, font = 'F1') => { commands.push(textCommand(x, y, size, value, font)); y -= size + 5; };
  const row = (columns, widths, size = 8, header = false) => {
    ensure(24);
    const height = 20;
    if (header) commands.push(rectCommand(left, y - 5, right - left, height, 0.91));
    let x = left + 4;
    columns.forEach((value, index) => {
      commands.push(textCommand(x, y, size, truncate(value, Math.max(8, Math.floor(widths[index] / (size * 0.52)))), header ? 'F2' : 'F1'));
      x += widths[index];
    });
    commands.push(lineCommand(left, y - 8, right, y - 8, 0.25));
    y -= height;
  };

  commands.push(rectCommand(0, 0, pageWidth, 842, 1));
  commands.push(rectCommand(0, 768, pageWidth, 74, 0.08));
  commands.push('1 1 1 rg');
  commands.push(textCommand(left, 811, 22, settings.store_name || 'Gen Z Digital Store', 'F2'));
  commands.push(textCommand(left, 790, 9, 'BUSINESS INVOICE', 'F1'));
  commands.push('0 g');
  y = 744;
  commands.push(textCommand(407, 811, 12, sale.invoice_number, 'F2'));
  commands.push(textCommand(407, 791, 9, `Date: ${sale.sale_date}`, 'F1'));

  text('BILL TO', 9, left, 'F2');
  text(sale.client_name || 'Client', 13, left, 'F2');
  if (sale.client_company) text(sale.client_company, 9);
  if (sale.client_email) text(sale.client_email, 9);
  if (sale.client_whatsapp) text(sale.client_whatsapp, 9);
  y -= 5;

  // Customer documents never expose internal purchase cost or profit.
  row(['Product / Service', 'Type', 'Duration', 'Expiry', 'Amount'], [230, 62, 72, 72, 75], 8, true);
  for (const item of sale.items || []) {
    row([
      item.name, item.account_type || 'private', item.duration_label || '—', item.expiry_date || '—',
      Number(item.sale_price || 0).toFixed(2),
    ], [230, 62, 72, 72, 75], 8, false);
  }
  y -= 8;
  const pending = Math.max(0, Number(sale.subtotal_sale || 0) - Number(sale.client_paid || 0));
  const profit = Number(sale.subtotal_sale || 0) - Number(sale.subtotal_cost || 0);
  commands.push(textCommand(350, y, 9, 'Invoice total', 'F1'));
  commands.push(textCommand(458, y, 10, money(sale.subtotal_sale, sale.currency_code), 'F2')); y -= 18;
  commands.push(textCommand(350, y, 9, 'Received', 'F1'));
  commands.push(textCommand(458, y, 10, money(sale.client_paid, sale.currency_code), 'F2')); y -= 18;
  commands.push(textCommand(350, y, 9, 'Pending', 'F1'));
  commands.push(textCommand(458, y, 11, money(pending, sale.currency_code), 'F2')); y -= 27;

  if (sale.invoice_instructions || settings.invoice_terms) {
    ensure(70);
    text('PAYMENT / DELIVERY NOTES', 9, left, 'F2');
    const notes = `${sale.invoice_instructions || ''}${sale.invoice_instructions && settings.invoice_terms ? ' — ' : ''}${settings.invoice_terms || ''}`;
    for (const segment of String(notes).match(/.{1,88}(?:\s|$)/g) || [notes]) text(segment.trim(), 8);
    y -= 5;
  }
  if (includeCredentials && (sale.items || []).some((item) => item.credential_email || item.credential_password)) {
    ensure(80);
    text('ACCESS CREDENTIALS — CONFIDENTIAL', 9, left, 'F2');
    row(['Product', 'Login / Email', 'Password / Code'], [185, 170, 156], 8, true);
    for (const item of sale.items || []) {
      if (item.credential_email || item.credential_password) row([item.name, item.credential_email || '—', item.credential_password || '—'], [185, 170, 156], 8);
    }
  }
  ensure(55);
  y -= 8;
  commands.push(lineCommand(left, y, right, y, 0.4)); y -= 16;
  text(`Thank you for choosing ${settings.store_name || 'Gen Z Digital Store'}.`, 9, left, 'F2');
  const contact = [settings.store_phone, settings.store_email, settings.store_address].filter(Boolean).join(' • ');
  if (contact) text(truncate(contact, 100), 7.5);
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
  const fontRegular = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBold = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  for (const stream of pages) {
    const contentNumber = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    contentObjectNumbers.push(contentNumber);
    const pageNumber = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    pageObjectNumbers.push(pageNumber);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pageObjectNumbers.length} >>`;

  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'binary');
}

module.exports = { buildInvoicePdf, pdfEscape };

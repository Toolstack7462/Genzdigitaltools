'use strict';

// Customer-facing WhatsApp message templates.
//
// ENGLISH ONLY, deliberately. These replace mixed Roman-Urdu/English text ("Assalam-o-Alaikum …
// Meherbani karke payment update share karein") that read as broken to English-speaking customers
// and could not be proof-read by anyone who does not read Roman Urdu.
//
// Kept as a separate pure module so the exact wording is unit-testable without a database, and so
// there is one place to review before anything is sent to a customer.
//
// SECURITY: these templates must never interpolate credentials, cost, profit, vendor pricing or any
// internal identifier. A WhatsApp message leaves the system entirely and cannot be recalled. Only
// client name, product/service name, invoice number, currency, amount owed and dates appear.

const SIGN_OFF = 'Thank you,';

/** Collapses whitespace in operator-entered values so a stray newline cannot break the layout. */
function clean(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/** WhatsApp renders a plain newline as a line break, so paragraphs are joined with blank lines. */
function compose(lines, storeName) {
  return [...lines.filter(Boolean), '', SIGN_OFF, clean(storeName, 'Gen Z Digital Store')].join('\n');
}

/** Whole days from today until `date`; negative once the date has passed. Null if unparseable. */
function daysUntil(date, today = new Date()) {
  if (!date) return null;
  const target = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - start) / 86400000);
}

/**
 * Client payment reminder.
 *
 * The due date is only mentioned when one exists, so the message never says "due by undefined".
 */
function clientPaymentReminder({ clientName, invoiceNumber, currency, pendingAmount, dueDate, storeName }) {
  const amount = `${clean(currency)} ${clean(pendingAmount, '0.00')}`.trim();
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    `This is a friendly reminder that an outstanding payment of ${amount} is due for your invoice ${clean(invoiceNumber)}.`,
    dueDate ? `Kindly arrange the payment by ${clean(dueDate)}.` : null,
    'Please let us know once payment has been made.',
  ], storeName);
}

/**
 * Renewal / expiry reminder, in three variants driven by how far the expiry date is.
 *
 * The variant is chosen from the date rather than from a caller-supplied flag, so the wording can
 * never contradict the date printed in the same sentence.
 */
function renewalReminder({ clientName, productName, expiryDate, invoiceNumber, storeName, today }) {
  const product = clean(productName, 'your subscription');
  const remaining = daysUntil(expiryDate, today);
  const name = `Hello ${clean(clientName, 'there')},`;
  const reference = invoiceNumber ? `Invoice reference: ${clean(invoiceNumber)}.` : null;
  const offer = 'If you would like us to renew it for you, please reply to this message.';

  if (remaining !== null && remaining < 0) {
    const days = Math.abs(remaining);
    return compose([
      name,
      `Your service for ${product} expired on ${clean(expiryDate)} (${days} ${days === 1 ? 'day' : 'days'} ago).`,
      'To restore access, please renew at your earliest convenience.',
      offer,
      reference,
    ], storeName);
  }
  if (remaining !== null && remaining <= 3) {
    const when = remaining === 0 ? 'today' : `in ${remaining} ${remaining === 1 ? 'day' : 'days'}`;
    return compose([
      name,
      `Your service for ${product} expires ${when} (${clean(expiryDate)}).`,
      'Please renew before the expiry date to avoid any interruption to your access.',
      offer,
      reference,
    ], storeName);
  }
  return compose([
    name,
    expiryDate
      ? `Your subscription for ${product} is due for renewal on ${clean(expiryDate)}.`
      : `Your subscription for ${product} is due for renewal.`,
    // Only reference "the expiry date" when the message actually stated one.
    expiryDate
      ? 'Please renew before the expiry date to avoid interruption.'
      : 'Please renew at your convenience to avoid any interruption to your access.',
    offer,
    reference,
  ], storeName);
}

/**
 * Vendor payment coordination.
 *
 * Sent to a supplier, not a customer, but it is still outbound text and still English only. It states
 * the amount payable and the invoice reference; it never mentions the client's sale price or margin.
 */
function vendorDueReminder({ vendorName, invoiceNumber, currency, dueAmount, storeName }) {
  const amount = `${clean(currency)} ${clean(dueAmount, '0.00')}`.trim();
  return compose([
    `Hello ${clean(vendorName, 'there')},`,
    `We have a pending balance of ${amount} recorded against reference ${clean(invoiceNumber)}.`,
    'Please confirm the payment details so we can process it without delay.',
  ], storeName);
}

module.exports = { clientPaymentReminder, renewalReminder, vendorDueReminder, daysUntil, SIGN_OFF };

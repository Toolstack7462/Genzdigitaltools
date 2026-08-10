'use strict';

// Customer-facing WhatsApp message templates.
//
// ENGLISH ONLY, deliberately. These replaced mixed Roman-Urdu/English text that read as broken to
// English-speaking customers and could not be proof-read by anyone who does not read Roman Urdu.
//
// Kept as a separate pure module so the exact wording is unit-testable without a database, and so
// there is one place to review before anything is sent to a customer.
//
// SECURITY. A WhatsApp message leaves the system entirely and cannot be recalled, so these templates
// may only ever interpolate:
//   client / vendor name · product name · invoice number · currency · amounts owed · dates ·
//   a MASKED account email
// Never a password, cookie, token, session value, provider credential, purchase cost or profit.
// Account emails are masked unconditionally — there is no setting that unmasks them here, because a
// full login address in a chat thread is a durable identifier the customer never asked us to repeat.

const SIGN_OFF = 'Thank you,';
const STORE_FALLBACK = 'Gen Z Digital Store';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Collapses whitespace in operator-entered values so a stray newline cannot forge extra lines. */
function clean(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/**
 * "10 August 2026", or null when the value is absent or not a real date.
 *
 * Returning null rather than a placeholder is what keeps "Expires: undefined" and "Expires: Invalid
 * Date" out of customer messages — every caller drops the line when this is null.
 */
function formatDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // Accept a Date or a full timestamp, but never guess at free text.
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return null;
    return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
  }
  const [year, month, day] = text.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a date that does not exist, e.g. 2026-02-30, which Date would silently roll forward.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * "PKR 2,500.00" — grouped to three digits, always two decimals, currency code in front.
 *
 * The currency always travels WITH the number: PKR, INR and NGN are separate ledgers and a bare
 * amount in a chat thread invites the customer to assume the wrong one.
 */
function formatAmount(value, currency) {
  const code = clean(currency);
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  const fixed = Math.abs(safe).toFixed(2);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = safe < 0 ? '-' : '';
  return `${code ? `${code} ` : ''}${sign}${grouped}.${fraction}`.trim();
}

/**
 * "aaminaali@gmail.com" -> "aam***@gmail.com". Returns null for anything that is not an address, so
 * the caller omits the line rather than printing a mangled value.
 *
 * The domain is kept because it is what lets the customer recognise which account is meant; the local
 * part is cut to at most three characters, and to fewer for very short names so the whole local part
 * is never revealed.
 */
function maskEmail(value) {
  const text = clean(value);
  if (!text || !text.includes('@')) return null;
  const at = text.lastIndexOf('@');
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) return null;
  const keep = Math.min(3, Math.max(1, local.length - 1));
  return `${local.slice(0, keep)}***@${domain}`;
}

/**
 * Joins message blocks, then normalises the spacing between them.
 *
 * `null`/`undefined` means "this field was unavailable" and the block disappears. An empty string
 * means "paragraph break here" and is KEPT — conflating the two is what silently flattened every
 * template into one wall of text. Once omitted fields are gone their separators can collide, so runs
 * of blank lines are collapsed to one and the leading/trailing blanks are trimmed. The result is that
 * a missing field never leaves a hole in the layout.
 */
function compose(blocks, storeName) {
  const lines = [];
  for (const block of blocks) {
    if (block === null || block === undefined) continue;
    lines.push(String(block));
  }
  const spaced = [];
  for (const line of lines) {
    if (line === '' && (spaced.length === 0 || spaced[spaced.length - 1] === '')) continue;
    spaced.push(line);
  }
  while (spaced.length && spaced[spaced.length - 1] === '') spaced.pop();
  return [...spaced, '', SIGN_OFF, clean(storeName, STORE_FALLBACK)].join('\n');
}

/** Whole days from today until `date`; negative once past. Null if absent or unparseable. */
function daysUntil(date, today = new Date()) {
  if (!date) return null;
  const text = String(date).slice(0, 10);
  const target = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - start) / 86400000);
}

/**
 * Renders the purchased items.
 *
 * A single item is written as a plain block; two or more are numbered, which is what makes a
 * multi-tool invoice readable. Every optional line — account, activation date, expiry — is dropped
 * when the value is missing, so an item with only a name still renders as one clean line.
 */
function itemList(items = []) {
  const usable = (Array.isArray(items) ? items : []).filter((item) => item && clean(item.name));
  if (!usable.length) return null;
  const numbered = usable.length > 1;
  return usable.map((item, index) => {
    const heading = numbered ? `${index + 1}. ${clean(item.name)}` : clean(item.name);
    const detail = [];
    const account = maskEmail(item.accountEmail);
    if (account) detail.push(`Account: ${account}`);
    const activated = formatDate(item.purchaseDate);
    if (activated) detail.push(`Activated: ${activated}`);
    const expires = formatDate(item.expiryDate);
    // A tool with no expiry simply has no Expires line. Printing "No expiry" would be a claim about
    // the product that the sale record does not actually make.
    if (expires) detail.push(`Expires: ${expires}`);
    const indent = numbered ? '   ' : '';
    return [heading, ...detail.map((line) => `${indent}${line}`)].join('\n');
  }).join('\n');
}

/** Shared money block for the payment templates. */
function amountBlock({ currency, invoiceTotal, amountReceived, pendingAmount }) {
  return [
    `Invoice Total: ${formatAmount(invoiceTotal, currency)}`,
    `Amount Received: ${formatAmount(amountReceived, currency)}`,
    `Outstanding Balance: ${formatAmount(pendingAmount, currency)}`,
  ].join('\n');
}

/**
 * Pending payment reminder.
 *
 * The caller must not reach this with a settled invoice — `reminderService` refuses that before a
 * message is ever composed, because telling a customer who has paid in full that they owe nothing is
 * worse than sending nothing at all.
 */
function paymentReminder({ clientName, invoiceNumber, currency, invoiceTotal, amountReceived, pendingAmount, items, storeName }) {
  const store = clean(storeName, STORE_FALLBACK);
  const list = itemList(items);
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    `This is a friendly payment reminder from ${store}.`,
    '',
    `Invoice: ${clean(invoiceNumber)}`,
    ...(list ? ['', 'Purchased Items:', list] : []),
    '',
    amountBlock({ currency, invoiceTotal, amountReceived, pendingAmount }),
    '',
    'Please let us know once the outstanding payment has been completed. If you have already made the payment, kindly share the payment confirmation with us.',
  ], storeName);
}

/**
 * Overdue payment reminder — firmer, still polite.
 *
 * Separate from `paymentReminder` rather than a tone flag on it, so the escalated wording can be read
 * and approved on its own. The caller decides which is appropriate; nothing here infers a due date,
 * because the schema records none.
 */
function overduePaymentReminder({ clientName, invoiceNumber, currency, invoiceTotal, amountReceived, pendingAmount, items, dueSince, storeName }) {
  const store = clean(storeName, STORE_FALLBACK);
  const list = itemList(items);
  const since = formatDate(dueSince);
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    `This is a reminder from ${store} regarding an overdue payment on your account.`,
    '',
    `Invoice: ${clean(invoiceNumber)}`,
    since ? `Invoice Date: ${since}` : null,
    ...(list ? ['', 'Purchased Items:', list] : []),
    '',
    amountBlock({ currency, invoiceTotal, amountReceived, pendingAmount }),
    '',
    'Please arrange the outstanding payment at your earliest convenience so your service continues without interruption. If you have already paid, kindly share the payment confirmation and we will update our records.',
  ], storeName);
}

/** Shared subscription block for the three renewal states. */
function serviceBlock({ productName, accountEmail, purchaseDate, expiryDate, renewalPeriod, renewalAmount, currency }) {
  const lines = [`Service: ${clean(productName, 'your subscription')}`];
  const account = maskEmail(accountEmail);
  if (account) lines.push(`Account: ${account}`);
  const activated = formatDate(purchaseDate);
  if (activated) lines.push(`Activated: ${activated}`);
  const expires = formatDate(expiryDate);
  if (expires) lines.push(`Expiry Date: ${expires}`);
  const period = clean(renewalPeriod);
  if (period) lines.push(`Renewal Period: ${period}`);
  // Only quoted when a price is actually configured — never "Renewal Amount: PKR 0.00" by default.
  if (renewalAmount !== null && renewalAmount !== undefined && String(renewalAmount) !== '' && Number(renewalAmount) > 0) {
    lines.push(`Renewal Amount: ${formatAmount(renewalAmount, currency)}`);
  }
  return lines.join('\n');
}

/** Expiring soon — the service is still active. */
function expiringSoonReminder(fields) {
  const { clientName, expiryDate, invoiceNumber, storeName, today } = fields;
  const remaining = daysUntil(expiryDate, today);
  const expires = formatDate(expiryDate);
  const dated = remaining !== null && expires;
  const when = dated
    ? `expires in ${remaining} ${remaining === 1 ? 'day' : 'days'}, on ${expires}`
    : 'is due for renewal soon';
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    `Your subscription ${when}.`,
    '',
    serviceBlock(fields),
    '',
    // Only cite "the expiry date" when the message actually stated one.
    dated
      ? 'Please renew before the expiry date to avoid any interruption to your access. If you would like us to renew it for you, please reply to this message.'
      : 'Please renew at your convenience to avoid any interruption to your access. If you would like us to renew it for you, please reply to this message.',
    invoiceNumber ? `Invoice reference: ${clean(invoiceNumber)}` : null,
  ], storeName);
}

/** Renewal due today. */
function renewalDueTodayReminder(fields) {
  const { clientName, invoiceNumber, storeName } = fields;
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    'Your subscription is due for renewal today.',
    '',
    serviceBlock(fields),
    '',
    'Please renew today to avoid any interruption to your access. If you would like us to renew it for you, please reply to this message.',
    invoiceNumber ? `Invoice reference: ${clean(invoiceNumber)}` : null,
  ], storeName);
}

/** Already expired. */
function expiredReminder(fields) {
  const { clientName, expiryDate, invoiceNumber, storeName, today } = fields;
  const remaining = daysUntil(expiryDate, today);
  const expires = formatDate(expiryDate);
  const elapsed = remaining === null ? null : Math.abs(remaining);
  const when = expires && elapsed !== null
    ? `expired on ${expires} (${elapsed} ${elapsed === 1 ? 'day' : 'days'} ago)`
    : (expires ? `expired on ${expires}` : 'has expired');
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    `Your subscription ${when}.`,
    '',
    serviceBlock(fields),
    '',
    'To restore your access, please renew at your earliest convenience. If you would like us to renew it for you, please reply to this message.',
    invoiceNumber ? `Invoice reference: ${clean(invoiceNumber)}` : null,
  ], storeName);
}

/**
 * Renewal reminder, dispatched from the expiry date.
 *
 * The variant is chosen from the date rather than a caller flag, so the wording can never contradict
 * the date printed in the same message.
 */
function renewalReminder(fields) {
  const remaining = daysUntil(fields.expiryDate, fields.today);
  if (remaining !== null && remaining < 0) return expiredReminder(fields);
  if (remaining === 0) return renewalDueTodayReminder(fields);
  return expiringSoonReminder(fields);
}

/** Invoice sharing — sent alongside the PDF, so it summarises rather than demands. */
function invoiceShareReminder({ clientName, invoiceNumber, invoiceDate, currency, invoiceTotal, amountReceived, pendingAmount, items, storeName }) {
  const store = clean(storeName, STORE_FALLBACK);
  const list = itemList(items);
  const dated = formatDate(invoiceDate);
  const settled = Number(pendingAmount) <= 0;
  return compose([
    `Hello ${clean(clientName, 'there')},`,
    '',
    `Please find the details of your invoice from ${store} below.`,
    '',
    `Invoice: ${clean(invoiceNumber)}`,
    dated ? `Invoice Date: ${dated}` : null,
    ...(list ? ['', 'Purchased Items:', list] : []),
    '',
    amountBlock({ currency, invoiceTotal, amountReceived, pendingAmount }),
    '',
    settled
      ? 'This invoice is fully settled. Thank you for your business.'
      : 'Please let us know if you have any questions about this invoice.',
  ], storeName);
}

/**
 * Vendor payment coordination.
 *
 * Sent to a supplier, not a customer, but it is still outbound text and still English only. It never
 * mentions the client's sale price or our margin.
 */
function vendorDueReminder({ vendorName, invoiceNumber, currency, dueAmount, storeName }) {
  return compose([
    `Hello ${clean(vendorName, 'there')},`,
    '',
    `We have a pending balance of ${formatAmount(dueAmount, currency)} recorded against reference ${clean(invoiceNumber)}.`,
    'Please confirm the payment details so we can process it without delay.',
  ], storeName);
}

module.exports = {
  paymentReminder,
  overduePaymentReminder,
  expiringSoonReminder,
  renewalDueTodayReminder,
  expiredReminder,
  renewalReminder,
  invoiceShareReminder,
  vendorDueReminder,
  // Exported for the service and for tests; these are the formatting guarantees the brief specifies.
  formatDate,
  formatAmount,
  maskEmail,
  itemList,
  daysUntil,
  SIGN_OFF,
};

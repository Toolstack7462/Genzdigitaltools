'use strict';

const CURRENCIES = Object.freeze(['PKR', 'INR', 'NGN']);

function assertCurrency(value) {
  const code = String(value || '').toUpperCase();
  if (!CURRENCIES.includes(code)) {
    const error = new Error('Currency must be PKR, INR or NGN');
    error.status = 400;
    error.code = 'UNSUPPORTED_CURRENCY';
    throw error;
  }
  return code;
}

function toMinor(value) {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    const error = new Error('Invalid monetary amount');
    error.status = 400;
    error.code = 'INVALID_MONEY';
    throw error;
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -minor : minor;
}

function fromMinor(value) {
  const minor = BigInt(value);
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function normalize(value) { return fromMinor(toMinor(value)); }
function sum(values) { return fromMinor(values.reduce((total, value) => total + toMinor(value), 0n)); }
function subtract(left, right) { return fromMinor(toMinor(left) - toMinor(right)); }
function compare(left, right) { const delta = toMinor(left) - toMinor(right); return delta === 0n ? 0 : delta > 0n ? 1 : -1; }
function nonNegative(value) { return compare(value, '0.00') < 0 ? '0.00' : normalize(value); }

module.exports = { CURRENCIES, assertCurrency, toMinor, fromMinor, normalize, sum, subtract, compare, nonNegative };

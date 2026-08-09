'use strict';

const crypto = require('crypto');
const PREFIX = 'gds-v1';

function key() {
  const raw = process.env.BUSINESS_CRM_VAULT_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    const error = new Error('BUSINESS_CRM_VAULT_KEY must be exactly 64 hexadecimal characters');
    error.status = 503;
    error.code = 'VAULT_NOT_CONFIGURED';
    throw error;
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(value, context = '') {
  if (value === undefined || value === null || String(value) === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  if (context) cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(payload, context = '') {
  if (!payload) return null;
  const [prefix, ivText, tagText, cipherText] = String(payload).split('.');
  if (prefix !== PREFIX || !ivText || !tagText || !cipherText) throw new Error('Invalid vault payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'));
  if (context) decipher.setAAD(Buffer.from(String(context), 'utf8'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
}

function configured() { return /^[0-9a-fA-F]{64}$/.test(process.env.BUSINESS_CRM_VAULT_KEY || ''); }
module.exports = { encrypt, decrypt, configured, PREFIX };

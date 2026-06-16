'use strict';
/**
 * Real AES-256-GCM encryption for the StealthWriter Account Vault — session/cookie
 * bundles are encrypted AT REST and only ever decrypted server-side inside the
 * gateway session endpoint. Decrypted values never reach the admin/client UI or logs.
 *
 * Key: STEALTH_VAULT_KEY (64 hex chars = 32 bytes). If unset, an isolated 32-byte
 * key is derived from JWT_SECRET via HMAC so the module works out-of-the-box while
 * keeping the vault key separate from the core auth secret. Set STEALTH_VAULT_KEY
 * explicitly in production so rotating JWT_SECRET never strands vault data.
 *
 * Format: "v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ciphertext)
 */
const crypto = require('crypto');

function vaultKey() {
  const hex = process.env.STEALTH_VAULT_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '').update('stealthwriter:vault:v1').digest();
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string') plaintext = JSON.stringify(plaintext);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) throw new Error('invalid vault blob');
  const [, ivB64, tagB64, ctB64] = blob.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

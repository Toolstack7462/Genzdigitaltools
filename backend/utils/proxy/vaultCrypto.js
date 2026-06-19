'use strict';
/**
 * AES-256-GCM encryption for the Proxy-Tools (HIX / BypassGPT) Account Vaults.
 * Session/cookie bundles are encrypted AT REST and only ever decrypted server-side
 * inside the gateway /session endpoint. Decrypted values never reach any UI or log.
 *
 * Key: PROXY_VAULT_KEY (64 hex chars = 32 bytes). If unset, an isolated key is
 * derived from JWT_SECRET via HMAC under a DISTINCT namespace, so this vault key is
 * separate from both the core auth secret AND the StealthWriter vault key.
 *
 * Format: "v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ciphertext)
 */
const crypto = require('crypto');

function vaultKey() {
  const hex = process.env.PROXY_VAULT_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  // Never derive a key from an empty secret — fail loudly on misconfiguration.
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('PROXY_VAULT_KEY or JWT_SECRET is required to derive the vault key');
  return crypto.createHmac('sha256', secret).update('proxytools:vault:v1').digest();
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

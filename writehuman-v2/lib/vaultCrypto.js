'use strict';
/**
 * WriteHuman V2 — AES-256-GCM encryption for the single-account cookie vault.
 * Isolated clone of backend/utils/proxy/vaultCrypto.js, keyed by the V2 vault key
 * (config.vaultKey, from WRITEHUMAN_V2_VAULT_KEY or derived). The cookie bundle is
 * encrypted AT REST and only ever decrypted server-side inside V2. Decrypted values
 * never reach any UI or log.
 *
 * Format: "v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ciphertext)
 */
const crypto = require('crypto');
const { config } = require('./config');

function vaultKey() {
  const k = config.vaultKey;
  if (!Buffer.isBuffer(k) || k.length !== 32) throw new Error('invalid V2 vault key');
  return k;
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

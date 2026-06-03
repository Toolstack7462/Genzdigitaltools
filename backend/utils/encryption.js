'use strict';

const crypto = require('crypto');

const ALGORITHM    = 'aes-256-gcm';
const IV_LENGTH    = 16;  // 128-bit IV
const KEY_HEX_LEN  = 64; // 32 bytes = 64 hex chars

// Validate and load encryption key at module load time
const KEY_HEX = process.env.COOKIES_ENCRYPTION_KEY;

if (!KEY_HEX || KEY_HEX.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  console.error(
    'FATAL: COOKIES_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.\n' +
    'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

const ENCRYPTION_KEY = Buffer.from(KEY_HEX, 'hex');

/**
 * Encrypt a plaintext string.
 * Returns a colon-separated string: iv:authTag:ciphertext (all hex-encoded).
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string argument');
  }
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a value produced by encrypt().
 *
 * @param {string} encryptedData  colon-separated iv:authTag:ciphertext
 * @returns {string}
 */
function decrypt(encryptedData) {
  if (typeof encryptedData !== 'string') {
    throw new TypeError('decrypt() requires a string argument');
  }
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format — expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8');
}

// ---- Legacy aliases kept for backward compatibility ----
const encryptCookies = encrypt;
const decryptCookies = decrypt;

function validateCookiesJson(json) {
  try { JSON.parse(json); return true; } catch { return false; }
}

module.exports = {
  encrypt,
  decrypt,
  encryptCookies,
  decryptCookies,
  validateCookiesJson
};

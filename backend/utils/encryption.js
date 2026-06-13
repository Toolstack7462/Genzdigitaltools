'use strict';

// Encryption layer removed by request. Cookies/credentials are now stored as
// plain JSON strings in the same DB fields (`cookiesEncrypted`, `payloadEncrypted`,
// `sessionBundle.cookiesEncrypted`, etc. — names kept for backward compatibility).
//
// Behavior:
//   - encrypt(x) / encryptCookies(x): returns x unchanged. Callers continue to
//     pass JSON.stringify(...) of cookies/tokens; what gets stored is the plain
//     JSON string.
//   - decrypt(x) / decryptCookies(x): returns x unchanged. Callers continue to
//     JSON.parse(...) the result.
//
// Legacy data that was previously stored in `iv:tag:ciphertext` hex form will
// fail JSON.parse on read — admin must re-save those tools once. The
// `/api/crm/extension/tools/:toolId/_diagnose` endpoint reports this clearly
// (cause = `json_parse_failed`).
//
// COOKIES_ENCRYPTION_KEY is no longer required; if present it is ignored.

function passthrough(value) {
  if (typeof value !== 'string') {
    throw new TypeError('cookies/credentials must be passed as a string (use JSON.stringify(...))');
  }
  return value;
}

const encrypt        = passthrough;
const decrypt        = passthrough;
const encryptCookies = passthrough;
const decryptCookies = passthrough;

function validateCookiesJson(json) {
  try { JSON.parse(json); return true; } catch { return false; }
}

module.exports = {
  encrypt,
  decrypt,
  encryptCookies,
  decryptCookies,
  validateCookiesJson,
};

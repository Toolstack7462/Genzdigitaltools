// jsdom in this CRA/jest version has no TextEncoder/TextDecoder, which react-router 7 requires at
// import time. Node has had both since v11, so this simply exposes them to the jsdom global.
// Test-only; nothing here affects the production build.
const { TextEncoder, TextDecoder } = require('node:util');

if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

// jsdom provides no global `crypto`, but browsers do and the CRM offline queue calls
// `crypto.randomUUID()` directly. Without this the real queue throws "crypto is not defined" and a
// test would be measuring the environment rather than the code. Node's webcrypto is the same API.
const { webcrypto } = require('node:crypto');

if (typeof global.crypto === 'undefined') global.crypto = webcrypto;
else if (typeof global.crypto.randomUUID !== 'function') global.crypto.randomUUID = webcrypto.randomUUID.bind(webcrypto);

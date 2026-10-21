// jsdom in this CRA/jest version has no TextEncoder/TextDecoder, which react-router 7 requires at
// import time. Node has had both since v11, so this simply exposes them to the jsdom global.
// Test-only; nothing here affects the production build.
const { TextEncoder, TextDecoder } = require('node:util');

if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

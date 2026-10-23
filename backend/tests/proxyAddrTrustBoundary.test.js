'use strict';
/**
 * proxy-addr CVE-2026-90711 / GHSA-jqcg-44mw-7w3h, and this API's actual trust boundary.
 *
 * WHAT THE DEFECT IS. Established by diffing 2.0.7 against 2.0.8 rather than from the advisory
 * text: 2.0.8 adds three guards to the trust-subnet matcher around IPv4-mapped IPv6 addresses —
 * it canonicalises a mapped candidate to IPv4 so it cannot take the same-family path, it refuses to
 * let an IPv6 subnet match an IPv4 candidate unless the subnet is a mapped subnet whose prefix
 * covers the `::ffff:` marker (range >= 96), and it refuses a native IPv6 candidate against a
 * mapped subnet. Without them, a short-prefix IPv6 trust subnet such as `::/64` matches EVERY IPv4
 * address, because an IPv4 candidate was converted to `::ffff:a.b.c.d` whose top 64 bits are zero.
 * A host that should not be trusted would then be treated as a trusted proxy and could choose the
 * effective client IP through X-Forwarded-For.
 *
 * WHAT THIS API ACTUALLY DOES. server-crm.js sets `trust proxy` to the NUMBER 1. Express compiles a
 * number to `function (a, i) { return i < val }` — a hop count that never looks at the address — so
 * proxy-addr's subnet matcher, the function the CVE lives in, is never invoked on this
 * configuration. The package was vulnerable; this application did not exercise the defective path.
 * That is why the last test here is a tripwire: changing `trust proxy` to a subnet list would move
 * this app ONTO that path, and should not happen silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const BACKEND = path.join(__dirname, '..');
const proxyaddr = require('proxy-addr');

/* ══ the dependency itself ═══════════════════════════════════════════════════════════════════ */
test('the resolved proxy-addr is the patched 2.0.8 or newer', () => {
  const { version } = require('proxy-addr/package.json');
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(
    major > 2 || (major === 2 && (minor > 0 || (minor === 0 && patch >= 8))),
    `proxy-addr resolved to ${version}; 2.0.8 is the patched release`,
  );
});

test('the lockfile pins it, so a fresh install cannot silently fall back to 2.0.7', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages || {}).filter(([k]) => /(^|\/)proxy-addr$/.test(k));
  assert.ok(entries.length > 0, 'proxy-addr is absent from the lockfile');
  for (const [name, meta] of entries) {
    assert.notEqual(meta.version, '2.0.7', `${name} is pinned to the vulnerable 2.0.7`);
    assert.ok(meta.integrity, `${name} has no integrity hash`);
  }
});

/* ══ the guards the patch adds ══════════════════════════════════════════════════════════════ */
test('CVE: a short-prefix IPv6 trust subnet must NOT trust every IPv4 address', () => {
  // The regression itself. On 2.0.7 this returns true, because 1.2.3.4 was converted to
  // ::ffff:1.2.3.4 and matched against ::/64 on its all-zero top 64 bits.
  const trust = proxyaddr.compile(['::/64']);
  assert.equal(trust('1.2.3.4', 0), false);
  assert.equal(trust('203.0.113.7', 0), false);
  assert.equal(trust('127.0.0.1', 0), false);
});

test('CVE: nor does a mapped IPv4 candidate sneak through the same-family path', () => {
  const trust = proxyaddr.compile(['::/64']);
  assert.equal(trust('::ffff:1.2.3.4', 0), false);
});

test('an IPv6 subnet still matches the IPv6 addresses it is meant to', () => {
  const trust = proxyaddr.compile(['2001:db8::/32']);
  assert.equal(trust('2001:db8::1', 0), true);
  assert.equal(trust('2001:db9::1', 0), false);
});

test('a mapped subnet whose prefix covers the ::ffff: marker still works', () => {
  // range >= 96 and the subnet is mapped, so spanning IPv4 is intentional here.
  const trust = proxyaddr.compile(['::ffff:127.0.0.1/128']);
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('127.0.0.2', 0), false);
});

test('legitimate IPv4 trust is unchanged, including for a mapped form of the same address', () => {
  const trust = proxyaddr.compile(['127.0.0.1', '10.0.0.0/8']);
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('::ffff:127.0.0.1', 0), true, 'a mapped loopback is still the loopback');
  assert.equal(trust('10.1.2.3', 0), true);
  assert.equal(trust('11.1.2.3', 0), false);
});

test('the named presets still behave', () => {
  const loopback = proxyaddr.compile('loopback');
  assert.equal(loopback('127.0.0.1', 0), true);
  assert.equal(loopback('::1', 0), true);
  assert.equal(loopback('8.8.8.8', 0), false);
});

/* ══ this API's configuration ═══════════════════════════════════════════════════════════════ */
function serve(trustSetting, handler) {
  const express = require('express');
  const app = express();
  app.set('trust proxy', trustSetting);
  app.get('/', handler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function get(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}
const report = (req, res) => res.json({ ip: req.ip, ips: req.ips, protocol: req.protocol, secure: req.secure });

test('with trust proxy = 1, a client-prepended X-Forwarded-For cannot choose the effective IP', async () => {
  // The real shape of an attack attempt: the client sends its own XFF, the trusted hop appends the
  // address it actually saw. Express counts hops from the socket, so the value the client injected
  // is NOT the one that wins.
  const server = await serve(1, report);
  try {
    const { port } = server.address();
    const spoofed = await get(port, { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
    assert.equal(spoofed.ip, '203.0.113.7', 'the rightmost (proxy-appended) hop must win');
    assert.notEqual(spoofed.ip, '9.9.9.9');
    // A long injected chain does not walk the trust further along either.
    const deep = await get(port, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7' });
    assert.equal(deep.ip, '203.0.113.7');
  } finally { server.close(); }
});

test('a legitimate single-hop proxied request still reports the real client IP', async () => {
  const server = await serve(1, report);
  try {
    const { port } = server.address();
    const r = await get(port, { 'x-forwarded-for': '203.0.113.7' });
    assert.equal(r.ip, '203.0.113.7');
    assert.deepEqual(r.ips, ['203.0.113.7']);
  } finally { server.close(); }
});

test('with no proxy header at all, the socket address is used', async () => {
  const server = await serve(1, report);
  try {
    const r = await get(server.address().port, {});
    assert.match(r.ip, /127\.0\.0\.1|::ffff:127\.0\.0\.1|::1/);
  } finally { server.close(); }
});

test('X-Forwarded-Proto: express takes the LEFTMOST value, unlike X-Forwarded-For', async () => {
  // I first wrote this expecting the rightmost value to win, by analogy with X-Forwarded-For. It
  // does not: req.protocol is `header.substring(0, header.indexOf(','))`, so the FIRST value wins,
  // and a client that prepends its own value does decide req.protocol. Asserted as it actually
  // behaves — the next test is what makes that harmless here.
  const server = await serve(1, report);
  try {
    const { port } = server.address();
    const https = await get(port, { 'x-forwarded-proto': 'https' });
    assert.equal(https.protocol, 'https');
    assert.equal(https.secure, true);
    const plain = await get(port, {});
    assert.equal(plain.protocol, 'http');
    assert.equal(plain.secure, false);
    const injected = await get(port, { 'x-forwarded-proto': 'http, https' });
    assert.equal(injected.protocol, 'http', 'the LEFTMOST value wins — this is express behaviour, not a bug here');
    assert.equal(injected.secure, false);
  } finally { server.close(); }
});

test('...and nothing in production depends on req.secure/req.protocol, so cookies cannot be downgraded that way', () => {
  // The reason the quirk above does not matter for this API: secure-cookie selection is driven by
  // NODE_ENV, never by the forwarded protocol. If that ever changes, the forwarded-proto quirk
  // becomes a real downgrade vector and this test should fail first.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(BACKEND);
  const offenders = files.filter((f) => /\breq\.(secure|protocol)\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(
    offenders.map((f) => path.relative(BACKEND, f)), [],
    'production code now reads req.secure/req.protocol — re-examine X-Forwarded-Proto trust before shipping',
  );
  const auth = fs.readFileSync(path.join(BACKEND, 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /secure:\s*process\.env\.NODE_ENV === 'production'/,
    'cookie security is expected to come from NODE_ENV, not from the request');
});

test('TRIPWIRE: server-crm.js must keep trust proxy as a hop COUNT, not a subnet list', () => {
  // A number compiles to `(a, i) => i < val`, which never inspects the address, so proxy-addr's
  // subnet matcher — where this CVE lived — is not on the request path at all. Changing this to a
  // list of addresses or CIDRs would put it back on that path and must be a deliberate, reviewed
  // decision rather than a quiet edit.
  const source = fs.readFileSync(path.join(BACKEND, 'server-crm.js'), 'utf8');
  const matches = [...source.matchAll(/app\.set\(\s*['"]trust proxy['"]\s*,\s*([^)]+)\)/g)];
  assert.equal(matches.length, 1, 'expected exactly one trust proxy setting in server-crm.js');
  const value = matches[0][1].trim();
  assert.match(value, /^\d+$/, `trust proxy is set to ${value}; a hop count is expected here`);
});

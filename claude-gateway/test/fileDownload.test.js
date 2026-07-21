'use strict';
/**
 * Claude file-download fix (claude-only).
 *
 * THE BUG: files generated or attached in Claude were visible, but the download control was
 * hidden and text-ish downloads came back altered. Two independent defects:
 *
 *  1. UI — `CLAUDE_HIDE_RE` in public/overlay.js had `download( apps?| for .+)?`. The trailing
 *     `?` made the suffix OPTIONAL, so a bare "Download" matched a rule meant only for the
 *     account menu's app promos ("Download apps", "Download for Mac"). A text match hides
 *     nearestControl(), which walks up to 4 ancestors — so the file card's Download button /
 *     menu item was removed from the DOM's view. The request path was never blocked; the
 *     control was simply hidden, which is why "visible file, no download" was the symptom.
 *
 *  2. BYTES — the proxy decided how to treat a response purely by content-type. A download
 *     served as text/html took the HTML branch and had the overlay + critical hide CSS +
 *     URL rewriting injected INTO the saved file; text/plain, JSON and XML downloads had
 *     upstream-URL rewriting applied to their bytes. Binary (PDF/DOCX/XLSX/PPTX/images/ZIP)
 *     was already safe because it is piped untouched.
 *
 * THE FIX: require the suffix in the regex, and treat `Content-Disposition: attachment` as
 * "this is a file" — no injection, no rewriting, no buffering, and keep its content-length.
 *
 * Preview/inline responses, the app's own JSON, artifacts and uploads are deliberately
 * untouched and are asserted here to still behave exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const PORT = 18895;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ jti: 'j' + crypto.randomBytes(6).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

/** Raw request returning a Buffer body, so binary is compared byte-for-byte. */
function rawReq(method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port: PORT, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(b) }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0) }));
    r.end();
  });
}

// ── Fixtures: one per format the brief requires ─────────────────────────────
// Real magic bytes, so "did the proxy corrupt it?" is a byte-level question.
const FILES = {
  'report.pdf':            { ct: 'application/pdf', body: Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(4096), Buffer.from('\n%%EOF')]) },
  'my report 2026.docx':   { ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(8192)]) },
  'data.xlsx':             { ct: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(4096)]) },
  'deck.pptx':             { ct: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(4096)]) },
  'photo.png':             { ct: 'image/png', body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2048)]) },
  'archive.zip':           { ct: 'application/zip', body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(16384)]) },
  // Text-ish payloads whose bodies are filled in once the upstream is listening (below) so
  // they contain the REAL upstream origin. That matters: the rewriter only ever rewrites the
  // configured TARGET_ORIGIN, so a fixture mentioning some unrelated host would pass these
  // tests trivially without proving anything.
  'notes.txt':             { ct: 'text/plain; charset=utf-8', body: null },
  'export.json':           { ct: 'application/json', body: null },
  'page.html':             { ct: 'text/html; charset=utf-8', body: null },
  'large.bin':             { ct: 'application/octet-stream', body: crypto.randomBytes(3 * 1024 * 1024) },  // 3 MB
};

let upstream, backend, gw, UP;

test.before(async () => {
  upstream = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    // Download: Content-Disposition attachment, like Claude's file endpoint.
    if (u.pathname.startsWith('/api/organizations/ORG/files/')) {
      const name = decodeURIComponent(u.pathname.split('/').pop());
      const f = FILES[name];
      if (!f) { r.writeHead(404); return r.end(); }
      const inline = u.searchParams.get('inline') === '1';
      r.writeHead(200, {
        'content-type': f.ct,
        'content-length': String(f.body.length),
        'content-disposition': (inline ? 'inline' : 'attachment') + '; filename="' + name + '"',
        'accept-ranges': 'bytes',
      });
      return r.end(f.body);
    }
    // The app's own JSON — must still be rewritten/served as before (not an attachment).
    if (u.pathname === '/api/bootstrap') {
      r.writeHead(200, { 'content-type': 'application/json' });
      return r.end(JSON.stringify({ ok: true, cdn: UP + '/assets/x.js' }));
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>');
  });
  await new Promise(r => upstream.listen(0, r));
  // Now that the port is known, build the text fixtures around the REAL upstream origin —
  // i.e. the one string the proxy's rewriter would actually have rewritten.
  UP = 'http://127.0.0.1:' + upstream.address().port;
  FILES['notes.txt'].body = Buffer.from('See ' + UP + '/chat/abc for the original thread.\nLine 2.\n');
  FILES['export.json'].body = Buffer.from(JSON.stringify({ source: UP + '/api/x', n: 42 }));
  FILES['page.html'].body = Buffer.from('<html><head></head><body>saved from ' + UP + '</body></html>');

  backend = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, terminal: false, retryable: false, secondsRemaining: 1800, expiresAt: new Date(Date.now() + 1800000).toISOString(), serverTime: new Date().toISOString() }));
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT' }] } }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));

  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
    }),
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const h = await rawReq('GET', '/__genz/health');
    if (h.status === 200) break;
    await new Promise(r => setTimeout(r, 150));
  }
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});

async function session(ua) {
  const r = await rawReq('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': ua });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set the opaque session cookie');
  return sc.split(';')[0];
}
const dl = (cookie, name, ua, extra) => rawReq('GET', '/api/organizations/ORG/files/' + encodeURIComponent(name), Object.assign({ cookie, 'user-agent': ua || DESKTOP }, extra || {}));

// ══ 1. The regex that hid the button ════════════════════════════════════════
test('THE BUG: a bare "Download" label is no longer hidden, app promos still are', () => {
  const src = fs.readFileSync(path.join(GW, 'public/overlay.js'), 'utf8');
  const CH = eval(src.match(/var CLAUDE_HIDE_RE = (\/.*\/i);/)[1]);

  // Must survive — these are working-area controls.
  for (const keep of ['Download', 'download', 'DOWNLOAD']) {
    assert.strictEqual(CH.test(keep), false, keep + ' must NOT be hidden — it is the file download control');
  }
  // Must still be hidden — these are account-menu app promos.
  for (const hide of ['Download apps', 'Download app', 'Download for Mac', 'Download for Windows']) {
    assert.strictEqual(CH.test(hide), true, hide + ' must still be hidden');
  }
});

test('no other legitimate Claude control is caught by either hide rule', () => {
  const src = fs.readFileSync(path.join(GW, 'public/overlay.js'), 'utf8');
  const CH = eval(src.match(/var CLAUDE_HIDE_RE = (\/.*\/i);/)[1]);
  const H = eval(src.match(/var HIDE_RE = (\/.*\/i);/)[1]);
  const K = eval(src.match(/var KEEP_RE = (\/.*\/i);/)[1]);
  const WS = eval(src.match(/var WS_KEEP_RE = (\/.*\/i);/)[1]);
  const controls = [
    'Download', 'Copy', 'Copy code', 'Retry', 'Edit', 'Share', 'Preview', 'Save', 'Export',
    'Send', 'Stop', 'Attach files', 'Upload', 'Add files', 'Artifacts', 'Code', 'Run',
    'Publish', 'Search', 'Search chats', 'New chat', 'Rename', 'Delete', 'Star', 'Pin',
    'Continue', 'Regenerate', 'Open in side panel', 'Expand', 'Collapse', 'Close',
    'Extended thinking', 'Projects', 'Screenshot', 'Paste', 'Select all', 'Print',
  ];
  const hidden = controls.filter(t => !K.test(t) && !WS.test(t) && (CH.test(t) || H.test(t)));
  assert.deepStrictEqual(hidden, [], 'these working-area controls must not be hidden: ' + hidden.join(', '));
});

// ══ 2. Bytes: every required format survives intact ═════════════════════════
for (const name of Object.keys(FILES)) {
  test('download is byte-identical and keeps its name: ' + name, async () => {
    const cookie = await session(DESKTOP);
    const r = await dl(cookie, name);
    assert.strictEqual(r.status, 200, name + ' must download');
    assert.ok(r.buf.equals(FILES[name].body), name + ' must arrive byte-for-byte identical (no rewriting/injection)');
    const cd = String(r.headers['content-disposition'] || '');
    assert.match(cd, /attachment/i, name + ' must stay an attachment');
    assert.ok(cd.includes(name), 'filename + extension preserved, got: ' + cd);
    assert.strictEqual(String(r.headers['content-type']), FILES[name].ct, 'content-type preserved');
  });
}

test('a saved .html file is NOT injected with the overlay or hide CSS', async () => {
  const cookie = await session(DESKTOP);
  const r = await dl(cookie, 'page.html');
  const text = r.buf.toString('utf8');
  assert.strictEqual(text, FILES['page.html'].body.toString('utf8'));
  for (const marker of ['genz-critical-hide', 'genz-sw-widget', '__GENZ_GATEWAY__', 'genz-overlay']) {
    assert.ok(!text.includes(marker), 'downloaded HTML must not contain ' + marker);
  }
});

test('text/plain and JSON downloads are not URL-rewritten', async () => {
  const cookie = await session(DESKTOP);
  for (const name of ['notes.txt', 'export.json']) {
    const got = (await dl(cookie, name)).buf.toString('utf8');
    // UP is the exact origin the rewriter targets, so this genuinely proves it was skipped.
    assert.ok(got.includes(UP), name + ': the file\'s own content must be preserved verbatim');
    assert.ok(!got.includes(':' + PORT), name + ': the gateway host must never be written into a user file');
  }
});

test('large files keep a correct content-length (progress + iOS reliability)', async () => {
  const cookie = await session(DESKTOP);
  const r = await dl(cookie, 'large.bin');
  assert.strictEqual(r.buf.length, FILES['large.bin'].body.length, '3 MB must arrive complete');
  assert.ok(r.buf.equals(FILES['large.bin'].body), 'and byte-identical');
  assert.strictEqual(String(r.headers['content-length']), String(FILES['large.bin'].body.length), 'content-length preserved for attachments');
});

test('filenames with spaces survive intact', async () => {
  const cookie = await session(DESKTOP);
  const r = await dl(cookie, 'my report 2026.docx');
  assert.match(String(r.headers['content-disposition']), /my report 2026\.docx/);
  assert.ok(r.buf.equals(FILES['my report 2026.docx'].body));
});

test('Range requests still work (accept-ranges is passed through)', async () => {
  const cookie = await session(DESKTOP);
  const r = await dl(cookie, 'report.pdf');
  assert.strictEqual(r.headers['accept-ranges'], 'bytes', 'range support must not be hidden from the browser');
});

// ══ 3. Mobile ══════════════════════════════════════════════════════════════
for (const [label, ua] of [['Android Chrome', ANDROID], ['iPhone Safari', IPHONE]]) {
  test(label + ': binary and text downloads are intact', async () => {
    const cookie = await session(ua);
    for (const name of ['report.pdf', 'archive.zip', 'photo.png', 'notes.txt']) {
      const r = await dl(cookie, name, ua);
      assert.strictEqual(r.status, 200, label + ' ' + name);
      assert.ok(r.buf.equals(FILES[name].body), label + ': ' + name + ' must be byte-identical');
      assert.match(String(r.headers['content-disposition']), /attachment/i);
    }
  });
}

// ══ 4. Nothing else changed ════════════════════════════════════════════════
test('PRESERVED: inline preview is still served inline, not forced to download', async () => {
  const cookie = await session(DESKTOP);
  const r = await rawReq('GET', '/api/organizations/ORG/files/photo.png?inline=1', { cookie, 'user-agent': DESKTOP });
  assert.strictEqual(r.status, 200);
  assert.match(String(r.headers['content-disposition']), /inline/i, 'preview must stay inline');
  assert.ok(r.buf.equals(FILES['photo.png'].body), 'preview bytes intact');
});

test('PRESERVED: the app\'s own JSON is still rewritten to the gateway origin', async () => {
  const cookie = await session(DESKTOP);
  const r = await rawReq('GET', '/api/bootstrap', { cookie, 'user-agent': DESKTOP });
  const body = r.buf.toString('utf8');
  assert.ok(!body.includes(UP), 'non-attachment JSON must still be rewritten (upstream host never leaked)');
  assert.ok(body.includes(':' + PORT), 'and pointed at the gateway');
});

test('PRESERVED: the main app page still gets the overlay', async () => {
  const cookie = await session(DESKTOP);
  const r = await rawReq('GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP });
  const html = r.buf.toString('utf8');
  assert.match(html, /CLAUDE_APP_OK/, 'the app still loads');
  assert.ok(html.includes('genz-sw-widget') || html.includes('__GENZ_GATEWAY__'), 'the widget is still injected on real pages');
});

// ══ 5. Access control is unchanged ═════════════════════════════════════════
test('SECURITY: a download requires a valid session', async () => {
  const r = await dl('', 'report.pdf');
  assert.strictEqual(r.status, 403, 'no session → no file');
  assert.ok(!r.buf.equals(FILES['report.pdf'].body), 'file bytes must never be served unauthenticated');
});

test('SECURITY: the upstream host and account cookies never leak to the client', async () => {
  const cookie = await session(DESKTOP);
  const r = await dl(cookie, 'report.pdf');
  const all = JSON.stringify(r.headers);
  assert.ok(!/sessionKey|VAULT/.test(all), 'vault account cookies must never reach the browser');
  for (const h of ['server', 'via', 'cf-ray', 'x-powered-by']) {
    assert.strictEqual(r.headers[h], undefined, h + ' must stay stripped on downloads');
  }
});

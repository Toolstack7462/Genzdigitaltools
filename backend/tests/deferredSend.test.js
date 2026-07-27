'use strict';
/**
 * sendAfterResponse must run the outbound send STRICTLY AFTER the response is flushed,
 * exactly once, and must never let a failure escape into the request.
 *
 * WHY THIS MATTERS. This helper is the whole fix for the recurring signup/renewal 503. The web
 * server on this host kills a worker whose request is still open after ~2s and serves its own
 * CORS-less 503 page; the outbound mail call routinely exceeds that. Answering first takes the
 * provider off the request's critical path. If the ordering guarantee were ever broken — if the
 * send started before the response flushed, or a throw propagated — the 503 would come straight
 * back, so it is pinned here rather than trusted.
 *
 * Run: node --test tests/deferredSend.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { sendAfterResponse } = require('../utils/deferredSend');

function makeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function get(port, path = '/') {
  return new Promise((resolve) => {
    http.get({ port, path }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}

test('the send starts only AFTER the response has been flushed', async () => {
  const order = [];
  let sendStarted;
  const started = new Promise((r) => { sendStarted = r; });

  const server = await makeServer((req, res) => {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"queued":true}');
    order.push('responded');
    sendAfterResponse(res, 'test', async () => { order.push('send-started'); sendStarted(); });
  });
  const port = server.address().port;

  const r = await get(port);
  assert.equal(r.status, 202, 'the client gets its answer immediately');
  await started;
  assert.deepEqual(order, ['responded', 'send-started'], 'ordering must be response-then-send');
  server.close();
});

test('a SLOW send does not delay the response — the point of the whole helper', async () => {
  const server = await makeServer((req, res) => {
    res.writeHead(202); res.end('ok');
    // 1.5s is longer than the ~2s worker-kill window leaves to spare; the client must not wait.
    sendAfterResponse(res, 'slow', () => new Promise((r) => setTimeout(r, 1500)));
  });
  const port = server.address().port;

  const t0 = Date.now();
  const r = await get(port);
  const ms = Date.now() - t0;
  assert.equal(r.status, 202);
  assert.ok(ms < 500, `client waited ${ms}ms for a 1500ms send — it must not wait at all`);
  await new Promise((x) => setTimeout(x, 1600)); // let the deferred task finish before closing
  server.close();
});

test('a THROWING send is contained and logged, never surfaced to the client', async () => {
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));

  const server = await makeServer((req, res) => {
    res.writeHead(202); res.end('ok');
    sendAfterResponse(res, 'boom', async () => { throw new Error('provider exploded'); });
  });
  const port = server.address().port;

  const r = await get(port);
  assert.equal(r.status, 202, 'the client still gets a clean answer');
  await new Promise((x) => setTimeout(x, 120));
  console.error = realErr;
  server.close();
  assert.ok(errs.some((l) => l.includes('boom') && l.includes('provider exploded')),
    'the failure must be logged, never silent');
});

test('the task runs EXACTLY ONCE even though both finish and close fire', async () => {
  let runs = 0;
  const server = await makeServer((req, res) => {
    res.writeHead(202); res.end('ok');
    sendAfterResponse(res, 'once', async () => { runs += 1; });
  });
  const port = server.address().port;

  await get(port);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runs, 1, `send ran ${runs} times — a duplicate would mean a duplicate email`);
  server.close();
});

test('if the response is already flushed, the send still runs', async () => {
  // Guards the ordering branch: res.writableEnded is true by the time we attach.
  let ran = false;
  const server = await makeServer((req, res) => {
    res.writeHead(202); res.end('ok');
    setTimeout(() => sendAfterResponse(res, 'late', async () => { ran = true; }), 50);
  });
  const port = server.address().port;

  await get(port);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(ran, true, 'attaching after the flush must not silently drop the send');
  server.close();
});

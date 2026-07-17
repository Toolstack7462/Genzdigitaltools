'use strict';
/**
 * Unit tests for the claude-gateway quota tap (lib/quotaTap.js). Pure — no network, no server.
 * Run: node --test claude-gateway/lib/quotaTap.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const tap = require('./quotaTap');

test('isCompletionRequest matches claude.ai completion POSTs only', () => {
  assert.equal(tap.isCompletionRequest('POST', '/api/organizations/abc/chat_conversations/def/completion'), true);
  assert.equal(tap.isCompletionRequest('POST', '/api/organizations/abc/chat_conversations/def/retry_completion'), true);
  assert.equal(tap.isCompletionRequest('POST', '/api/organizations/abc/chat_conversations/def/completion?a=1'), true);
  // wrong method
  assert.equal(tap.isCompletionRequest('GET', '/api/organizations/abc/chat_conversations/def/completion'), false);
  // unrelated paths never match (assets, other API)
  assert.equal(tap.isCompletionRequest('POST', '/api/organizations/abc/chat_conversations/def'), false);
  assert.equal(tap.isCompletionRequest('POST', '/api/bootstrap'), false);
  assert.equal(tap.isCompletionRequest('POST', '/static/app.js'), false);
});

test('extractRequestChars counts prompt + system + attachments', () => {
  const body = JSON.stringify({
    prompt: 'hello world',                          // 11
    custom_instructions: 'be brief',                // 8 → system
    attachments: [{ file_name: 'a.txt', extracted_content: 'DATA' }], // 5 + 4 = 9 → attachment
  });
  const c = tap.extractRequestChars(body);
  assert.equal(c.inputChars, 11);
  assert.equal(c.systemChars, 8);
  assert.equal(c.attachmentChars, 9);
});

test('extractRequestChars falls back to raw length on non-JSON', () => {
  const c = tap.extractRequestChars('not json at all');
  assert.equal(c.inputChars, 'not json at all'.length);
  assert.equal(c.systemChars, 0);
});

test('extractRequestChars handles a Buffer and empty body', () => {
  const c = tap.extractRequestChars(Buffer.from(JSON.stringify({ prompt: 'abcd' })));
  assert.equal(c.inputChars, 4);
  const e = tap.extractRequestChars('');
  assert.deepEqual(e, { inputChars: 0, systemChars: 0, contextChars: 0, attachmentChars: 0 });
});

test('completionTextLen extracts text across SSE payload shapes', () => {
  assert.equal(tap.completionTextLen('{"completion":" Hi"}'), 3);
  assert.equal(tap.completionTextLen('{"delta":{"type":"text_delta","text":"Hello"}}'), 5);
  assert.equal(tap.completionTextLen('{"type":"content_block_delta","text":"abc"}'), 3);
  assert.equal(tap.completionTextLen('{"type":"message_start"}'), 0); // control event → 0
  assert.equal(tap.completionTextLen('not json'), 0);
});

test('countSseText tallies a full streamed answer', () => {
  const sse = [
    'event: completion',
    'data: {"completion":"Hello"}',   // 5
    '',
    'data: {"completion":", world"}', // 7
    '',
    'data: [DONE]',                   // 0
    '',
  ].join('\n');
  assert.equal(tap.countSseText(sse), 12);
});

test('SseCounter handles chunk boundaries splitting a line mid-way', () => {
  const c = new tap.SseCounter();
  // A single data line delivered across three chunks (split inside the JSON).
  c.write('data: {"comple');
  c.write('tion":"Hel');
  c.write('lo"}\n');
  assert.equal(c.end(), 5);
});

test('SseCounter ignores comments and non-data lines', () => {
  const c = new tap.SseCounter();
  c.write(': ping\n');
  c.write('event: completion\n');
  c.write('data: {"delta":{"text":"hi"}}\n');
  assert.equal(c.end(), 2);
});

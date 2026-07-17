'use strict';
/**
 * quotaTap — PURE, dependency-free helpers for the Claude token-quota tap in the claude-gateway.
 * CLAUDE-ONLY: this file is required only by claude-gateway/server.js and only runs when
 * TOOL_KEY==='claude', so it can never touch any other tool's gateway.
 *
 * It extracts ESTIMATED usage from the CHARACTER LENGTH of a Claude completion request/response.
 * It NEVER stores, logs, forwards or returns prompt text, cookies, sessions or account
 * internals — the char counts it produces are handed to the backend, which owns all numeric
 * policy. Everything here is deterministic and unit-tested (see tests/quotaTap.test.js).
 */

// Is this the request that SENDS a Claude message (the thing we meter)? claude.ai posts to
// /api/organizations/<org>/chat_conversations/<conv>/completion (or /retry_completion) and
// streams the answer back as SSE. Overridable via env if claude.ai ever moves the path.
function completionRe() {
  const raw = process.env.CLAUDE_COMPLETION_PATH_RE;
  if (raw) { try { return new RegExp(raw); } catch (_) { /* fall through to default */ } }
  return /\/chat_conversations\/[^/]+\/(retry_)?completion\b/i;
}
function isCompletionRequest(method, path) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return completionRe().test(String(path || '').split('?')[0]);
}

function len(v) { return typeof v === 'string' ? v.length : 0; }

// Extract per-component character counts from a completion request body (Buffer or string).
// Defensive: unknown/oversized/broken JSON falls back to counting the raw body as input, so we
// never silently count zero for a real message.
function extractRequestChars(body) {
  const str = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!str) return { inputChars: 0, systemChars: 0, contextChars: 0, attachmentChars: 0 };
  let data = null;
  try { data = JSON.parse(str); } catch (_) { data = null; }
  if (!data || typeof data !== 'object') {
    // Not JSON we understand → the whole body is a rough proxy for the input size.
    return { inputChars: str.length, systemChars: 0, contextChars: 0, attachmentChars: 0 };
  }
  let inputChars = 0, systemChars = 0, contextChars = 0, attachmentChars = 0;
  // The new user message.
  inputChars += len(data.prompt) + len(data.text) + len(data.message);
  // System / custom instructions / style, when present in the body.
  systemChars += len(data.system) + len(data.custom_instructions) + len(data.system_prompt);
  if (Array.isArray(data.personalized_styles)) {
    for (const s of data.personalized_styles) { if (s) systemChars += len(s.prompt) + len(s.instruction) + len(s.summary); }
  }
  // Context carried in the body (rendering/tools/sync sources are references, not big text).
  contextChars += len(data.context) + len(data.rendering_mode ? '' : '');
  if (Array.isArray(data.sync_sources)) { for (const s of data.sync_sources) { if (s) contextChars += len(s.text) + len(s.content); } }
  // Attachments: their extracted text is what actually enters the prompt.
  if (Array.isArray(data.attachments)) {
    for (const a of data.attachments) {
      if (!a) continue;
      attachmentChars += len(a.extracted_content) + len(a.file_name) + len(a.content);
    }
  }
  if (Array.isArray(data.files)) { for (const f of data.files) { if (f) attachmentChars += len(f.extracted_content) + len(f.file_name); } }
  return { inputChars, systemChars, contextChars, attachmentChars };
}

// Extract answer text from ONE SSE `data:` JSON payload across the shapes claude.ai has used:
//   {"completion":" Hi"}                                   (classic)
//   {"delta":{"type":"text_delta","text":"Hi"}}           (content-block streaming)
//   {"delta":{"completion":"Hi"}} / {"text":"Hi"}         (variants)
// Returns the added text length. Unknown shapes contribute 0 (never counts control JSON).
function completionTextLen(dataJson) {
  let obj = null;
  try { obj = JSON.parse(dataJson); } catch (_) { return 0; }
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  if (typeof obj.completion === 'string') n += obj.completion.length;
  if (obj.delta && typeof obj.delta === 'object') {
    if (typeof obj.delta.text === 'string') n += obj.delta.text.length;
    if (typeof obj.delta.completion === 'string') n += obj.delta.completion.length;
  }
  // Some server-sent shapes put a bare text field on a content_block_delta.
  if (typeof obj.text === 'string' && obj.type && /delta/i.test(String(obj.type))) n += obj.text.length;
  return n;
}

// Streaming counter: feed it response chunks (Buffer/string) as they arrive; it buffers partial
// lines and tallies output characters. `.total` is the running estimate. Pure/in-memory; holds
// only a short line remainder, never the whole response.
class SseCounter {
  constructor() { this._buf = ''; this.total = 0; }
  write(chunk) {
    this._buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      this._consume(line);
    }
  }
  end() { if (this._buf) { this._consume(this._buf); this._buf = ''; } return this.total; }
  _consume(line) {
    const s = line.replace(/\r$/, '').trim();
    if (!s || s[0] === ':') return;                 // blank / comment
    if (!/^data:/i.test(s)) return;                 // only data: lines carry payloads
    const payload = s.replace(/^data:\s*/i, '');
    if (payload === '[DONE]') return;
    this.total += completionTextLen(payload);
  }
}

// Count output chars from a COMPLETE SSE payload string (used in tests + non-streaming fallback).
function countSseText(fullText) {
  const c = new SseCounter();
  c.write(fullText);
  return c.end();
}

module.exports = { isCompletionRequest, extractRequestChars, completionTextLen, SseCounter, countSseText };

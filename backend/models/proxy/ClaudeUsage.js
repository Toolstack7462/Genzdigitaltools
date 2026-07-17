'use strict';
/**
 * ClaudeUsage — an APPEND-ONLY ledger of estimated local token usage for Claude requests.
 * ISOLATED and claude-only (every row is tool='claude'); no other proxy tool writes here.
 *
 * WHY a ledger (not a counter on the client/account row): current usage is computed by
 * SUMMING the rows of the current cycle. Appending a row is a single INSERT, so two
 * concurrent requests can never lose each other's write (there is no read-modify-write of a
 * shared counter) — this is the race-safe foundation for the quota checks.
 *
 * A row records ONLY estimated token counts + the ids/timestamps/cycle-bucket needed to
 * aggregate them. It NEVER stores prompt text, cookies, sessions, tokens or any Claude
 * account internals — only integer character-derived estimates. All figures are
 * `Estimated local token usage`, not Anthropic's official metering.
 */
const { createModel } = require('../../db/mysqlAdapter');

const ClaudeUsage = createModel('ClaudeUsage', {
  preSave: async (data) => {
    data.tool = 'claude'; // hard-pinned: this ledger is claude-only
    data.accountId = data.accountId != null ? String(data.accountId) : null;
    data.proxyClientId = data.proxyClientId != null ? String(data.proxyClientId) : null;
    data.userId = data.userId != null ? String(data.userId) : null;
    data.cycleKey = data.cycleKey ? String(data.cycleKey) : '';
    data.weekKey = data.weekKey ? String(data.weekKey) : '';
    const n = (v) => Math.max(0, Math.trunc(Number(v) || 0));
    data.inputTokens = n(data.inputTokens);
    data.outputTokens = n(data.outputTokens);
    // Always keep total coherent with its parts.
    data.totalTokens = data.totalTokens != null ? n(data.totalTokens) : (data.inputTokens + data.outputTokens);
    if (!data.at) data.at = new Date();
    // `kind` lets a pre-check reservation ('precheck') be told apart from a settled
    // 'usage' row if ever needed; defaults to 'usage'. Never affects other tools.
    if (!data.kind) data.kind = 'usage';
    return data;
  },
});

module.exports = ClaudeUsage;

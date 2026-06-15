'use strict';
/**
 * Reset every StealthWriter client's daily usage counters. Used by both the cron
 * script (scripts/stealth-reset.js) and the in-process scheduler. Lazy reset in
 * utils/stealth/time.js guarantees correctness even if this never runs; this is
 * the proactive daily reset at 05:00 PKT.
 */
const StealthClient = require('../../models/stealth/StealthClient');

async function resetAllUsage() {
  const now = new Date();
  const clients = await StealthClient.find({});
  let reset = 0;
  for (const client of clients) {
    client.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: now };
    await client.save();
    reset += 1;
  }
  return { reset, at: now };
}

module.exports = { resetAllUsage };

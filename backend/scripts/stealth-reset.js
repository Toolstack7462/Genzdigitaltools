'use strict';
/**
 * StealthWriter daily usage reset — cron entrypoint.
 *
 * Schedule this at 05:00 Asia/Karachi (Pakistan) time. On Hostinger / cPanel the
 * server clock is usually UTC, where 05:00 PKT == 00:00 UTC, so a crontab line of:
 *
 *     0 0 * * *  cd /home/USER/backend && node scripts/stealth-reset.js >> logs/stealth-reset.log 2>&1
 *
 * runs it at the right moment. If the server clock is already Asia/Karachi, use
 * `0 5 * * *` instead. Lazy reset (utils/stealth/time.js) is the safety net, so a
 * missed cron run never lets stale counters through.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mysqlAdapter = require('../db/mysqlAdapter');
const { resetAllUsage } = require('../utils/stealth/resetAll');

(async () => {
  try {
    await mysqlAdapter.connect();
    const { reset, at } = await resetAllUsage();
    console.log(`[stealth-reset] reset usage for ${reset} client(s) at ${at.toISOString()}`);
    await mysqlAdapter.close();
    process.exit(0);
  } catch (err) {
    console.error('[stealth-reset] failed:', err.message);
    process.exit(1);
  }
})();

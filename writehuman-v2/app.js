'use strict';
/**
 * Passenger entry shim. Hostinger's LiteSpeed Passenger looks for `app.js` (or the configured
 * startup file) as the Node app entry. WriteHuman V2's real entry is server.js — this just
 * loads it so the app boots whether Passenger is pointed at app.js or server.js.
 */
require('./server.js');

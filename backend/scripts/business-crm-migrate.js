#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../modules/business-crm/db');
(async () => { try { const result = await db.ensureSchema(); console.log(`Business CRM schema ready: ${result.version}`); } catch (error) { console.error(error.message); process.exitCode = 1; } finally { await db.close().catch(() => {}); } })();

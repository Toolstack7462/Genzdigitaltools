'use strict';
/**
 * WriteHuman V2 — resolved Supabase config for the supabase_refresh verifier.
 * Returns { url, projectRef, anonKey } from config (env overrides → public defaults),
 * or null if unconfigured. The anonKey is PUBLIC and is never logged.
 */
const { config } = require('./config');

function supabaseConfig() {
  const s = config.supabase || {};
  if (!s.url || !s.anonKey) return null;
  return { url: s.url, projectRef: s.projectRef || '', anonKey: s.anonKey };
}

module.exports = { supabaseConfig };

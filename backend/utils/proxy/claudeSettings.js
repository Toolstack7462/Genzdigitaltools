'use strict';
/**
 * Claude global-settings loader — bridges the ClaudeSettings row and claudeQuota's runtime
 * global overrides. Claude-only, isolated, fail-safe.
 *
 *  ensureLoaded() — load the row ONCE (memoized) and apply it to claudeQuota. Called at the
 *                   start of enforcement/admin paths so global overrides are active before any
 *                   limit is resolved. A DB error just leaves env defaults in effect.
 *  get()          — the current stored row (safe integers only), or {} if none.
 *  update(patch)  — upsert the row and apply immediately (no reload/redeploy needed).
 */
const quota = require('./claudeQuota');

function model() { return require('../../models/proxy/ClaudeSettings'); }

let _loaded = null; // memoized promise (success only)

// Throws on a real DB error so ensureLoaded() can RETRY on the next call instead of caching a
// boot-time failure forever (env defaults stay in effect meanwhile).
async function _readAndApply() {
  const Settings = model();
  const id = Settings.SINGLETON_ID();
  const row = await Settings.findById(id);
  const cfg = row ? pick(row) : {};
  quota.setGlobalConfig(cfg);
  return cfg;
}

function pick(row) {
  const out = {};
  for (const k of quota.OVERRIDE_KEYS) {
    const v = row[k];
    if (v != null && v !== '' && Number.isFinite(Number(v))) out[k] = Math.trunc(Number(v));
  }
  return out;
}

function ensureLoaded() {
  if (!_loaded) {
    _loaded = _readAndApply().then(
      (cfg) => cfg,
      () => { _loaded = null; return {}; }  // reset memo → retry next call; env defaults for now
    );
  }
  return _loaded;
}

async function get() {
  await ensureLoaded();
  return quota.getGlobalOverrides();
}

async function update(patch) {
  const Settings = model();
  const id = Settings.SINGLETON_ID();
  const existing = await Settings.findById(id);
  const data = {};
  for (const k of quota.OVERRIDE_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      data[k] = (patch[k] === '' || patch[k] == null) ? null : patch[k];
    } else if (existing) {
      data[k] = existing[k] ?? null;
    } else {
      data[k] = null;
    }
  }
  if (existing) {
    for (const k of quota.OVERRIDE_KEYS) existing[k] = data[k];
    await existing.save();
  } else {
    await Settings.create(Object.assign({ _id: id }, data));
  }
  const applied = quota.setGlobalConfig(data);
  _loaded = Promise.resolve(applied); // refresh the memo
  return applied;
}

module.exports = { ensureLoaded, get, update };

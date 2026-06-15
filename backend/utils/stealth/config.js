'use strict';
/**
 * StealthWriter settings accessor — guarantees a single settings row exists and
 * returns safe, clamped values. The model preSave clamps ranges; this layer
 * provides the "get-or-create" singleton behaviour and an update helper.
 */
const StealthSettings = require('../../models/stealth/StealthSettings');

const DEFAULTS = {
  leaseDurationMinutes: 30,
  fixedLeaseEnabled: true,
  maxSessionMinutes: 720,
};

async function getSettings() {
  let row = await StealthSettings.findOne({});
  if (!row) {
    row = await StealthSettings.create({ ...DEFAULTS });
  }
  return row;
}

async function getSettingsObject() {
  const row = await getSettings();
  const obj = row.toObject ? row.toObject() : row;
  return {
    leaseDurationMinutes: obj.leaseDurationMinutes,
    fixedLeaseEnabled: obj.fixedLeaseEnabled,
    maxSessionMinutes: obj.maxSessionMinutes,
    updatedAt: obj.updatedAt,
  };
}

async function updateSettings(patch = {}, actorId) {
  const row = await getSettings();
  if (patch.leaseDurationMinutes !== undefined) row.leaseDurationMinutes = patch.leaseDurationMinutes;
  if (patch.fixedLeaseEnabled !== undefined) row.fixedLeaseEnabled = patch.fixedLeaseEnabled;
  if (patch.maxSessionMinutes !== undefined) row.maxSessionMinutes = patch.maxSessionMinutes;
  if (actorId) row.updatedBy = actorId;
  await row.save();
  return getSettingsObject();
}

/** Effective lease lifetime (minutes) given current settings. */
function effectiveLeaseMinutes(settings) {
  return settings.fixedLeaseEnabled ? settings.leaseDurationMinutes : settings.maxSessionMinutes;
}

module.exports = { DEFAULTS, getSettings, getSettingsObject, updateSettings, effectiveLeaseMinutes };

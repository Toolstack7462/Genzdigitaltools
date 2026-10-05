'use strict';
/**
 * SupportSettings — single-row, admin-configurable PUBLIC support contact.
 *
 *  - whatsappNumber : official WhatsApp support number, digits only, country-coded
 *                     (the form wa.me expects, e.g. "923355500134").
 *  - supportEmail   : public support email shown on the website.
 *
 * Only Gen Z's own public contact lives here — never customer numbers, payment
 * recipients, OTP/messaging credentials or anything secret. Access ONLY through
 * utils/supportContact.js, which validates, caches and falls back to env/defaults.
 */
const { createModel } = require('../db/mysqlAdapter');

const SupportSettings = createModel('SupportSettings', {
  preSave: async (data) => {
    data.whatsappNumber = String(data.whatsappNumber || '').replace(/\D/g, '');
    data.supportEmail = String(data.supportEmail || '').trim().toLowerCase();
    return data;
  }
});

module.exports = SupportSettings;

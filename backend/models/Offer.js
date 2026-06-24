'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * Offer — a marketing/promotional offer shown in the admin Marketing hub and
 * (optionally) on client dashboards. Distinct from Announcement (plain notices)
 * and from the Renewals follow-up offers (which grant per-client recovery offers);
 * an Offer is a structured promo (combo bundle / renewal / upgrade / recovery).
 *
 * Fields (safe metadata only — NO secrets):
 *   title, description, kind ('combo'|'renewal'|'upgrade'|'recovery'),
 *   toolIds [], toolNames [] (denormalized for display — clients never query tools),
 *   priceText (free text, e.g. "Save 30%" / "PKR 1500/mo"),
 *   expiryDate, active (published), showOnDashboard (render as a client card),
 *   clientId/clientLabel (null = all clients; else targeted to one),
 *   createdBy, createdAt, updatedAt.
 */
const Offer = createModel('Offer', {});

module.exports = Offer;

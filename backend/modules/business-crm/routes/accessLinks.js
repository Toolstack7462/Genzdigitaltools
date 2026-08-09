'use strict';

/**
 * Website access → Business CRM link inbox.
 *
 * Read/reconcile endpoints over biz_crm_access_links plus the one action that turns a discovered
 * website access record into a real CRM sale. Financial values are entered HERE (inside the CRM),
 * never on the existing Give Access / Assign Tool / Bulk Assign / Proxy / StealthWriter screens.
 *
 * Creating the financial record goes through the ordinary salesService.createSale pipeline, so
 * invoice numbering, currency rules, permissions, payments and audit behave exactly as they do for
 * a manual sale — the only addition is that the resulting sale item is tagged WEBSITE_LINKED and
 * attached back to the access link.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler, pageParams, safeLike } = require('../http');
const { validate } = require('../validation');
const { requirePermission } = require('../permissions');
const sales = require('../services/salesService');
const websiteAccess = require('../services/websiteAccessService');
const { httpError } = require('../services/salesService');

const router = express.Router();

// The sweep reads every assignment plus the proxy/stealth read model, so it is deliberately
// cheaper to call than to spam. Idempotent, so a throttled caller loses nothing.
const reconcileLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.userId || req.ip),
  message: { error: 'Reconciliation is rate limited; try again shortly', code: 'RECONCILE_RATE_LIMITED' },
});

router.get('/', requirePermission('website-access.view'), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const filters = {
    financialStatus: req.query.financialStatus ? String(req.query.financialStatus) : null,
    accessStatus: req.query.accessStatus ? String(req.query.accessStatus) : null,
    sourceType: req.query.sourceType ? String(req.query.sourceType) : null,
    search: req.query.search ? safeLike(req.query.search) : null,
  };
  const [result, counts] = await Promise.all([
    websiteAccess.listLinks(filters, { limit: pageSize, offset }),
    websiteAccess.summary(),
  ]);
  res.json({ ...result, page, pageSize, summary: counts });
}));

router.post('/reconcile', requirePermission('website-access.reconcile'), reconcileLimiter, asyncHandler(async (req, res) => {
  const result = await websiteAccess.reconcile(req);
  // A partial sweep is reported as 200 with `partial: true`, not as an error: the rows that did
  // reconcile are valid and the caller should still render them.
  res.json(result);
}));

router.get('/:id', requirePermission('website-access.view'), asyncHandler(async (req, res) => {
  const link = await websiteAccess.getLink(req.params.id);
  if (!link) throw httpError('Access link not found', 404, 'ACCESS_LINK_NOT_FOUND');
  res.json(link);
}));

/**
 * Complete Financial Details. The client and the operational dates come from the access link (the
 * website is the source of truth for those); the body supplies only money.
 */
router.post('/:id/create-financial-record',
  requirePermission('website-access.financial-link'),
  requirePermission('sales.create'),
  validate('saleCreate'),
  asyncHandler(async (req, res) => {
    const link = await websiteAccess.getLink(req.params.id);
    if (!link) throw httpError('Access link not found', 404, 'ACCESS_LINK_NOT_FOUND');
    if (link.financialStatus === 'LINKED_TO_SALE') {
      throw httpError('This access record already has a financial record', 409, 'ACCESS_LINK_ALREADY_LINKED');
    }
    if (!link.crmClientId) {
      throw httpError('Resolve the CRM client for this access record first', 409, 'ACCESS_LINK_CLIENT_UNRESOLVED');
    }

    // Operational fields are forced from the link, never taken from the request body, so the CRM
    // can never disagree with the website about who has access to what and until when.
    const payload = {
      ...req.validated,
      clientId: link.crmClientId,
      items: req.validated.items.map((item, index) => (index === 0
        ? { ...item, name: item.name || link.toolName, purchaseDate: link.startDate, expiryDate: link.expiryDate }
        : item)),
    };

    const sale = await sales.createSale(req, payload);
    const firstItem = (sale.items || [])[0];

    // The sale is committed at this point. If attaching it to the access link fails we must NOT
    // report a failure — that would invite the operator to create the invoice a second time.
    // Report the sale as created with linked:false so it can be retried explicitly instead.
    let linked = false;
    let linkError = null;
    if (firstItem) {
      try {
        await websiteAccess.attachSale(req, link.id, sale.id, firstItem.id, link.externalKey);
        linked = true;
      } catch (error) {
        linkError = error.message;
      }
    }
    res.status(201).json({
      sale: sales.forRequest(req, sale),
      link: await websiteAccess.getLink(link.id),
      linked,
      linkError,
    });
  }));

router.patch('/:id/non-billable', requirePermission('website-access.financial-link'), asyncHandler(async (req, res) => {
  const link = await websiteAccess.getLink(req.params.id);
  if (!link) throw httpError('Access link not found', 404, 'ACCESS_LINK_NOT_FOUND');
  if (link.financialStatus === 'LINKED_TO_SALE') {
    throw httpError('Cancel or unlink the sale before marking this access record non-billable', 409, 'ACCESS_LINK_ALREADY_LINKED');
  }
  await websiteAccess.setFinancialStatus(req, link.id, 'NON_BILLABLE');
  res.json(await websiteAccess.getLink(link.id));
}));

router.patch('/:id/reopen', requirePermission('website-access.financial-link'), asyncHandler(async (req, res) => {
  const link = await websiteAccess.getLink(req.params.id);
  if (!link) throw httpError('Access link not found', 404, 'ACCESS_LINK_NOT_FOUND');
  if (link.financialStatus === 'LINKED_TO_SALE') {
    throw httpError('This access record is already linked to a sale', 409, 'ACCESS_LINK_ALREADY_LINKED');
  }
  await websiteAccess.setFinancialStatus(req, link.id, 'NEEDS_FINANCIAL_DETAILS');
  res.json(await websiteAccess.getLink(link.id));
}));

module.exports = router;

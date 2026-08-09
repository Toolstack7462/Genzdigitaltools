'use strict';
const express = require('express');
const db = require('../db');
const money = require('../money');
const { asyncHandler } = require('../http');
const { requirePermission, has } = require('../permissions');
const router = express.Router();
function range(req) {
  const now = new Date(); const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from: String(req.query.from || first), to: String(req.query.to || last), currency: money.assertCurrency(req.query.currency || 'PKR') };
}
router.get('/summary', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  const { from, to, currency } = range(req); const profitVisible = has(req, 'profit.view'); const vendorVisible = has(req, 'vendors.view');
  const [saleRows, expenseRows, collectionRows, dailySales, dailyCollections, clients, products, categories] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(subtotal_sale),0) revenue,COALESCE(SUM(subtotal_cost),0) cost,COUNT(*) sale_count,
      COALESCE(AVG(subtotal_sale),0) average_invoice FROM biz_crm_sales WHERE deleted_at IS NULL AND status<>'cancelled'
      AND currency_code=:currency AND sale_date BETWEEN :from AND :to`, { currency, from, to }),
    db.query(`SELECT COALESCE(SUM(amount),0) expenses FROM biz_crm_expenses WHERE deleted_at IS NULL AND status='posted'
      AND currency_code=:currency AND expense_date BETWEEN :from AND :to`, { currency, from, to }),
    db.query(`SELECT party_type,COALESCE(SUM(amount),0) amount FROM biz_crm_payments WHERE currency_code=:currency AND payment_date BETWEEN :from AND :to GROUP BY party_type`, { currency, from, to }),
    db.query(`SELECT sale_date,COUNT(*) invoices,SUM(subtotal_sale) revenue,SUM(subtotal_cost) cost
      FROM biz_crm_sales WHERE deleted_at IS NULL AND status<>'cancelled' AND currency_code=:currency AND sale_date BETWEEN :from AND :to
      GROUP BY sale_date ORDER BY sale_date`, { currency, from, to }),
    db.query(`SELECT payment_date sale_date,
      COALESCE(SUM(CASE WHEN party_type='client' THEN amount ELSE 0 END),0) received,
      COALESCE(SUM(CASE WHEN party_type='vendor' THEN amount ELSE 0 END),0) vendor_paid
      FROM biz_crm_payments WHERE currency_code=:currency AND payment_date BETWEEN :from AND :to
      GROUP BY payment_date ORDER BY payment_date`, { currency, from, to }),
    db.query(`SELECT c.id,c.name,COUNT(*) invoices,SUM(s.subtotal_sale) revenue,SUM(s.client_paid) received,SUM(s.subtotal_sale-s.client_paid) pending
      FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id WHERE s.deleted_at IS NULL AND s.status<>'cancelled'
      AND s.currency_code=:currency AND s.sale_date BETWEEN :from AND :to GROUP BY c.id,c.name ORDER BY revenue DESC LIMIT 15`, { currency, from, to }),
    db.query(`SELECT i.name,COUNT(*) units,SUM(i.sale_price) revenue,SUM(i.purchase_cost) cost
      FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id WHERE s.deleted_at IS NULL AND s.status<>'cancelled'
      AND s.currency_code=:currency AND s.sale_date BETWEEN :from AND :to GROUP BY i.name ORDER BY revenue DESC LIMIT 15`, { currency, from, to }),
    db.query(`SELECT category,COUNT(*) entries,SUM(amount) amount FROM biz_crm_expenses WHERE deleted_at IS NULL AND status='posted'
      AND currency_code=:currency AND expense_date BETWEEN :from AND :to GROUP BY category ORDER BY amount DESC`, { currency, from, to }),
  ]);
  const sale = saleRows[0] || {}; const expense = expenseRows[0] || {}; const collections = Object.fromEntries(collectionRows.map((r) => [r.party_type, money.normalize(r.amount)]));
  const summary = { revenue: money.normalize(sale.revenue), expenses: money.normalize(expense.expenses), saleCount: Number(sale.sale_count || 0), averageInvoice: money.normalize(sale.average_invoice), clientCollections: collections.client || '0.00', ...(vendorVisible ? { vendorPayments: collections.vendor || '0.00' } : {}) };
  if (profitVisible) { summary.cost = money.normalize(sale.cost); summary.grossProfit = money.subtract(sale.revenue, sale.cost); summary.netProfit = money.subtract(summary.grossProfit, expense.expenses); }
  const dailyMap = new Map();
  for (const row of dailySales) dailyMap.set(row.sale_date, { ...row, received: '0.00', vendor_paid: '0.00' });
  for (const row of dailyCollections) dailyMap.set(row.sale_date, { sale_date: row.sale_date, invoices: 0, revenue: '0.00', cost: '0.00', ...(dailyMap.get(row.sale_date) || {}), received: row.received, vendor_paid: row.vendor_paid });
  const daily = [...dailyMap.values()].sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)));
  res.json({ from, to, currency, summary,
    daily: daily.map((r) => ({ sale_date: r.sale_date, invoices: Number(r.invoices || 0), revenue: money.normalize(r.revenue), received: money.normalize(r.received), ...(vendorVisible ? { vendor_paid: money.normalize(r.vendor_paid) } : {}), ...(profitVisible ? { cost: money.normalize(r.cost), profit: money.subtract(r.revenue, r.cost) } : {}) })),
    topClients: clients.map((r) => ({ ...r, revenue: money.normalize(r.revenue), received: money.normalize(r.received), pending: money.normalize(r.pending) })),
    topProducts: products.map((r) => ({ ...r, revenue: money.normalize(r.revenue), ...(profitVisible ? { cost: money.normalize(r.cost), profit: money.subtract(r.revenue, r.cost) } : {}) })),
    expenseCategories: categories.map((r) => ({ ...r, amount: money.normalize(r.amount) })),
  });
}));
router.get('/cashbook', requirePermission('cashbook.view'), asyncHandler(async (req, res) => {
  const { from, to, currency } = range(req);
  const rows = await db.query(`
    SELECT payment_date entry_date,CASE WHEN party_type='client' THEN 'client_receipt' ELSE 'vendor_payment' END entry_type,
      CASE WHEN party_type='client' THEN amount ELSE -amount END signed_amount,method,reference,notes,sale_id source_id,created_at
      FROM biz_crm_payments WHERE currency_code=:currency AND payment_date BETWEEN :from AND :to
    UNION ALL
    SELECT expense_date,'expense',-amount,method,reference,CONCAT(category,': ',description),id,created_at
      FROM biz_crm_expenses WHERE deleted_at IS NULL AND status='posted' AND currency_code=:currency AND expense_date BETWEEN :from AND :to
    ORDER BY entry_date DESC,created_at DESC`, { currency, from, to });
  const visibleRows = has(req, 'vendors.view') ? rows : rows.filter((row) => row.entry_type !== 'vendor_payment');
  let balance = 0n;
  const chronological = [...visibleRows].reverse().map((row) => { const signed = money.toMinor(row.signed_amount); balance += signed; return { ...row, signed_amount: money.fromMinor(signed), running_balance: money.fromMinor(balance) }; }).reverse();
  res.json({ from, to, currency, rows: chronological });
}));
router.get('/expiries', requirePermission('expiries.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from || new Date().toISOString().slice(0, 10));
  const days = Math.max(0, Math.min(365, Number(req.query.days || 30)));
  const rows = await db.query(`SELECT i.id,i.name,i.account_type,i.duration_label,i.expiry_date,s.id sale_id,s.invoice_number,s.currency_code,
    c.id client_id,c.name client_name,c.whatsapp,c.email,DATEDIFF(i.expiry_date,:fromDate) days_remaining
    FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id JOIN biz_crm_clients c ON c.id=s.client_id
    WHERE s.deleted_at IS NULL AND s.status<>'cancelled' AND i.expiry_date BETWEEN :fromDate AND DATE_ADD(:fromDate,INTERVAL :days DAY)
    ORDER BY i.expiry_date,c.name`, { fromDate: from, days });
  res.json({ from, days, rows });
}));
module.exports = router;

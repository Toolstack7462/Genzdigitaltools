'use strict';
const express = require('express');
const db = require('../db');
const money = require('../money');
const { asyncHandler } = require('../http');
const { requirePermission, has } = require('../permissions');
const router = express.Router();

router.get('/', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const settingsRows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1');
  const settings = settingsRows[0] || { default_currency: 'PKR' };
  const currency = money.assertCurrency(req.query.currency || settings.default_currency || 'PKR');
  const today = String(req.query.date || new Date().toISOString().slice(0, 10));
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : today.slice(0, 7);
  // Half-open DATE bounds for `month`, used instead of DATE_FORMAT(col,'%Y-%m')=:month.
  //
  // WHY: comparing a formatted string to a bound parameter made BOTH operands COERCIBLE with
  // DIFFERENT collations. The '%Y-%m' literal inside DATE_FORMAT is tagged with the client
  // character set's default collation (utf8mb4_general_ci), while the bound parameter is coerced to
  // the session/database collation (utf8mb4_unicode_ci). Neither operand outranks the other, so
  // MariaDB refused with "Illegal mix of collations (utf8mb4_unicode_ci,COERCIBLE) and
  // (utf8mb4_general_ci,COERCIBLE) for operation '='" and every dashboard request 500'd.
  // `currency_code=:currency` survives only because a COLUMN outranks a literal.
  // Reproduced and the fix confirmed by executing both forms through this driver against the
  // production database: the DATE_FORMAT form fails, the range form returns rows.
  //
  // Comparing DATE columns against DATE-shaped parameters involves no collation at all, and the
  // range is sargable so it can use the existing sale_date / payment_date / expense_date indexes.
  const monthStart = `${month}-01`;
  const nextMonthStart = (() => {
    const [year, monthNumber] = month.split('-').map(Number);
    return new Date(Date.UTC(monthNumber === 12 ? year + 1 : year, monthNumber === 12 ? 0 : monthNumber, 1))
      .toISOString().slice(0, 10);
  })();
  const profitVisible = has(req, 'profit.view');
  const vendorVisible = has(req, 'vendors.view');
  const expenseVisible = has(req, 'expenses.view');
  const auditVisible = has(req, 'audit.view');
  const [summaryRows, monthRows, pendingRows, taskRows, recentSales, topProducts, activities, todayPayments, monthPayments, expensesRows] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(subtotal_sale),0) sales,COALESCE(SUM(subtotal_cost),0) cost,COUNT(*) sale_count FROM biz_crm_sales
      WHERE deleted_at IS NULL AND status<>'cancelled' AND currency_code=:currency AND sale_date=:today`, { currency, today }),
    db.query(`SELECT COALESCE(SUM(subtotal_sale),0) sales,COALESCE(SUM(subtotal_cost),0) cost,COUNT(*) sale_count FROM biz_crm_sales
      WHERE deleted_at IS NULL AND status<>'cancelled' AND currency_code=:currency AND sale_date >= :monthStart AND sale_date < :nextMonthStart`, { currency, monthStart, nextMonthStart }),
    db.query(`SELECT COALESCE(SUM(subtotal_sale-client_paid),0) client_pending,COALESCE(SUM(subtotal_cost-vendor_paid),0) vendor_due
      FROM biz_crm_sales WHERE deleted_at IS NULL AND status<>'cancelled' AND currency_code=:currency`, { currency }),
    db.query(`SELECT COUNT(*) open_tasks,SUM(CASE WHEN due_at<NOW() AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) overdue_tasks
      FROM biz_crm_tasks WHERE deleted_at IS NULL AND status NOT IN ('completed','cancelled') AND (assigned_user_id IS NULL OR assigned_user_id=:actor)`, { actor: String(req.userId) }),
    db.query(`SELECT s.id,s.invoice_number,s.sale_date,s.currency_code,s.subtotal_sale,s.client_paid,c.name client_name
      FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id WHERE s.deleted_at IS NULL AND s.status<>'cancelled' AND s.currency_code=:currency
      ORDER BY s.created_at DESC LIMIT 8`, { currency }),
    db.query(`SELECT i.name,COUNT(*) units,SUM(i.sale_price) revenue,SUM(i.sale_price-i.purchase_cost) profit
      FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id
      WHERE s.deleted_at IS NULL AND s.status<>'cancelled' AND s.currency_code=:currency AND s.sale_date >= :monthStart AND s.sale_date < :nextMonthStart
      GROUP BY i.name ORDER BY revenue DESC LIMIT 8`, { currency, monthStart, nextMonthStart }),
    db.query(`SELECT action_key,entity_type,entity_id,actor_user_id,created_at FROM biz_crm_audit_logs ORDER BY created_at DESC LIMIT 10`),
    db.query(`SELECT party_type,COALESCE(SUM(amount),0) amount FROM biz_crm_payments
      WHERE currency_code=:currency AND payment_date=:today GROUP BY party_type`, { currency, today }),
    db.query(`SELECT party_type,COALESCE(SUM(amount),0) amount FROM biz_crm_payments
      WHERE currency_code=:currency AND payment_date >= :monthStart AND payment_date < :nextMonthStart GROUP BY party_type`, { currency, monthStart, nextMonthStart }),
    db.query(`SELECT COALESCE(SUM(amount),0) expenses FROM biz_crm_expenses
      WHERE deleted_at IS NULL AND status='posted' AND currency_code=:currency AND expense_date >= :monthStart AND expense_date < :nextMonthStart`, { currency, monthStart, nextMonthStart }),
  ]);
  const todaySummary = summaryRows[0] || {};
  const monthSummary = monthRows[0] || {};
  const pending = pendingRows[0] || {};
  const todayCollections = Object.fromEntries(todayPayments.map((row) => [row.party_type, money.normalize(row.amount)]));
  const monthCollections = Object.fromEntries(monthPayments.map((row) => [row.party_type, money.normalize(row.amount)]));
  const response = {
    currency, today, month, settings,
    today: { sales: money.normalize(todaySummary.sales), received: todayCollections.client || '0.00', saleCount: Number(todaySummary.sale_count || 0), ...(vendorVisible ? { vendorPaid: todayCollections.vendor || '0.00' } : {}) },
    monthSummary: { sales: money.normalize(monthSummary.sales), received: monthCollections.client || '0.00', saleCount: Number(monthSummary.sale_count || 0), ...(vendorVisible ? { vendorPaid: monthCollections.vendor || '0.00' } : {}), ...(expenseVisible ? { expenses: money.normalize(expensesRows[0]?.expenses) } : {}) },
    outstanding: { clientPending: money.normalize(pending.client_pending), ...(vendorVisible ? { vendorDue: money.normalize(pending.vendor_due) } : {}) },
    tasks: { open: Number(taskRows[0]?.open_tasks || 0), overdue: Number(taskRows[0]?.overdue_tasks || 0) },
    recentSales: recentSales.map((row) => ({ ...row, subtotal_sale: money.normalize(row.subtotal_sale), client_paid: money.normalize(row.client_paid) })),
    topProducts: topProducts.map((row) => ({ ...row, revenue: money.normalize(row.revenue), ...(profitVisible ? { profit: money.normalize(row.profit) } : {}) })),
    activities: auditVisible ? activities : [],
  };
  if (profitVisible) {
    response.today.grossProfit = money.subtract(todaySummary.sales, todaySummary.cost);
    response.monthSummary.grossProfit = money.subtract(monthSummary.sales, monthSummary.cost);
    if (expenseVisible) response.monthSummary.netProfit = money.subtract(response.monthSummary.grossProfit, response.monthSummary.expenses);
  }
  res.json(response);
}));
module.exports = router;

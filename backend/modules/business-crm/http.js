'use strict';

function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function pageParams(query) {
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const pageSize = Math.max(1, Math.min(500, Number(query.pageSize) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function safeLike(value) { return `%${String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`).slice(0, 180)}%`; }
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/[^a-zA-Z0-9_.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${csv}`);
}
module.exports = { asyncHandler, pageParams, safeLike, sendCsv };

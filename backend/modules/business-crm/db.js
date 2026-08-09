'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

let pool = null;
let schemaPromise = null;

function databaseConfig() {
  const raw = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!raw) throw new Error('DATABASE_URL or MYSQL_URL is required for Business CRM');
  const url = new URL(raw);
  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    waitForConnections: true,
    connectionLimit: Math.max(2, Math.min(30, Number(process.env.BUSINESS_CRM_DB_POOL_SIZE || 6))),
    maxIdle: Math.max(1, Number(process.env.BUSINESS_CRM_DB_MAX_IDLE || 4)),
    idleTimeout: 60000,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: false,
    namedPlaceholders: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
  if (String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' || url.searchParams.get('ssl') === 'true') {
    config.ssl = { rejectUnauthorized: String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || 'true') !== 'false' };
  }
  return config;
}

function getPool() {
  if (!pool) pool = mysql.createPool(databaseConfig());
  return pool;
}

async function query(sql, params = {}) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function withTransaction(work, options = {}) {
  const connection = await getPool().getConnection();
  try {
    const isolation = String(options.isolation || 'READ COMMITTED').toUpperCase();
    if (!['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation)) throw new Error('Unsupported transaction isolation level');
    await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* preserve original error */ }
    throw error;
  } finally {
    connection.release();
  }
}

function splitSql(source) {
  return source
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column LIMIT 1`,
    { table, column },
  );
  return rows.length > 0;
}

async function ensureCompatibilityColumns(connection) {
  const columns = [
    ['biz_crm_products', 'category', "ALTER TABLE biz_crm_products ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'Software' AFTER name"],
    ['biz_crm_settings', 'include_credentials_in_invoice', 'ALTER TABLE biz_crm_settings ADD COLUMN include_credentials_in_invoice TINYINT(1) NOT NULL DEFAULT 0 AFTER logo_url'],
    ['biz_crm_settings', 'include_credentials_in_messages', 'ALTER TABLE biz_crm_settings ADD COLUMN include_credentials_in_messages TINYINT(1) NOT NULL DEFAULT 0 AFTER include_credentials_in_invoice'],
    ['biz_crm_clients', 'idempotency_key', 'ALTER TABLE biz_crm_clients ADD COLUMN idempotency_key VARCHAR(128) NULL UNIQUE AFTER status'],
    ['biz_crm_vendors', 'idempotency_key', 'ALTER TABLE biz_crm_vendors ADD COLUMN idempotency_key VARCHAR(128) NULL UNIQUE AFTER status'],
    ['biz_crm_sales', 'idempotency_key', 'ALTER TABLE biz_crm_sales ADD COLUMN idempotency_key VARCHAR(128) NULL UNIQUE AFTER invoice_instructions'],
    // ── Website access → CRM bridge ──────────────────────────────────────────
    // A CRM client may mirror an existing website user. This is a nullable REFERENCE only:
    // the website `users` row is read for display and never written from the CRM.
    ['biz_crm_clients', 'website_user_id', 'ALTER TABLE biz_crm_clients ADD COLUMN website_user_id VARCHAR(64) NULL AFTER status'],
    // Marks which sale items originated from website access rather than manual entry. Existing
    // rows take the MANUAL default, so no backfill is needed and manual sales are unaffected.
    ['biz_crm_sale_items', 'access_source', "ALTER TABLE biz_crm_sale_items ADD COLUMN access_source VARCHAR(24) NOT NULL DEFAULT 'MANUAL' AFTER account_type"],
    ['biz_crm_sale_items', 'access_external_key', 'ALTER TABLE biz_crm_sale_items ADD COLUMN access_external_key VARCHAR(190) NULL AFTER access_source'],
  ];
  for (const [table, column, statement] of columns) {
    if (!(await columnExists(connection, table, column))) await connection.query(statement);
  }
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const source = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const connection = await getPool().getConnection();
      try {
        for (const statement of splitSql(source)) await connection.query(statement);
        await ensureCompatibilityColumns(connection);
        return { version: '2.0.0' };
      } finally {
        connection.release();
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  schemaPromise = null;
}

module.exports = { getPool, query, withTransaction, ensureSchema, close, splitSql, databaseConfig };

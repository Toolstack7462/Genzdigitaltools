-- Gen Z Digital Store Business CRM — normalized MySQL/MariaDB schema
-- Module version: 2.0.0
-- Every table is namespaced with biz_crm_ so existing application data remains untouched.

CREATE TABLE IF NOT EXISTS biz_crm_schema_migrations (
  version VARCHAR(32) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  store_name VARCHAR(160) NOT NULL DEFAULT 'Gen Z Digital Store',
  store_email VARCHAR(190) NULL,
  store_phone VARCHAR(40) NULL,
  store_address TEXT NULL,
  invoice_prefix VARCHAR(16) NOT NULL DEFAULT 'GDS',
  default_currency CHAR(3) NOT NULL DEFAULT 'PKR',
  whatsapp_country_code VARCHAR(8) NOT NULL DEFAULT '92',
  invoice_terms TEXT NULL,
  logo_url VARCHAR(500) NULL,
  include_credentials_in_invoice TINYINT(1) NOT NULL DEFAULT 0,
  include_credentials_in_messages TINYINT(1) NOT NULL DEFAULT 0,
  updated_by VARCHAR(64) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_clients (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  whatsapp VARCHAR(40) NULL,
  email VARCHAR(190) NULL,
  company VARCHAR(190) NULL,
  address TEXT NULL,
  tax_id VARCHAR(80) NULL,
  notes TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  idempotency_key VARCHAR(128) NULL UNIQUE,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  INDEX idx_biz_clients_name (name),
  INDEX idx_biz_clients_whatsapp (whatsapp),
  INDEX idx_biz_clients_email (email),
  INDEX idx_biz_clients_status (status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_vendors (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  whatsapp VARCHAR(40) NULL,
  email VARCHAR(190) NULL,
  company VARCHAR(190) NULL,
  address TEXT NULL,
  tax_id VARCHAR(80) NULL,
  notes TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  idempotency_key VARCHAR(128) NULL UNIQUE,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  INDEX idx_biz_vendors_name (name),
  INDEX idx_biz_vendors_whatsapp (whatsapp),
  INDEX idx_biz_vendors_email (email),
  INDEX idx_biz_vendors_status (status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_products (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Software',
  account_type VARCHAR(32) NOT NULL DEFAULT 'private',
  duration_label VARCHAR(80) NULL,
  default_sale_price DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  default_purchase_cost DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  currency_code CHAR(3) NOT NULL DEFAULT 'PKR',
  active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  INDEX idx_biz_products_name (name),
  INDEX idx_biz_products_category (category),
  INDEX idx_biz_products_active (active, deleted_at),
  INDEX idx_biz_products_currency (currency_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_invoice_sequences (
  sequence_year SMALLINT UNSIGNED PRIMARY KEY,
  next_value INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_sales (
  id CHAR(36) PRIMARY KEY,
  invoice_number VARCHAR(64) NOT NULL UNIQUE,
  client_id CHAR(36) NOT NULL,
  vendor_id CHAR(36) NULL,
  sale_date DATE NOT NULL,
  order_type VARCHAR(20) NOT NULL DEFAULT 'new',
  currency_code CHAR(3) NOT NULL DEFAULT 'PKR',
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  subtotal_sale DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  subtotal_cost DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  client_paid DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  vendor_paid DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  notes TEXT NULL,
  invoice_instructions TEXT NULL,
  idempotency_key VARCHAR(128) NULL UNIQUE,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  CONSTRAINT fk_biz_sales_client FOREIGN KEY (client_id) REFERENCES biz_crm_clients(id),
  CONSTRAINT fk_biz_sales_vendor FOREIGN KEY (vendor_id) REFERENCES biz_crm_vendors(id),
  INDEX idx_biz_sales_date (sale_date),
  INDEX idx_biz_sales_client (client_id, deleted_at),
  INDEX idx_biz_sales_vendor (vendor_id, deleted_at),
  INDEX idx_biz_sales_currency (currency_code, sale_date),
  INDEX idx_biz_sales_status (status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_sale_items (
  id CHAR(36) PRIMARY KEY,
  sale_id CHAR(36) NOT NULL,
  product_id CHAR(36) NULL,
  name VARCHAR(190) NOT NULL,
  account_type VARCHAR(32) NOT NULL DEFAULT 'private',
  duration_label VARCHAR(80) NULL,
  purchase_date DATE NULL,
  expiry_date DATE NULL,
  credential_email_ciphertext TEXT NULL,
  credential_password_ciphertext TEXT NULL,
  sale_price DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  purchase_cost DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_biz_items_sale FOREIGN KEY (sale_id) REFERENCES biz_crm_sales(id) ON DELETE CASCADE,
  CONSTRAINT fk_biz_items_product FOREIGN KEY (product_id) REFERENCES biz_crm_products(id),
  INDEX idx_biz_items_sale (sale_id, sort_order),
  INDEX idx_biz_items_expiry (expiry_date),
  INDEX idx_biz_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_payments (
  id CHAR(36) PRIMARY KEY,
  sale_id CHAR(36) NOT NULL,
  party_type VARCHAR(16) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  payment_date DATE NOT NULL,
  method VARCHAR(40) NULL,
  reference VARCHAR(190) NULL,
  notes TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  reverses_payment_id CHAR(36) NULL,
  idempotency_key VARCHAR(128) NULL UNIQUE,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_by VARCHAR(64) NULL,
  reversed_at TIMESTAMP NULL,
  CONSTRAINT fk_biz_payments_sale FOREIGN KEY (sale_id) REFERENCES biz_crm_sales(id),
  CONSTRAINT fk_biz_payments_reversal FOREIGN KEY (reverses_payment_id) REFERENCES biz_crm_payments(id),
  INDEX idx_biz_payments_sale (sale_id, party_type),
  INDEX idx_biz_payments_date (payment_date),
  INDEX idx_biz_payments_currency (currency_code, payment_date),
  INDEX idx_biz_payments_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_expenses (
  id CHAR(36) PRIMARY KEY,
  expense_date DATE NOT NULL,
  category VARCHAR(80) NOT NULL,
  description VARCHAR(255) NOT NULL,
  payee VARCHAR(190) NULL,
  amount DECIMAL(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'PKR',
  method VARCHAR(40) NULL,
  reference VARCHAR(190) NULL,
  notes TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  idempotency_key VARCHAR(128) NULL UNIQUE,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  INDEX idx_biz_expenses_date (expense_date),
  INDEX idx_biz_expenses_currency (currency_code, expense_date),
  INDEX idx_biz_expenses_category (category),
  INDEX idx_biz_expenses_status (status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_tasks (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(220) NOT NULL,
  description TEXT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  due_at DATETIME NULL,
  assigned_user_id VARCHAR(64) NULL,
  client_id CHAR(36) NULL,
  vendor_id CHAR(36) NULL,
  sale_id CHAR(36) NULL,
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  CONSTRAINT fk_biz_tasks_client FOREIGN KEY (client_id) REFERENCES biz_crm_clients(id),
  CONSTRAINT fk_biz_tasks_vendor FOREIGN KEY (vendor_id) REFERENCES biz_crm_vendors(id),
  CONSTRAINT fk_biz_tasks_sale FOREIGN KEY (sale_id) REFERENCES biz_crm_sales(id),
  INDEX idx_biz_tasks_assignee (assigned_user_id, status),
  INDEX idx_biz_tasks_due (due_at, status),
  INDEX idx_biz_tasks_links (client_id, vendor_id, sale_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_activities (
  id CHAR(36) PRIMARY KEY,
  entity_type VARCHAR(24) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  activity_type VARCHAR(24) NOT NULL,
  subject VARCHAR(220) NULL,
  body TEXT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_biz_activities_entity (entity_type, entity_id, created_at),
  INDEX idx_biz_activities_actor (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_reminders (
  id CHAR(36) PRIMARY KEY,
  reminder_type VARCHAR(32) NOT NULL,
  entity_type VARCHAR(24) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  recipient VARCHAR(80) NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  message_text TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'prepared',
  prepared_by VARCHAR(64) NOT NULL,
  prepared_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_at TIMESTAMP NULL,
  INDEX idx_biz_reminders_entity (entity_type, entity_id),
  INDEX idx_biz_reminders_date (prepared_at),
  INDEX idx_biz_reminders_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_saved_views (
  id CHAR(36) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  module_name VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  filters_json LONGTEXT NOT NULL,
  shared TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_biz_saved_view (user_id, module_name, name),
  INDEX idx_biz_saved_views_module (module_name, shared)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_user_access (
  user_id VARCHAR(64) PRIMARY KEY,
  business_role VARCHAR(24) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_user_permissions (
  user_id VARCHAR(64) NOT NULL,
  permission_key VARCHAR(80) NOT NULL,
  effect VARCHAR(8) NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, permission_key),
  INDEX idx_biz_user_permissions_effect (effect)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_audit_logs (
  id CHAR(36) PRIMARY KEY,
  actor_user_id VARCHAR(64) NOT NULL,
  actor_role VARCHAR(32) NULL,
  action_key VARCHAR(80) NOT NULL,
  entity_type VARCHAR(32) NULL,
  entity_id VARCHAR(64) NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  request_id VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_biz_audit_actor (actor_user_id, created_at),
  INDEX idx_biz_audit_entity (entity_type, entity_id, created_at),
  INDEX idx_biz_audit_action (action_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_sync_operations (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  device_id VARCHAR(100) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  operation_type VARCHAR(40) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing',
  result_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_biz_sync_user (user_id, created_at),
  INDEX idx_biz_sync_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_legacy_map (
  source_system VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  legacy_id VARCHAR(128) NOT NULL,
  new_id VARCHAR(64) NOT NULL,
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_system, entity_type, legacy_id),
  INDEX idx_biz_legacy_new_id (entity_type, new_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_crm_import_runs (
  id CHAR(36) PRIMARY KEY,
  entity_type VARCHAR(32) NOT NULL,
  original_filename VARCHAR(255) NULL,
  total_rows INT UNSIGNED NOT NULL DEFAULT 0,
  imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
  rejected_rows INT UNSIGNED NOT NULL DEFAULT 0,
  errors_json LONGTEXT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_biz_import_runs_date (created_at),
  INDEX idx_biz_import_runs_entity (entity_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Website access → CRM reconciliation index ────────────────────────────────
-- One row per external website access record (core tool assignment, proxy lease or
-- StealthWriter lease), keyed by a stable external_key so reconciliation is idempotent.
-- This table is a CRM-owned MIRROR: the website assignment remains the operational source
-- of truth and is never written from here; the row only carries financial linkage plus the
-- last-seen snapshot. Deliberately no foreign keys — reconciliation (and financial history)
-- must survive a referenced sale item or client row disappearing, and a vanished website
-- record is recorded as SOURCE_MISSING rather than deleted.
CREATE TABLE IF NOT EXISTS biz_crm_access_links (
  id CHAR(36) PRIMARY KEY,
  external_key VARCHAR(190) NOT NULL,
  source_type VARCHAR(24) NOT NULL,
  website_user_id VARCHAR(64) NULL,
  website_tool_id VARCHAR(64) NULL,
  website_assignment_id VARCHAR(64) NULL,
  crm_client_id CHAR(36) NULL,
  crm_sale_id CHAR(36) NULL,
  crm_sale_item_id CHAR(36) NULL,
  client_name VARCHAR(190) NULL,
  client_email VARCHAR(190) NULL,
  client_phone VARCHAR(64) NULL,
  client_link_state VARCHAR(24) NOT NULL DEFAULT 'UNLINKED',
  tool_name VARCHAR(190) NOT NULL,
  tool_category VARCHAR(100) NULL,
  access_mode VARCHAR(24) NULL,
  start_date DATE NULL,
  expiry_date DATE NULL,
  duration_days INT NULL,
  access_status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  financial_status VARCHAR(32) NOT NULL DEFAULT 'NEEDS_FINANCIAL_DETAILS',
  source_snapshot_json LONGTEXT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NULL,
  source_missing_at TIMESTAMP NULL,
  ignored_at TIMESTAMP NULL,
  ignored_by VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_biz_access_links_external (external_key),
  INDEX idx_biz_access_links_user (website_user_id),
  INDEX idx_biz_access_links_assignment (website_assignment_id),
  INDEX idx_biz_access_links_client (crm_client_id),
  INDEX idx_biz_access_links_financial (financial_status),
  INDEX idx_biz_access_links_access (access_status),
  INDEX idx_biz_access_links_expiry (expiry_date),
  INDEX idx_biz_access_links_source (source_type, access_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO biz_crm_settings (id, store_name, invoice_prefix, default_currency, whatsapp_country_code)
VALUES (1, 'Gen Z Digital Store', 'GDS', 'PKR', '92')
ON DUPLICATE KEY UPDATE id = id;

INSERT INTO biz_crm_schema_migrations (version)
VALUES ('2.0.0')
ON DUPLICATE KEY UPDATE version = version;

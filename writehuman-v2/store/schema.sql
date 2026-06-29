-- WriteHuman V2 — single-account vault store (SQLite).
-- Holds exactly ONE account (the operator's 24/7 WriteHuman account). Fully isolated from
-- the production MySQL ProxyAccount table. The cookie bundle is stored ENCRYPTED
-- (session_encrypted, AES-256-GCM via lib/vaultCrypto) and is never logged.

CREATE TABLE IF NOT EXISTS account (
  id                TEXT PRIMARY KEY,         -- fixed: 'wh-v2-primary'
  label             TEXT NOT NULL DEFAULT 'WriteHuman V2',
  status            TEXT NOT NULL DEFAULT 'pending',   -- active | session_expired | blocked | pending
  session_status    TEXT NOT NULL DEFAULT 'pending_verification',
  session_encrypted TEXT,                     -- AES-256-GCM blob ("v1:...") of the cookie bundle
  session_meta      TEXT,                     -- JSON: { cookieCount, hasSessionCookie, origin, updatedAt }
  verification      TEXT,                     -- JSON: { result, maskedId, httpStatus, checkedAt }
  cookie_hash       TEXT,                     -- hash of the AUTH cookies only (Step-2 change detection)
  last_verified_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

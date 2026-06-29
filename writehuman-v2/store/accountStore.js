'use strict';
/**
 * WriteHuman V2 — single-account vault store.
 *
 * Persists exactly ONE account (the operator's 24/7 WriteHuman account): its encrypted
 * cookie bundle, status/session_status, last verification, lastVerifiedAt, and a
 * `cookieHash` (present now; written when Step-2 change detection is wired). Fully
 * isolated from the production MySQL — own data, own vault key.
 *
 * Backend: SQLite when `better-sqlite3` is installed (config.storeDriver auto|sqlite),
 * else an atomic JSON file under store/data/account.json (zero-dependency default). Both
 * expose the same getRaw()/putRaw() primitive; the encrypt/decrypt + field logic sits on
 * top so the two backends behave identically.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../lib/config');
const vaultCrypto = require('../lib/vaultCrypto');
const cookies = require('../lib/cookies');

const ACCOUNT_ID = 'wh-v2-primary';
// Data dir is overridable (WRITEHUMAN_V2_DATA_DIR) so tests can use an isolated temp dir.
const DATA_DIR = process.env.WRITEHUMAN_V2_DATA_DIR
  ? path.resolve(process.env.WRITEHUMAN_V2_DATA_DIR)
  : path.join(__dirname, 'data');
const JSON_FILE = path.join(DATA_DIR, 'account.json');

let backend = null; // { getRaw(): obj|null, putRaw(obj): void }

// ── JSON-file backend (atomic write) ─────────────────────────────────────────
function jsonBackend() {
  function getRaw() {
    try { return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); } catch (_) { return null; }
  }
  function putRaw(obj) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
    const tmp = JSON_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, JSON_FILE); // atomic replace on the same filesystem
  }
  return { kind: 'json', getRaw, putRaw };
}

// ── SQLite backend (optional, only if better-sqlite3 is available) ────────────
function sqliteBackend() {
  let Database;
  try { Database = require('better-sqlite3'); } catch (_) { return null; }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  const db = new Database(path.join(DATA_DIR, 'account.db'));
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  const sel = db.prepare('SELECT * FROM account WHERE id = ?');
  const ins = db.prepare(`INSERT INTO account
    (id,label,status,session_status,session_encrypted,session_meta,verification,cookie_hash,last_verified_at,created_at,updated_at)
    VALUES (@id,@label,@status,@session_status,@session_encrypted,@session_meta,@verification,@cookie_hash,@last_verified_at,@created_at,@updated_at)
    ON CONFLICT(id) DO UPDATE SET
      label=@label,status=@status,session_status=@session_status,session_encrypted=@session_encrypted,
      session_meta=@session_meta,verification=@verification,cookie_hash=@cookie_hash,
      last_verified_at=@last_verified_at,updated_at=@updated_at`);
  function getRaw() {
    const row = sel.get(ACCOUNT_ID);
    if (!row) return null;
    return {
      id: row.id, label: row.label, status: row.status, session_status: row.session_status,
      sessionEncrypted: row.session_encrypted || null,
      sessionMeta: row.session_meta ? safeParse(row.session_meta) : null,
      verification: row.verification ? safeParse(row.verification) : null,
      cookieHash: row.cookie_hash || null,
      lastVerifiedAt: row.last_verified_at || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  function putRaw(o) {
    ins.run({
      id: o.id, label: o.label, status: o.status, session_status: o.session_status,
      session_encrypted: o.sessionEncrypted || null,
      session_meta: o.sessionMeta ? JSON.stringify(o.sessionMeta) : null,
      verification: o.verification ? JSON.stringify(o.verification) : null,
      cookie_hash: o.cookieHash || null,
      last_verified_at: o.lastVerifiedAt || null,
      created_at: o.createdAt, updated_at: o.updatedAt,
    });
  }
  return { kind: 'sqlite', getRaw, putRaw };
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function nowIso() { return new Date().toISOString(); }

function init() {
  if (backend) return backend.kind;
  if (config.storeDriver === 'json') backend = jsonBackend();
  else if (config.storeDriver === 'sqlite') backend = sqliteBackend() || jsonBackend();
  else backend = sqliteBackend() || jsonBackend(); // auto
  // Ensure the single account row exists.
  if (!backend.getRaw()) {
    const t = nowIso();
    backend.putRaw({
      id: ACCOUNT_ID, label: 'WriteHuman V2', status: 'pending', session_status: 'pending_verification',
      sessionEncrypted: null, sessionMeta: null, verification: null, cookieHash: null,
      lastVerifiedAt: null, createdAt: t, updatedAt: t,
    });
  }
  return backend.kind;
}

function get() { if (!backend) init(); return backend.getRaw(); }

function update(patch) {
  if (!backend) init();
  const cur = backend.getRaw() || {};
  const next = Object.assign({}, cur, patch, { id: ACCOUNT_ID, updatedAt: nowIso() });
  if (!next.createdAt) next.createdAt = nowIso();
  backend.putRaw(next);
  return next;
}

// Decrypt and return the stored cookie bundle, or null if absent/corrupt.
function getDecryptedBundle() {
  const a = get();
  if (!a || !a.sessionEncrypted) return null;
  try { return JSON.parse(vaultCrypto.decrypt(a.sessionEncrypted)); } catch (_) { return null; }
}

// Store a (normalized) cookie bundle encrypted at rest + refresh sessionMeta.
function setBundle(bundle) {
  const targetHost = (() => { try { return new URL(config.targetOrigin).hostname; } catch (_) { return ''; } })();
  const cookieCount = cookies.countCookies(bundle, targetHost);
  return update({
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(bundle)),
    sessionMeta: { cookieCount, hasSessionCookie: cookieCount > 0, origin: config.targetOrigin, updatedAt: nowIso() },
  });
}

function setStatus(status, sessionStatus) {
  const patch = {};
  if (status) patch.status = status;
  if (sessionStatus) patch.session_status = sessionStatus;
  return update(patch);
}

function setVerification(v) {
  return update({
    verification: { result: v.result, maskedId: v.maskedId || (get().verification || {}).maskedId || null, httpStatus: v.httpStatus || 0, checkedAt: nowIso() },
    lastVerifiedAt: nowIso(),
  });
}

function setCookieHash(hash) { return update({ cookieHash: hash || null }); }

module.exports = {
  ACCOUNT_ID, init, get, update, getDecryptedBundle, setBundle, setStatus, setVerification, setCookieHash,
  driver: () => (backend ? backend.kind : null),
};

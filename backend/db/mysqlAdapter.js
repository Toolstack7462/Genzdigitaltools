'use strict';

/**
 * MySQL/MariaDB JSON-record adapter
 *
 * This adapter keeps the existing Mongoose-style route code working while moving
 * persistence to MySQL/MariaDB. It stores each collection in its own MySQL table
 * with an id + JSON payload. This is intentionally conservative: it preserves
 * API behaviour first, then allows future normalization into fully relational
 * tables without breaking the admin/client/extension flows.
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let pool = null;
let connectionInfo = null;

const tableNames = {
  User: 'users',
  Tool: 'tools',
  ToolAssignment: 'tool_assignments',
  DeviceBinding: 'device_bindings',
  RefreshToken: 'refresh_tokens',
  ExtensionToken: 'extension_tokens',
  ActivityLog: 'activity_logs',
  CredentialAccessLog: 'credential_access_logs',
  Blog: 'blogs',
  Contact: 'contacts',
  ExpiryDismissal: 'expiry_dismissals',
  NotificationState: 'notification_states',
  SecurityAlert: 'security_alerts',
  OpenIntent: 'open_intents',
  ActivationToken: 'activation_tokens',
  ExtensionScan: 'extension_scans',
  DeviceProfile: 'device_profiles',
};

const populateModelByPath = {
  author: 'User',
  createdBy: 'User',
  clientId: 'User',
  userId: 'User',
  actorId: 'User',
  repliedBy: 'User',
  reviewedBy: 'User',
  toolId: 'Tool',
  'context.toolId': 'Tool',
  extensionTokenId: 'ExtensionToken',
  assignmentId: 'ToolAssignment',
};

const registry = {};

function sanitizeUrl(url) {
  return String(url || '').replace(/:\/\/([^:]+):([^@]+)@/, '://<credentials>@');
}

function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = (url.pathname || '').replace(/^\//, '');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

async function connect() {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for MySQL/MariaDB mode. Example: mysql://user:pass@localhost:3306/genz_digital_tools');
  }

  const parsed = parseDatabaseUrl(databaseUrl);
  connectionInfo = parsed;
  pool = mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    timezone: 'Z',
    charset: 'utf8mb4',
    multipleStatements: false,
  });

  await pool.query('SELECT 1');
  await ensureTables();
  return { ...parsed, password: '<hidden>' };
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

function getStatus() {
  return {
    connected: !!pool,
    host: connectionInfo?.host || 'N/A',
    database: connectionInfo?.database || 'N/A',
  };
}

function assertPool() {
  if (!pool) throw new Error('MySQL connection is not initialized. Call mysqlAdapter.connect() during startup.');
  return pool;
}

async function ensureTables() {
  const db = assertPool();
  for (const table of Object.values(tableNames)) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS \`${table}\` (
        id VARCHAR(32) NOT NULL PRIMARY KEY,
        data LONGTEXT NOT NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        INDEX idx_${table}_createdAt (createdAt),
        INDEX idx_${table}_updatedAt (updatedAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

function newId() {
  // Mongo ObjectId-compatible length, without depending on MongoDB.
  return crypto.randomBytes(12).toString('hex');
}

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isIsoDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function hydrateDates(value, key = '') {
  if (Array.isArray(value)) return value.map(v => hydrateDates(v, key));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) value[k] = hydrateDates(v, k);
    return value;
  }
  if (isIsoDateString(value) && /(At|Date|expires|published|dismissed|assigned|start|end|last|created|updated)/i.test(key)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}

function serializeData(data) {
  return JSON.stringify(data);
}

function deserializeData(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return hydrateDates(obj);
}

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetByPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (!cur) return;
  }
  delete cur[parts[parts.length - 1]];
}

function normalizeComparable(value) {
  if (value instanceof Date) return value.getTime();
  if (isIsoDateString(value)) return new Date(value).getTime();
  if (value && typeof value === 'object' && value._id) return String(value._id);
  return value;
}

function valuesEqual(a, b) {
  const aa = normalizeComparable(a);
  const bb = normalizeComparable(b);
  return String(aa) === String(bb);
}

function matchesOperator(fieldValue, operators) {
  for (const [op, expected] of Object.entries(operators || {})) {
    if (op === '$in') {
      const arr = Array.isArray(expected) ? expected : [];
      if (Array.isArray(fieldValue)) {
        if (!fieldValue.some(v => arr.some(e => valuesEqual(v, e)))) return false;
      } else if (!arr.some(e => valuesEqual(fieldValue, e))) return false;
    } else if (op === '$nin') {
      const arr = Array.isArray(expected) ? expected : [];
      if (Array.isArray(fieldValue)) {
        if (fieldValue.some(v => arr.some(e => valuesEqual(v, e)))) return false;
      } else if (arr.some(e => valuesEqual(fieldValue, e))) return false;
    } else if (op === '$ne') {
      if (valuesEqual(fieldValue, expected)) return false;
    } else if (op === '$exists') {
      const exists = fieldValue !== undefined && fieldValue !== null;
      if (Boolean(expected) !== exists) return false;
    } else if (op === '$gt') {
      if (!(normalizeComparable(fieldValue) > normalizeComparable(expected))) return false;
    } else if (op === '$gte') {
      if (!(normalizeComparable(fieldValue) >= normalizeComparable(expected))) return false;
    } else if (op === '$lt') {
      if (!(normalizeComparable(fieldValue) < normalizeComparable(expected))) return false;
    } else if (op === '$lte') {
      if (!(normalizeComparable(fieldValue) <= normalizeComparable(expected))) return false;
    } else if (op === '$regex') {
      const flags = operators.$options || 'i';
      const re = expected instanceof RegExp ? expected : new RegExp(String(expected), flags);
      if (!re.test(String(fieldValue || ''))) return false;
    } else if (op === '$options') {
      continue;
    } else {
      // Unknown operator: fail closed so accidental unsupported queries are visible.
      return false;
    }
  }
  return true;
}

function matchesQuery(obj, query = {}) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some(q => matchesQuery(obj, q))) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(expected) || !expected.every(q => matchesQuery(obj, q))) return false;
      continue;
    }

    const fieldValue = key === '_id' ? obj._id : getByPath(obj, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected) && !(expected instanceof RegExp)) {
      if (!matchesOperator(fieldValue, expected)) return false;
    } else if (expected instanceof RegExp) {
      if (!expected.test(String(fieldValue || ''))) return false;
    } else if (!valuesEqual(fieldValue, expected)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(data, update = {}) {
  const out = deepClone(data) || {};
  if (update.$set || update.$inc || update.$unset) {
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setByPath(out, k, v);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setByPath(out, k, Number(getByPath(out, k) || 0) + Number(v));
    if (update.$unset) for (const k of Object.keys(update.$unset)) unsetByPath(out, k);
  } else {
    for (const [k, v] of Object.entries(update)) setByPath(out, k, v);
  }
  return out;
}

function projectObject(obj, selectSpec) {
  if (!selectSpec) return obj;
  const fields = Array.isArray(selectSpec)
    ? selectSpec
    : String(selectSpec).split(/\s+/).filter(Boolean);
  if (fields.length === 0) return obj;

  const isExclusion = fields.some(f => f.startsWith('-'));
  const src = deepClone(obj);
  if (isExclusion) {
    for (const f of fields) {
      if (f.startsWith('-')) unsetByPath(src, f.slice(1));
    }
    return src;
  }
  const projected = { _id: src._id };
  for (const f of fields) {
    if (!f || f.startsWith('-')) continue;
    const val = getByPath(src, f);
    if (val !== undefined) setByPath(projected, f, val);
  }
  return projected;
}

function sortObjects(objects, sortSpec = {}) {
  if (!sortSpec || Object.keys(sortSpec).length === 0) return objects;
  let spec = sortSpec;
  if (typeof sortSpec === 'string') {
    spec = {};
    sortSpec.split(/\s+/).filter(Boolean).forEach(f => {
      spec[f.replace(/^-/, '')] = f.startsWith('-') ? -1 : 1;
    });
  }
  const entries = Object.entries(spec);
  return objects.sort((a, b) => {
    for (const [field, dirRaw] of entries) {
      const dir = String(dirRaw).toLowerCase() === 'desc' || Number(dirRaw) < 0 ? -1 : 1;
      const av = normalizeComparable(getByPath(a, field));
      const bv = normalizeComparable(getByPath(b, field));
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

class Document {
  constructor(model, data, meta = {}) {
    Object.defineProperty(this, '__model', { value: model, enumerable: false, writable: true });
    Object.defineProperty(this, '__populatedPaths', { value: {}, enumerable: false, writable: true });
    Object.defineProperty(this, '__originalData', { value: hydrateDates(deepClone(data || {})), enumerable: false, writable: true });
    Object.assign(this, hydrateDates(deepClone(data || {})));
    if (!this._id) this._id = newId();
    if (meta.populatedPaths) this.__populatedPaths = meta.populatedPaths;
  }

  async save() {
    let data = this.toObject({ includeSensitive: true });
    for (const [path, originalId] of Object.entries(this.__populatedPaths || {})) {
      const current = getByPath(data, path);
      setByPath(data, path, current?._id || originalId);
    }
    data = await this.__model._preSave(data, this.__originalData || null);
    const now = new Date();
    data.updatedAt = now;
    if (!data.createdAt) data.createdAt = now;
    await this.__model._upsertRaw(data);
    Object.keys(this).forEach(k => delete this[k]);
    Object.assign(this, hydrateDates(deepClone(data)));
    this.__originalData = hydrateDates(deepClone(data));
    return this;
  }

  async deleteOne() {
    return this.__model.deleteOne({ _id: this._id });
  }

  toObject() {
    const out = {};
    for (const [k, v] of Object.entries(this)) {
      if (k.startsWith('__')) continue;
      out[k] = deepClone(v);
    }
    return hydrateDates(out);
  }

  toJSON() {
    return this.toObject();
  }
}

class Query {
  constructor(model, type, criteria = {}, options = {}) {
    this.model = model;
    this.type = type;
    this.criteria = criteria || {};
    this.options = options || {};
    this._sort = null;
    this._skip = 0;
    this._limit = null;
    this._select = null;
    this._populate = [];
    this._lean = false;
  }

  sort(spec) { this._sort = spec; return this; }
  skip(n) { this._skip = Number(n || 0); return this; }
  limit(n) { this._limit = Number(n || 0); return this; }
  select(spec) { this._select = spec; return this; }
  populate(path, select) { this._populate.push({ path, select }); return this; }
  lean() { this._lean = true; return this; }

  async exec() {
    if (this.type === 'findById') {
      const row = await this.model._getRawById(this.criteria._id);
      const doc = row ? this.model._hydrate(row) : null;
      return this._finishOne(doc);
    }
    if (this.type === 'findOne') {
      let docs = await this.model._findRaw(this.criteria);
      if (this._sort) docs = sortObjects(docs, this._sort);
      const doc = docs[0] ? this.model._hydrate(docs[0]) : null;
      return this._finishOne(doc);
    }
    if (this.type === 'find') {
      let docs = (await this.model._findRaw(this.criteria)).map(row => this.model._hydrate(row));
      if (this._sort) docs = sortObjects(docs, this._sort);
      if (this._skip) docs = docs.slice(this._skip);
      if (this._limit !== null && this._limit !== 0) docs = docs.slice(0, this._limit);
      docs = await this._applyPopulate(docs);
      if (this._select) docs = docs.map(d => this._project(d));
      if (this._lean) docs = docs.map(d => d.toObject ? d.toObject() : d);
      return docs;
    }
    if (this.type === 'findOneAndUpdate') {
      const doc = await this.model._findOneAndUpdate(this.criteria, this.options.update, this.options.options || {});
      return this._finishOne(doc);
    }
    if (this.type === 'findByIdAndUpdate') {
      const doc = await this.model._findOneAndUpdate({ _id: this.criteria._id }, this.options.update, this.options.options || {});
      return this._finishOne(doc);
    }
    throw new Error(`Unsupported query type: ${this.type}`);
  }

  async _finishOne(doc) {
    if (!doc) return null;
    let result = (await this._applyPopulate([doc]))[0];
    if (this._select) result = this._project(result);
    if (this._lean && result?.toObject) return result.toObject();
    return result;
  }

  _project(doc) {
    const obj = doc.toObject ? doc.toObject() : doc;
    const projected = projectObject(obj, this._select);
    if (this._lean) return projected;
    return this.model._hydrate(projected);
  }

  async _applyPopulate(docs) {
    if (!this._populate.length || !docs.length) return docs;
    for (const pop of this._populate) {
      const refName = populateModelByPath[pop.path];
      const RefModel = registry[refName];
      if (!RefModel) continue;
      for (const doc of docs) {
        const rawId = getByPath(doc, pop.path);
        const id = rawId?._id || rawId;
        if (!id) continue;
        const ref = await RefModel.findById(id).select(pop.select || '').exec();
        if (ref) {
          doc.__populatedPaths[pop.path] = id;
          setByPath(doc, pop.path, ref);
        }
      }
    }
    return docs;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(cb) { return this.exec().finally(cb); }
}

function createModel(name, options = {}) {
  const table = tableNames[name] || name.toLowerCase();
  const methods = options.methods || {};
  const statics = options.statics || {};
  const preSave = options.preSave;

  class ModelDocument extends Document {}
  for (const [methodName, fn] of Object.entries(methods)) {
    Object.defineProperty(ModelDocument.prototype, methodName, { value: fn, enumerable: false });
  }

  class Model {
    static modelName = name;
    static table = table;
    static Document = ModelDocument;

    static _hydrate(data) {
      return new ModelDocument(this, data || {});
    }

    static async _preSave(data, originalData) {
      let next = data;
      if (preSave) next = await preSave.call(this, deepClone(data), originalData || null);
      return next;
    }

    static async _allRows() {
      const db = assertPool();
      const [rows] = await db.query(`SELECT data FROM \`${table}\``);
      return rows.map(r => deserializeData(r.data));
    }

    static async _getRawById(id) {
      if (!id) return null;
      const db = assertPool();
      const [rows] = await db.query(`SELECT data FROM \`${table}\` WHERE id = ? LIMIT 1`, [String(id)]);
      return rows[0] ? deserializeData(rows[0].data) : null;
    }

    static async _findRaw(criteria = {}) {
      const rows = await this._allRows();
      return rows.filter(row => matchesQuery(row, criteria));
    }

    static async _upsertRaw(data) {
      const db = assertPool();
      const now = new Date();
      if (!data._id) data._id = newId();
      if (!data.createdAt) data.createdAt = now;
      data.updatedAt = data.updatedAt || now;
      await db.query(
        `INSERT INTO \`${table}\` (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updatedAt = VALUES(updatedAt)`,
        [String(data._id), serializeData(data), data.createdAt, data.updatedAt]
      );
      return data;
    }

    static find(criteria = {}) { return new Query(this, 'find', criteria); }
    static findOne(criteria = {}) { return new Query(this, 'findOne', criteria); }
    static findById(id) { return new Query(this, 'findById', { _id: id }); }

    static async create(data) {
      const now = new Date();
      let docData = { ...deepClone(data), _id: data?._id || newId(), createdAt: now, updatedAt: now };
      docData = await this._preSave(docData, null);
      await this._upsertRaw(docData);
      return this._hydrate(docData);
    }

    static async countDocuments(criteria = {}) {
      return (await this._findRaw(criteria)).length;
    }

    static async distinct(field, criteria = {}) {
      const rows = await this._findRaw(criteria);
      const seen = new Map();
      for (const row of rows) {
        const value = field === '_id' ? row._id : getByPath(row, field);
        if (Array.isArray(value)) {
          for (const item of value) seen.set(String(normalizeComparable(item)), item);
        } else if (value !== undefined && value !== null) {
          seen.set(String(normalizeComparable(value)), value);
        }
      }
      return [...seen.values()];
    }

    static findOneAndUpdate(criteria, update, optionsArg = {}) {
      return new Query(this, 'findOneAndUpdate', criteria, { update, options: optionsArg });
    }

    static findByIdAndUpdate(id, update, optionsArg = {}) {
      return new Query(this, 'findByIdAndUpdate', { _id: id }, { update, options: optionsArg });
    }

    static async _findOneAndUpdate(criteria, update, optionsArg = {}) {
      let rows = await this._findRaw(criteria);
      let data = rows[0] || null;
      if (!data && optionsArg.upsert) {
        data = { _id: newId(), createdAt: new Date(), updatedAt: new Date(), ...deepClone(criteria || {}) };
      }
      if (!data) return null;
      const original = deepClone(data);
      data = applyUpdate(data, update);
      data._id = data._id || original._id || newId();
      if (!data.createdAt) data.createdAt = original.createdAt || new Date();
      data.updatedAt = new Date();
      data = await this._preSave(data, original);
      await this._upsertRaw(data);
      return this._hydrate(optionsArg.new === false ? original : data);
    }

    static async updateMany(criteria = {}, update = {}) {
      const rows = await this._findRaw(criteria);
      let modifiedCount = 0;
      for (const row of rows) {
        const original = deepClone(row);
        let updated = applyUpdate(row, update);
        updated.updatedAt = new Date();
        updated = await this._preSave(updated, original);
        await this._upsertRaw(updated);
        modifiedCount++;
      }
      return { acknowledged: true, matchedCount: rows.length, modifiedCount };
    }

    static async deleteMany(criteria = {}) {
      const rows = await this._findRaw(criteria);
      const db = assertPool();
      let deletedCount = 0;
      for (const row of rows) {
        const [res] = await db.query(`DELETE FROM \`${table}\` WHERE id = ?`, [String(row._id)]);
        deletedCount += res.affectedRows || 0;
      }
      return { acknowledged: true, deletedCount };
    }

    static async deleteOne(criteria = {}) {
      const rows = await this._findRaw(criteria);
      const row = rows[0];
      if (!row) return { acknowledged: true, deletedCount: 0 };
      const db = assertPool();
      const [res] = await db.query(`DELETE FROM \`${table}\` WHERE id = ?`, [String(row._id)]);
      return { acknowledged: true, deletedCount: res.affectedRows || 0 };
    }

    static async aggregate(pipeline = []) {
      let docs = (await this._allRows()).map(deepClone);
      for (const stage of pipeline) {
        if (stage.$match) docs = docs.filter(d => matchesQuery(d, stage.$match));
        else if (stage.$group) docs = groupDocs(docs, stage.$group);
        else if (stage.$sort) docs = sortObjects(docs, stage.$sort);
        else if (stage.$limit) docs = docs.slice(0, Number(stage.$limit));
        else if (stage.$project) docs = docs.map(d => projectObject(d, Object.keys(stage.$project).filter(k => stage.$project[k]).join(' ')));
      }
      return docs;
    }
  }

  for (const [staticName, fn] of Object.entries(statics)) {
    Object.defineProperty(Model, staticName, { value: fn, enumerable: false });
  }

  registry[name] = Model;
  return Model;
}

function evalExpression(doc, expr) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr === 'string') {
    return expr.startsWith('$') ? getByPath(doc, expr.slice(1)) : expr;
  }
  if (typeof expr !== 'object' || expr instanceof Date || Array.isArray(expr)) return expr;
  if (expr.$dateToString) {
    const date = evalExpression(doc, expr.$dateToString.date);
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    // Supported use in this project is YYYY-MM-DD grouping.
    return d.toISOString().slice(0, 10);
  }
  if (expr.$eq) {
    const [a, b] = expr.$eq;
    return valuesEqual(evalExpression(doc, a), evalExpression(doc, b));
  }
  if (expr.$ne) {
    const [a, b] = expr.$ne;
    return !valuesEqual(evalExpression(doc, a), evalExpression(doc, b));
  }
  if (expr.$cond) {
    const cond = Array.isArray(expr.$cond)
      ? { if: expr.$cond[0], then: expr.$cond[1], else: expr.$cond[2] }
      : expr.$cond;
    return evalExpression(doc, cond.if) ? evalExpression(doc, cond.then) : evalExpression(doc, cond.else);
  }
  if (expr.$toString) return String(evalExpression(doc, expr.$toString));
  return expr;
}

function evalGroupId(doc, groupId) {
  return evalExpression(doc, groupId);
}

function groupDocs(docs, spec) {
  const groups = new Map();
  for (const doc of docs) {
    const id = evalGroupId(doc, spec._id);
    const key = JSON.stringify(id);
    if (!groups.has(key)) groups.set(key, { _id: id, __avg: {} });
    const out = groups.get(key);
    for (const [field, expr] of Object.entries(spec)) {
      if (field === '_id') continue;
      if (expr.$sum !== undefined) {
        const val = expr.$sum === 1 ? 1 : Number(evalExpression(doc, expr.$sum) || 0);
        out[field] = (out[field] || 0) + (Number.isNaN(val) ? 0 : val);
      } else if (expr.$avg) {
        const val = Number(evalExpression(doc, expr.$avg) || 0);
        if (!out.__avg[field]) out.__avg[field] = { sum: 0, count: 0 };
        if (!Number.isNaN(val)) { out.__avg[field].sum += val; out.__avg[field].count += 1; }
      }
    }
  }
  return [...groups.values()].map(g => {
    for (const [field, stats] of Object.entries(g.__avg || {})) g[field] = stats.count ? stats.sum / stats.count : null;
    delete g.__avg;
    return g;
  });
}

module.exports = {
  connect,
  close,
  getStatus,
  ensureTables,
  createModel,
  newId,
  getByPath,
  setByPath,
  matchesQuery,
  sanitizeUrl,
};

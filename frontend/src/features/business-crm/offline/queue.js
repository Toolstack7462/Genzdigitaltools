import { offlineDb } from './db';
import { crmApi } from '../api';

const SENSITIVE = /password|credential|token|secret|cookie|authorization|vault/i;
function sensitive(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(sensitive);
  return Object.entries(value).some(([key, child]) => SENSITIVE.test(key) || sensitive(child));
}
function storedUserId() {
  try {
    const user = JSON.parse(localStorage.getItem('genz_admin_user') || 'null');
    return String(user?._id || user?.id || '');
  } catch (_) { return ''; }
}
function actorId(userId) {
  const id = String(userId || storedUserId() || '');
  if (!id) throw new Error('The signed-in admin identity is unavailable. Reconnect and sign in again before queuing offline work.');
  return id;
}
function assertOwned(record, userId) {
  const current = actorId(userId);
  if (!record?.queuedByUserId || String(record.queuedByUserId) !== current) {
    throw new Error('This queued operation belongs to another or an unknown admin account and cannot be synchronized from this session.');
  }
  return current;
}

export function deviceId() {
  const key = 'genz_business_crm_device';
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}

export async function queueOperation(type, payload, userId) {
  if (sensitive(payload)) throw new Error('Sensitive credentials cannot be stored offline. Remove credentials or reconnect.');
  const record = {
    idempotencyKey: crypto.randomUUID(),
    queuedByUserId: actorId(userId),
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await offlineDb.putQueue(record);
  return record;
}

export async function syncQueue(userId) {
  if (!navigator.onLine) return { synced: 0, failed: 0, blocked: 0, queued: await queueCount(userId) };
  const current = actorId(userId);
  const all = await offlineDb.listQueue();
  const operations = all.filter((operation) => String(operation.queuedByUserId || '') === current);
  const blocked = all.length - operations.length;
  if (!operations.length) return { synced: 0, failed: 0, blocked, queued: 0 };
  const response = await crmApi.post('/sync/batch', {
    deviceId: deviceId(),
    operations: operations.map((operation) => ({ ...operation, userId: operation.queuedByUserId })),
  });
  let synced = 0; let failed = 0;
  const byKey = new Map(operations.map((operation) => [operation.idempotencyKey, operation]));
  for (const result of response.data.results || []) {
    if (result.status === 'completed') {
      await offlineDb.deleteQueue(result.idempotencyKey); synced += 1;
    } else {
      const original = byKey.get(result.idempotencyKey);
      if (original) await offlineDb.putQueue({
        ...original,
        attempts: Number(original.attempts || 0) + 1,
        lastStatus: result.status,
        lastError: result.error || result.result?.error || 'Synchronization is pending',
        lastAttemptAt: new Date().toISOString(),
      });
      failed += 1;
    }
  }
  return { synced, failed, blocked, queued: await queueCount(current), results: response.data.results || [] };
}

export async function discardOperation(record, userId) {
  assertOwned(record, userId);
  await offlineDb.deleteQueue(record.idempotencyKey);
}

export async function retryOperationAsNew(record, userId) {
  assertOwned(record, userId);
  if (!['failed', 'rejected'].includes(record.lastStatus)) throw new Error('A new idempotency key is allowed only after an explicit server failure or rejection.');
  const replacement = await queueOperation(record.type, record.payload, userId);
  await offlineDb.deleteQueue(record.idempotencyKey);
  return replacement;
}

export async function queueCount(userId) {
  const current = String(userId || storedUserId() || '');
  const rows = await offlineDb.listQueue();
  return current ? rows.filter((row) => String(row.queuedByUserId || '') === current).length : 0;
}

export async function listQueueForUser(userId) {
  const current = actorId(userId);
  const rows = await offlineDb.listQueue();
  return rows.map((row) => ({
    ...row,
    ownership: String(row.queuedByUserId || '') === current ? 'current' : (row.queuedByUserId ? 'other-user' : 'unbound'),
  }));
}

const DB_NAME = 'genz-business-crm-v2';
const VERSION = 1;
const STORE_QUEUE = 'queue';
const STORE_CACHE = 'cache';
function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable'));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE, { keyPath: 'idempotencyKey' });
      if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transaction(storeName, mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode); const store = tx.objectStore(storeName); let result;
    try { result = work(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }));
}
export const offlineDb = {
  putQueue: (record) => transaction(STORE_QUEUE, 'readwrite', (store) => store.put(record)),
  deleteQueue: (key) => transaction(STORE_QUEUE, 'readwrite', (store) => store.delete(key)),
  listQueue: () => transaction(STORE_QUEUE, 'readonly', (store) => store.getAll()),
  putCache: (key, value) => transaction(STORE_CACHE, 'readwrite', (store) => store.put({ key, value, cachedAt: new Date().toISOString() })),
  getCache: (key) => transaction(STORE_CACHE, 'readonly', (store) => store.get(key)),
  clear: () => Promise.all([transaction(STORE_QUEUE, 'readwrite', (s) => s.clear()), transaction(STORE_CACHE, 'readwrite', (s) => s.clear())]),
};

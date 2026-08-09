export function registerBusinessCrmWorker() {
  if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return Promise.resolve(null);
  return navigator.serviceWorker.register('/admin/business/sw.js', { scope: '/admin/business/' }).catch((error) => { console.warn('[Business CRM] service worker registration failed', error.message); return null; });
}

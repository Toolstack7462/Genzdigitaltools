/* Gen Z Business CRM asset shell. Financial responses are never cached. */
const CACHE='genz-business-crm-shell-v2';
const SHELL=['/admin/business','/admin/business/sales','/admin/business/clients','/admin/business/products'];
self.addEventListener('install',(event)=>{event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(SHELL).catch(()=>{})));self.skipWaiting()});
self.addEventListener('activate',(event)=>{event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key)))));self.clients.claim()});
self.addEventListener('fetch',(event)=>{const request=event.request;const url=new URL(request.url);if(request.method!=='GET'||url.pathname.startsWith('/api/')||url.origin!==self.location.origin)return;event.respondWith(fetch(request).then((response)=>{if(response.ok&&['script','style','image','font'].includes(request.destination)){const clone=response.clone();caches.open(CACHE).then((cache)=>cache.put(request,clone))}return response}).catch(()=>caches.match(request).then((hit)=>hit||caches.match('/admin/business'))))});

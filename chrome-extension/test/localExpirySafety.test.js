'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {env,PLUS,PRO,CLAUDE,scope}=require('./_accessRegressionHarness');
function owned(){return {genzTabBindings:{1:{toolId:'plus',gen:1},2:{toolId:'pro',gen:2},3:{toolId:'claude',gen:3}}};}
function tablist(){return [{id:1,url:'https://chatgpt.com/a'},{id:2,url:'https://chatgpt.com/b'},{id:3,url:'https://claude.ai/c'}];}
test('expiry of Pro preserves shared localStorage for active Plus, while ending only Pro',async()=>{
 const e=env({storage:owned(),tabs:tablist()});await e.call('cleanupToolSession',{...PRO,reason:'expired'},scope(PLUS,CLAUDE));
 assert.equal(e.origins.get('https://chatgpt.com').get('auth-session'),'synthetic');
 assert.equal(e.tabStores.get(2).size,0);assert.ok(e.tabStores.get(1).size>0);assert.deepEqual(e.calls.navigation.map(x=>x.id),[2]);assert.equal(e.calls.cookies.length,0);
});
test('single expired assignment still clears its local data and redirects to local renewal page',async()=>{
 const e=env({storage:owned(),tabs:[tablist()[1]],cookies:[{name:'synthetic',domain:'chatgpt.com',path:'/',secure:true}]});
 await e.call('cleanupToolSession',{...PRO,reason:'expired'},scope());
 assert.equal(e.origins.get('https://chatgpt.com').size,0);assert.equal(e.calls.cookies.length,1);assert.equal(e.calls.navigation[0].id,2);
 assert.ok(e.calls.navigation[0].url.startsWith('chrome-extension://fixture/expired.html'));
});
test('another active tool on a protected child domain retains cookies under its parent domain',async()=>{
 const e=env({cookies:[{name:'parent',domain:'.example.test',path:'/',secure:true},{name:'child',domain:'active.example.test',path:'/',secure:true}]});
 await e.call('clearCookiesForConfig',{domains:['example.test']},new Set(['active.example.test']));assert.equal(e.calls.cookies.length,0);
});
test('cookie removal retains the explicit cookie store and partition identity',async()=>{
 const e=env({cookies:[{name:'synthetic',domain:'chatgpt.com',path:'/',secure:true,storeId:'0',partitionKey:{topLevelSite:'https://chatgpt.com'}}]});
 await e.call('clearCookiesForConfig',PRO.cleanup,new Set());
 assert.equal(e.calls.cookies[0].storeId,'0');assert.deepEqual(e.calls.cookies[0].partitionKey,{topLevelSite:'https://chatgpt.com'});
});
test('malformed cleanup manifest cannot turn missing arrays into removal of every known tool',async()=>{
 const e=env({storage:{extensionToken:'synthetic',cleanupKnownTools:{pro:PRO.cleanup},...owned()},tabs:tablist(),api:async()=>({ok:true})});
 await e.call('runCleanupSync','test');assert.equal(e.calls.navigation.length,0);assert.ok(e.storage.cleanupKnownTools.pro);
});
test('an active renewal wins over an old revoked entry for the same tool',async()=>{
 const e=env({storage:{extensionToken:'synthetic',cleanupKnownTools:{pro:PRO.cleanup},...owned()},tabs:tablist(),api:async()=>({active:[PRO],revoked:[{...PRO,reason:'expired'}]})});
 await e.call('runCleanupSync','test');assert.equal(e.calls.navigation.length,0);assert.ok(e.storage.cleanupKnownTools.pro);
});
test('one client expiry never invokes a provider logout or touches the other client profile',async()=>{
 const e=env({storage:{extensionToken:'client-A',cleanupKnownTools:{pro:PRO.cleanup},...owned()},tabs:[tablist()[1]],api:async()=>({active:[],revoked:[{...PRO,reason:'expired'}]})});
 const other=env({storage:{extensionToken:'client-B',tools:[{id:'pro'}],...owned()},tabs:[tablist()[1]],cookies:[{name:'same-provider-session',domain:'chatgpt.com',path:'/',secure:true}]});
 const before=JSON.stringify(other.storage);await e.call('runCleanupSync','expiry');
 assert.deepEqual(e.calls.api,['/cleanup-manifest']);assert.equal(e.calls.navigation.length,1);assert.equal(JSON.stringify(other.storage),before);
 assert.equal(other.calls.cookies.length,0);assert.equal(other.calls.navigation.length,0);
});
test('valid no-assignment manifest still enforces local removal (no fail-open expiry)',async()=>{
 const e=env({storage:{extensionToken:'synthetic',cleanupKnownTools:{pro:PRO.cleanup},...owned()},tabs:[tablist()[1]],api:async()=>({active:[],revoked:[]})});
 await e.call('runCleanupSync','expiry');assert.equal(e.calls.navigation.length,1);assert.deepEqual(e.storage.cleanupKnownTools,{});
});
test('transient cleanup network failure does not wipe sessions',async()=>{
 const e=env({storage:{extensionToken:'synthetic',cleanupKnownTools:{pro:PRO.cleanup},...owned()},tabs:tablist(),api:async()=>{throw new Error('network unavailable');}});
 await e.call('runCleanupSync','test');assert.equal(e.calls.navigation.length,0);assert.ok(e.storage.cleanupKnownTools.pro);
});
test('Claude cleanup still removes its own cookies and storage without touching ChatGPT',async()=>{
 const e=env({storage:owned(),tabs:tablist(),cookies:[{name:'synthetic',domain:'claude.ai',path:'/',secure:true}]});
 await e.call('cleanupToolSession',{...CLAUDE,reason:'revoked'},scope(PLUS,PRO));assert.deepEqual(e.calls.navigation.map(x=>x.id),[3]);
 assert.equal(e.calls.cookies.length,1);assert.equal(e.origins.get('https://claude.ai').size,0);assert.ok(e.origins.get('https://chatgpt.com').size>0);
});
test('cleanup performs no credential-bearing log or provider API call',async()=>{
 const e=env({storage:owned(),tabs:tablist(),cookies:[{name:'session',value:'SENSITIVE-SYNTHETIC-COOKIE',domain:'chatgpt.com',path:'/',secure:true}]});
 await e.call('cleanupToolSession',{...PRO,reason:'expired'},scope(PLUS));assert.equal(e.calls.api.length,0);
 assert.ok(!JSON.stringify(e.calls.logs).includes('SENSITIVE-SYNTHETIC-COOKIE'));
});

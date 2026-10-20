'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {env,WH,clone}=require('./_accessRegressionHarness');
const auth={extensionToken:'synthetic-client-A',apiUrl:'https://api.genzdigitalstore.com'};
function base(extra={}) { return {...auth,tools:[],toolVersions:{wh:{version:2}},sessionBundleVersions:{},...extra}; }
function setup(storage,api){return env({storage,api,skipCleanup:true});}
test('missing WriteHuman list is repaired even when credential versions did not increase',async()=>{
 const e=setup(base(),async()=>({success:true,tools:[WH]}));
 await e.call('checkForUpdates'); assert.equal(e.storage.tools.length,1); assert.equal(e.storage.tools[0].id,'wh'); assert.equal(e.storage.syncStatus,'ok');
});
test('renewal metadata refreshes at the same credential version',async()=>{
 const old=clone(WH);old.assignment.endDate='2026-09-01';
 const e=setup(base({tools:[old]}),async()=>({success:true,tools:[WH]}));
 await e.call('checkForUpdates');assert.equal(e.storage.tools[0].assignment.endDate,WH.assignment.endDate);
});
test('name/domain changes rebuild the map instead of leaving an old hostname authorized',async()=>{
 const e=setup(base({tools:[{...WH,domain:'old.example',targetUrl:'https://old.example/'}]}),async()=>({success:true,tools:[WH]}));
 await e.call('loadCachedData');await e.call('checkForUpdates');
 assert.equal(e.evaluate("domainToolMap.has('old.example')"),false);assert.equal(e.evaluate("domainToolMap.get('writehuman.ai').id"),'wh');
});
test('successful empty assignment snapshot removes stale tools and version maps',async()=>{
 const e=setup(base({tools:[WH],sessionBundleVersions:{wh:{version:1}}}),async()=>({success:true,tools:[]}));
 await e.call('checkForUpdates');assert.deepEqual(e.storage.tools,[]);assert.deepEqual(e.storage.toolVersions,{});assert.deepEqual(e.storage.sessionBundleVersions,{});
});
test('authoritative removal invalidates that tool cached bundle, not another tool',async()=>{
 const e=setup(base({tools:[WH],sessCache_wh:{sessionBundle:{cookies:['synthetic']}},sessCache_other:{marker:'keep'}}),async()=>({success:true,tools:[]}));
 await e.call('checkForUpdates');assert.equal(e.storage.sessCache_wh,undefined);assert.deepEqual(e.storage.sessCache_other,{marker:'keep'});
});
test('missing tools array is not silently treated as a valid empty sync',async()=>{
 const e=setup(base({tools:[WH]}),async()=>({success:true}));await e.call('checkForUpdates');
 assert.deepEqual(e.storage.tools,[WH]);assert.notEqual(e.storage.syncStatus,'ok');
});
test('malformed tool row fails the sync without replacing the prior snapshot',async()=>{
 const e=setup(base({tools:[WH]}),async()=>({success:true,tools:[{}]}));await e.call('checkForUpdates');
 assert.deepEqual(e.storage.tools,[WH]);assert.notEqual(e.storage.syncStatus,'ok');
});
test('transient network failure preserves assigned tools and schedules a retry status',async()=>{
 const e=setup(base({tools:[WH]}),async()=>{throw new Error('Failed to fetch');}); await e.call('checkForUpdates');
 assert.deepEqual(e.storage.tools,[WH]);assert.equal(e.storage.syncStatus,'offline');assert.equal(e.storage.syncRetryCount,1);
});
test('a response for an old client token is never committed after account switch',async()=>{
 let resolve;const reply=new Promise(r=>resolve=r);const e=setup(base(),()=>reply);const p=e.call('checkForUpdates');
 await new Promise(r=>setImmediate(r));e.storage.extensionToken='synthetic-client-B';e.storage.tools=[{id:'b',domain:'b.example'}];
 resolve({success:true,tools:[{...WH,credentialVersion:3}]});await p;assert.equal(e.storage.tools[0].id,'b');assert.equal(e.evaluate("domainToolMap.has('writehuman.ai')"),false);
});
test('late older sync cannot overwrite a newer completed snapshot',async()=>{
 const replies=[];const e=setup(base(),()=>new Promise(r=>replies.push(r)));
 const a=e.call('checkForUpdates');await new Promise(r=>setImmediate(r));const b=e.call('checkForUpdates');await new Promise(r=>setImmediate(r));
 replies[1]({success:true,tools:[{...WH,name:'new',credentialVersion:4}]});await b;replies[0]({success:true,tools:[{...WH,name:'old',credentialVersion:3}]});await a;
 assert.equal(e.storage.tools[0].name,'new');
});
test('metadata refresh alone does not raise session-update notifications',async()=>{
 const e=setup(base(),async()=>({success:true,tools:[WH]}));await e.call('checkForUpdates');assert.equal(e.calls.notifications.length,0);
});
test('dashboard Access refreshes the missing metadata and advances to the existing permission gate',async()=>{
 const e=setup(base(),async()=>({success:true,tools:[WH]}));
 const r=await e.call('_handleOpenToolInner',{toolId:'wh'});assert.equal(r.error,'permission_required');assert.equal(e.calls.navigation.length,0);
});
test('confirmed unassigned tool still refuses to open and never invents a Tool record',async()=>{
 const e=setup(base(),async()=>({success:true,tools:[]}));const r=await e.call('_handleOpenToolInner',{toolId:'wh'});
 assert.equal(r.success,false);assert.equal(r.error,'tool_not_synced');assert.equal(e.calls.navigation.length,0);
});

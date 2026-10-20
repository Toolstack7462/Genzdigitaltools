'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {env,WH,response,deferred,flush,clone}=require('./_fullBackgroundHarness.cjs');
const base='https://api.genzdigitalstore.com';
const connect=(token,extra={})=>({type:'GENZ_CONNECT_EXTENSION',payload:{apiUrl:base,activationToken:token,...extra}});
const activated=token=>response({success:true,token,expiresAt:'2031-01-01T00:00:00Z',user:{id:'fixture-client',email:'fixture@example.invalid',name:'Test'}});
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw new Error('Fixture condition did not become true');}
function standard(url){return new URL(url).pathname.endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({success:true,tools:[WH]});}
test('duplicate concurrent activation redemption uses ONE server request and cannot erase its successful session',async t=>{
 const pending=deferred();let count=0;
 const e=env({fetch:url=>url.endsWith('/auth/activate')?(++count===1?pending.promise:response({error:'used activation',code:'activation_token_invalid'},401)):standard(url)});t.after(e.close);
 const a=e.message(connect('same-fixture-activation')); const b=e.message(connect('same-fixture-activation'));
 await until(()=>count>0); pending.resolve(activated('SESSION-ONE'));
 const out=await Promise.all([a,b]); assert.equal(count,1); assert.ok(out.every(r=>r.success)); assert.equal(e.storage.extensionToken,'SESSION-ONE');
});
test('a just-completed activation replay is idempotent only while that exact session is current',async t=>{
 let count=0;const e=env({fetch:url=>url.endsWith('/auth/activate')?(++count===1?activated('SESSION-ONE'):response({error:'used',code:'activation_token_invalid'},401)):standard(url)});t.after(e.close);
 assert.equal((await e.message(connect('same-fixture-activation'))).success,true);
 assert.equal((await e.message(connect('same-fixture-activation'))).success,true);assert.equal(count,1);assert.equal(e.storage.extensionToken,'SESSION-ONE');
});
test('a slow previous activation failure cannot disconnect a newer successful activation',async t=>{
 const old=deferred();let calls=0;
 const e=env({fetch:(url,init)=>{if(url.endsWith('/auth/activate')){calls++;return JSON.parse(init.body).activationToken==='old'?old.promise:activated('SESSION-NEW');}return standard(url);}});t.after(e.close);
 const a=e.message(connect('old'));await until(()=>calls===1);const b=await e.message(connect('new'));assert.equal(b.success,true);
 old.resolve(response({error:'expired',code:'activation_token_invalid'},401));await a;assert.equal(e.storage.extensionToken,'SESSION-NEW');
});
test('a slow previous activation SUCCESS cannot overwrite the later requested client session',async t=>{
 const old=deferred();let calls=0;
 const e=env({fetch:(url,init)=>{if(url.endsWith('/auth/activate')){calls++;return JSON.parse(init.body).activationToken==='old'?old.promise:activated('SESSION-NEW');}return standard(url);}});t.after(e.close);
 const a=e.message(connect('old'));await until(()=>calls===1);await e.message(connect('new'));
 old.resolve(activated('SESSION-OLD'));await a;assert.equal(e.storage.extensionToken,'SESSION-NEW');
});
test('activation returns its real connected state without waiting for slow metadata sync',async t=>{
 const tools=deferred();let requested=false,settled=false;
 const e=env({fetch:url=>url.endsWith('/auth/activate')?activated('SESSION-NEW'):url.endsWith('/tools')?(requested=true,tools.promise):standard(url)});t.after(e.close);
 const a=e.message(connect('new')).then(r=>{settled=true;return r;});await until(()=>requested);
 await new Promise(r=>setTimeout(r,15));const before=settled;tools.resolve(response({success:true,tools:[WH]}));const out=await a;
 assert.equal(before,true,'slow sync must not consume dashboard activation response timeout');assert.equal(out.connected,true);assert.equal(out.synced,false);
});
test('two cold concurrent requests mint only ONE device fingerprint',async t=>{
 const e=env({storage:{_deviceId:null}});t.after(e.close);
 const out=await Promise.all([e.call('getOrCreateDeviceId'),e.call('getOrCreateDeviceId')]);assert.equal(out[0],out[1]);
 assert.equal(e.calls.writes.filter(w=>w._deviceId).length,1);
});
test('a successful stale API response is not returned to a new signed-in session',async t=>{
 const p=deferred();const e=env({fetch:()=>p.promise});t.after(e.close);
 const req=e.call('apiRequest','/tools').catch(err=>err);await until(()=>e.calls.network.length===1);
 e.storage.extensionToken='NEW-CLIENT';p.resolve(response({success:true,tools:[WH]}));
 const out=await req;assert.equal(out.code,'connection_changed');assert.equal(out.tools,undefined);
});
test('all activation failures preserve exact safe HTTP/code context without raw token output',async t=>{
 const e=env({fetch:url=>url.endsWith('/auth/activate')?response({error:'denied',code:'device_blocked'},403):standard(url)});t.after(e.close);
 const r=await e.message(connect('TOP-SECRET-TEST-ONLY'));assert.equal(r.success,false);assert.equal(r.status,403);assert.equal(r.code,'device_blocked');
 assert.equal(JSON.stringify(e.calls.logs).includes('TOP-SECRET-TEST-ONLY'),false);
});

test('explicit extension reset cancels a pending activation instead of reactivating after logout',async t=>{
 const pending=deferred();let sent=false;const e=env({fetch:url=>url.endsWith('/auth/activate')?(sent=true,pending.promise):standard(url)});t.after(e.close);
 const connecting=e.message(connect('pending'));await until(()=>sent);
 await e.message({type:'GENZ_RESET_EXTENSION_SESSION',payload:{reason:'user_reviewed_reset'}});
 pending.resolve(activated('MUST-NOT-COMMIT'));const result=await connecting;
 assert.equal(result.success,false);assert.equal(e.storage.extensionToken,undefined);
});
test('an old expired status snapshot cannot clear a newly stored valid token',async t=>{
 const e=env({storage:{tokenExpiresAt:'2020-01-01T00:00:00Z'}});t.after(e.close);
 const original=e.chrome.storage.local.get;let switched=false;
 e.chrome.storage.local.get=(keys,cb)=>original(keys,d=>{
  if(!switched && [].concat(keys).includes('tokenExpiresAt')){switched=true;e.storage.extensionToken='VALID-NEW';e.storage.tokenExpiresAt='2031-01-01T00:00:00Z';}
  cb(d);
 });
 const result=await e.message({type:'GENZ_GET_EXTENSION_STATUS'});
 assert.equal(result.connected,true);assert.equal(e.storage.extensionToken,'VALID-NEW');
});

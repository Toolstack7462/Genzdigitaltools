'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {env,WH,response,clone}=require('./_fullBackgroundHarness.cjs');
function endpoint(url){return new URL(url).pathname;}
test('duplicate renewal picks no-expiry active row but rejects conflicting target metadata',async t=>{
 const e=env({fetch:async url=>endpoint(url).endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({success:true,tools:[WH,{...WH,assignment:{...WH.assignment,id:'permanent',endDate:null}}]})});t.after(e.close);
 const r=await e.call('checkForUpdates');assert.equal(r.success,true);assert.equal(e.storage.tools[0].assignment.id,'permanent');
 const before=clone(e.storage.tools);e.eval('normalizeAssignedTools');
 assert.throws(()=>e.call('normalizeAssignedTools',[WH,{...WH,targetUrl:'https://other.invalid/'}]),/Conflicting/);assert.deepEqual(e.storage.tools,before);
});
test('duplicate renewal date-only and midnight use inclusive UTC boundary',t=>{
 const e=env();t.after(e.close);const want=Date.UTC(2031,9,20,23,59,59,999);
 for(const value of ['2031-10-20','2031-10-20 00:00:00','2031-10-20T00:00:00.000Z'])assert.equal(e.call('assignedToolEnd',value),want);
 assert.equal(e.call('assignedToolEnd','2031-10-20T12:30:00.000Z'),Date.UTC(2031,9,20,12,30));
});
test('fresh list 403 is business denial, not a new activation or account-wide logout',async t=>{
 const e=env({fetch:async url=>endpoint(url).endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({error:'Device blocked',code:'device_blocked'},403)});t.after(e.close);
 const r=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(r.success,false);assert.equal(r.error,'sync_failed');assert.equal(r.needsReauth,false);assert.equal(r.code,'device_blocked');assert.equal(r.status,403);
 assert.equal(e.storage.extensionToken,'TEST-TOKEN-NOT-REAL');assert.equal(e.calls.network.some(c=>/logout|activate/.test(c.url)),false);
});
test('expired credential assignment stays denied without provider logout or cookie mutation',async t=>{
 const e=env({storage:{tools:[WH]},permission:true,fetch:async url=>{
 const p=endpoint(url);if(p.endsWith('/cleanup-manifest'))return response({ok:true,active:[],revoked:[]});
 if(p.endsWith('/versions'))return response({versions:{}});
 if(p.endsWith('/credentials'))return response({code:'assignment_expired',error:'expired'},403);
 return response({success:true,tools:[WH]});}});t.after(e.close);
 const r=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(r.error,'tool_access_expired');assert.equal(e.calls.network.some(c=>/logout|activate/.test(c.url)),false);assert.equal(e.calls.cookies.length,0);assert.equal(e.calls.tabs.length,0);
});
test('malformed sync data reports safe code and cannot destroy a prior tool snapshot',async t=>{
 const e=env({storage:{tools:[WH]},fetch:async url=>endpoint(url).endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({success:true,tools:[{id:WH.id},null]})});t.after(e.close);
 const r=await e.call('checkForUpdates');assert.equal(r.success,false);assert.equal(r.code,'invalid_tools_response');assert.deepEqual(e.storage.tools,[WH]);
 const st=await e.message({type:'GENZ_GET_EXTENSION_STATUS'});assert.equal(st.connected,true);assert.equal(st.syncErrorCode,'invalid_tools_response');
 assert.equal(JSON.stringify(st).includes('TEST-TOKEN-NOT-REAL'),false);
});
test('sync preparation without auth reports explicit reauth and no network',async t=>{
 const e=env({storage:{extensionToken:null}});t.after(e.close);const r=await e.call('checkForUpdates');
 assert.equal(r.error,'auth_expired');assert.equal(r.needsReauth,true);assert.equal(e.calls.network.length,0);
});
test('request deadline covers JSON body consumption, not only response headers',async t=>{
 const e=env({fetch:async(url,init)=>({ok:true,status:200,json:()=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}))})});t.after(e.close);
 const outcome=await Promise.race([e.call('fetchJsonWithDeadline','https://fixture.invalid/',{},10).then(()=> 'ok',e=>e.name),new Promise(r=>setTimeout(()=>r('no-timeout'),80))]);
 assert.equal(outcome,'AbortError');
});

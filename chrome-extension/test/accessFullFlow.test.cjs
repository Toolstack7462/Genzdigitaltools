'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {env,WH,response,deferred,flush,clone}=require('./_fullBackgroundHarness.cjs');
function toolsFetch(tools){return async url=>new URL(url).pathname.endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({success:true,tools});}
test('actual background: two valid renewal rows do not poison the assigned Tool snapshot',async t=>{
 const renewal={...clone(WH),assignment:{...WH.assignment,id:'assignment-renewal',endDate:'2031-10-20'}};
 const e=env({fetch:toolsFetch([WH,renewal])});t.after(e.close);
 const r=await e.call('checkForUpdates');
 assert.equal(r.success,true,'/tools may legitimately contain more than one active assignment for one tool');
 assert.equal(e.storage.tools.length,1);assert.equal(e.storage.tools[0].assignment.id,'assignment-renewal');
});
test('actual Access message: duplicate rows for ANOTHER tool must not block WriteHuman',async t=>{
 const other={...clone(WH),id:'b'.repeat(24),name:'Other',domain:'other.example',targetUrl:'https://other.example/'};
 const e=env({fetch:toolsFetch([other,{...other,assignment:{...other.assignment,id:'renewal-2'}},WH])});t.after(e.close);
 const r=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(r.error,'permission_required','must reach the unchanged permission gate, not tool_not_synced');
 assert.equal(e.calls.tabs.length,0);
});
test('actual Access message retains the upstream 503 sync failure instead of tool_not_synced',async t=>{
 const e=env({fetch:async url=>new URL(url).pathname.endsWith('/cleanup-manifest')?response({ok:true,active:[],revoked:[]}):response({error:'Temporary failure',code:'server_error'},503)});t.after(e.close);
 const r=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(r.error,'sync_failed');assert.equal(r.status,503);assert.equal(r.stage,'tools_sync');assert.equal(e.calls.tabs.length,0);
});
test('actual Access message handles a missing extension token as reauth, not absent tool',async t=>{
 const e=env({storage:{extensionToken:null}});t.after(e.close);
 const r=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(r.error,'auth_expired');assert.equal(r.needsReauth,true);assert.equal(e.calls.tabs.length,0);
});
test('actual Chrome storage callback failure must not return success',async t=>{
 const e=env({fetch:toolsFetch([WH]),writeError:data=>Array.isArray(data.tools)?'QUOTA_BYTES quota exceeded':null});t.after(e.close);
 const r=await e.call('checkForUpdates');assert.equal(r.success,false);assert.equal(e.storage.tools.length,0);assert.notEqual(e.storage.syncStatus,'ok');
});
test('actual API late 401 from a previous client must not erase the NEW client connection',async t=>{
 const pending=deferred();const e=env({fetch:()=>pending.promise});t.after(e.close);
 const request=e.call('apiRequest','/tools').catch(err=>err);await flush();
 e.storage.extensionToken='SECOND-TEST-TOKEN';e.storage.tools=[{id:'second-client-only'}];
 pending.resolve(response({error:'Expired',code:'extension_token_invalid'},401));await request;
 assert.equal(e.storage.extensionToken,'SECOND-TEST-TOKEN');assert.equal(e.storage.tools[0].id,'second-client-only');
});
test('Access waits for the newer overlapping sync instead of reading the still-empty cache',async t=>{
 const replies=[];const e=env({fetch:async url=>{if(new URL(url).pathname.endsWith('/cleanup-manifest'))return response({ok:true,active:[],revoked:[]});const d=deferred();replies.push(d);return d.promise;}});t.after(e.close);
 let settled=false;const launch=e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}}).then(r=>{settled=true;return r;});await flush();
 for(let i=0;i<200 && replies.length<1;i++)await new Promise(r=>setTimeout(r,2));
 const newer=e.call('checkForUpdates');for(let i=0;i<200 && replies.length<2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(replies.length,2);
 replies[0].resolve(response({success:true,tools:[WH]}));await new Promise(r=>setTimeout(r,15));
 const early=settled;
 replies[1].resolve(response({success:true,tools:[WH]}));await newer;
 const r=await launch;
 assert.equal(early,false,'Access must wait for the pending newer snapshot');assert.equal(r.error,'permission_required');
});

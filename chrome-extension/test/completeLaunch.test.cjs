'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {env,WH,response,clone}=require('./_fullBackgroundHarness.cjs');
const base='https://api.genzdigitalstore.com';
const payload={apiUrl:base,activationToken:'SYNTHETIC-ACTIVATION'};
const sibling={...WH,id:'b'.repeat(24),name:'Other tool',domain:'other.example',targetUrl:'https://other.example/'};
const renewed={...WH,assignment:{...WH.assignment,id:'renewed-fixture-assignment',endDate:'2031-11-20'}};
function route(url){
 const p=new URL(url).pathname;
 if(p.endsWith('/auth/activate'))return response({success:true,token:'AUTH-SYNTHETIC',expiresAt:'2031-01-01T00:00:00Z',user:{id:'synthetic-client'}});
 if(p.endsWith('/cleanup-manifest'))return response({ok:true,active:[],revoked:[]});
 if(p.endsWith('/tools'))return response({success:true,tools:[WH,renewed,sibling]});
 if(p.endsWith('/versions'))return response({versions:{[WH.id]:{version:2,assignmentId:renewed.assignment.id}}});
 if(p.endsWith('/credentials'))return response({success:true,tool:WH,sessionBundle:{version:1,cookies:[{name:'fixture_session',value:'FIXTURE-ONLY-SESSION-NOT-REAL',domain:'writehuman.ai',secure:true,httpOnly:true}]}});
 if(p.endsWith('/opened'))return response({success:true});
 throw new Error('Unexpected test URL');
}
test('full module: activation -> duplicate-renewal sync -> authenticated credentials -> ONE bound tab',async t=>{
 const e=env({storage:{extensionToken:null},permission:true,fetch:route});t.after(e.close);
 const connected=await e.message({type:'GENZ_CONNECT_EXTENSION',payload});assert.equal(connected.connected,true);
 const out=await e.message({type:'GENZ_OPEN_TOOL',payload:{toolId:WH.id}});
 assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.method,'session_bundle');assert.equal(e.calls.tabs.filter(t=>t.url).length,1);
 assert.equal(e.calls.cookies.filter(c=>c.name==='fixture_session').length,1);
 assert.equal(e.storage.genzTabBindings['1'].toolId,WH.id);assert.equal(e.storage.tools.length,2);
 assert.ok(e.calls.network.some(c=>c.url.endsWith('/credentials')));
 assert.equal(JSON.stringify(e.calls.logs).includes('FIXTURE-ONLY-SESSION-NOT-REAL'),false);
 assert.equal(JSON.stringify(out).includes('FIXTURE-ONLY-SESSION-NOT-REAL'),false);
 assert.equal(e.calls.network.some(c=>/logout|signout/i.test(c.url)),false);
});
test('full module: forced reconnect preserves device fingerprint and commits only replacement credentials',async t=>{
 const e=env({permission:true,fetch:route,storage:{tools:[sibling],sessCache_old:{secret:'OLD-TEST-ONLY'}}});t.after(e.close);
 const id=e.storage._deviceId;
 await e.message({type:'GENZ_CONNECT_EXTENSION',payload:{...payload,forceReauth:true}});await e.call('waitForAssignedTools');
 assert.equal(e.storage._deviceId,id);assert.equal(e.storage.sessCache_old,undefined);assert.equal(e.storage.extensionToken,'AUTH-SYNTHETIC');
 assert.equal(e.calls.network.some(c=>/logout|signout/i.test(c.url)),false);
});

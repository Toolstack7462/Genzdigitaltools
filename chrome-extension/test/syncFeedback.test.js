'use strict';
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const test=require('node:test');const assert=require('node:assert/strict');
const {env,WH,BG}=require('./_accessRegressionHarness');
const ROOT=process.env.EXT_TEST_ROOT||path.join(__dirname,'..');
const POPUP=fs.readFileSync(path.join(ROOT,'js/popup.js'),'utf8');
test('successful assigned-list sync returns an explicit successful result',async()=>{
 const e=env({storage:{extensionToken:'synthetic',apiUrl:'https://fixture.invalid'},api:async()=>({success:true,tools:[WH]}),skipCleanup:true});
 const r=await e.call('checkForUpdates');assert.equal(r?.success,true);
});
test('failed assigned-list sync returns failure, never the success callback shape',async()=>{
 const e=env({storage:{extensionToken:'synthetic',apiUrl:'https://fixture.invalid'},api:async()=>{throw new Error('Failed to fetch');},skipCleanup:true});
 const r=await e.call('checkForUpdates');assert.equal(r?.success,false);
});
async function popup(response,lastError){
 let clicked;let callback;const messages=[];
 const ctx=vm.createContext({syncBtn:{disabled:false,textContent:'',addEventListener:(_,fn)=>{clicked=fn;}},
  chrome:{runtime:{lastError,sendMessage:(_,cb)=>{callback=cb;}}},
  Storage:{get:async()=>({lastSync:null,tools:[]})},
  lastSyncEl:{textContent:''},toolCount:{textContent:''},relativeTime:()=>'',showToast:(m,t)=>messages.push({m,t}),console});
 const start=POPUP.indexOf("syncBtn.addEventListener('click'");const end=POPUP.indexOf("logoutBtn.addEventListener('click'",start);
 vm.runInContext(POPUP.slice(start,end),ctx);await clicked();await callback(response);await new Promise(r=>setImmediate(r));
 return {messages,button:ctx.syncBtn};
}
test('popup does not announce Synced when background returns a failure',async()=>{
 const r=await popup({success:false,message:'Tool sync unavailable'});assert.ok(!r.messages.some(m=>m.t==='success'));assert.equal(r.button.disabled,false);
});
test('popup reports a disconnected message port as failure',async()=>{
 const r=await popup(undefined,{message:'message port closed'});assert.ok(!r.messages.some(m=>m.t==='success'));assert.equal(r.button.disabled,false);
});
test('popup still announces successful completed metadata sync',async()=>{
 const r=await popup({success:true});assert.ok(r.messages.some(m=>m.t==='success'));assert.equal(r.button.disabled,false);
});
test('CHECK_UPDATES transports the actual sync result instead of fabricating success',async()=>{
 const start=BG.indexOf("case 'CHECK_UPDATES':");assert.ok(start>0);
 const code=BG.slice(start+"case 'CHECK_UPDATES':".length,BG.indexOf("return true;",start));
 let response;const ctx=vm.createContext({checkForUpdates:async()=>({success:false,message:'test failure'}),sendResponse:r=>{response=r;}});
 vm.runInContext(code,ctx);await new Promise(r=>setImmediate(r));assert.equal(response?.success,false);
});

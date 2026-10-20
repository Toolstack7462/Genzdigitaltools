'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const ROOT=process.env.EXT_TEST_ROOT||path.resolve(__dirname,'..');
const CODE=fs.readFileSync(path.join(ROOT,'js/bridge.js'),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function setup(){const posts=[],requests=[],listeners=[],pageListeners=[];const attrs={};const win={location:{origin:'https://app.genzdigitalstore.com'},postMessage:m=>posts.push(m),addEventListener:(type,fn)=>{if(type==='message')pageListeners.push(fn);}};
const runtime={id:'test-ext',getManifest:()=>({version:'3.9.34'}),sendMessage:(_,cb)=>requests.push(cb),onMessage:{addListener:fn=>listeners.push(fn)}};
const context=vm.createContext({window:win,document:{documentElement:{setAttribute:(k,v)=>attrs[k]=v},dispatchEvent(){}},chrome:{runtime},CustomEvent:class{},URL,Date,console,Promise,setInterval:()=>1,clearInterval(){}});
return {context,posts,requests,listeners,pageListeners,win,attrs,run:()=>vm.runInContext(CODE,context)};}
test('duplicate bridge injection must not publish a fabricated disconnected READY status',async()=>{
 const e=setup();e.run();e.requests.shift()({connected:true,toolCount:1});await flush();e.run();
 for(const done of e.requests.splice(0))done({connected:true,toolCount:1});await flush();
 assert.ok(e.posts.filter(p=>p.type==='GENZ_BRIDGE_READY').every(p=>p.connected===true));
});
test('late READY response cannot undo a newer successful connected notification',async()=>{
 const e=setup();e.run();const old=e.requests.shift();
 e.listeners.forEach(fn=>fn({type:'GENZ_EXTENSION_CONNECTED',connected:true}));
 old({connected:false,toolCount:0});await flush();
 assert.equal(e.attrs['data-genz-extension-connected'],'true');
 assert.equal(e.posts.some(p=>p.type==='GENZ_BRIDGE_READY'&&p.connected===false),false);
});

test('bridge still refuses commands from a non-dashboard origin',async()=>{
 const e=setup();e.run();e.requests.shift()({connected:true});await flush();
 for(const fn of e.pageListeners)await fn({source:e.win,origin:'https://untrusted.invalid',data:{type:'GENZ_CONNECT_EXTENSION',requestId:'bad',payload:{activationToken:'TEST'}}});
 assert.equal(e.requests.length,0);
});
test('bridge response sanitization retains safe error context and removes nested secrets',async()=>{
 const e=setup();e.run();e.requests.shift()({connected:true});await flush();
 const call=e.pageListeners[0]({source:e.win,origin:e.win.location.origin,data:{type:'GENZ_OPEN_TOOL',requestId:'fixture',payload:{toolId:'abc'}}});
 e.requests.shift()({success:false,error:'sync_failed',status:503,code:'server_error',token:'NEVER-EXPOSE',nested:{cookies:['NEVER-EXPOSE'],password:'NEVER-EXPOSE',reason:'allowed'}});
 await call;const msg=e.posts.find(p=>p.requestId==='fixture');
 assert.equal(msg.status,503);assert.equal(msg.code,'server_error');assert.equal(JSON.stringify(msg).includes('NEVER-EXPOSE'),false);
});

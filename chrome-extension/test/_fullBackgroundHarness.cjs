'use strict';
// Entire background module runs; only Chrome/network/OS boundaries are simulated.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const ROOT = process.env.EXT_TEST_ROOT || path.resolve(__dirname,'..');
const WH = {id:'a'.repeat(24),name:'WriteHuman',domain:'writehuman.ai',targetUrl:'https://writehuman.ai/',credentialVersion:2,hasCredentials:true,assignment:{id:'assignment-original',status:'active',endDate:'2030-10-20'}};
const AUTH = {apiUrl:'https://api.genzdigitalstore.com',extensionToken:'TEST-TOKEN-NOT-REAL',tools:[],toolVersions:{[WH.id]:{version:2}},sessionBundleVersions:{},_deviceId:'test-device'};
function response(body,status=200){return {ok:status>=200&&status<300,status,statusText:String(status),json:async()=>clone(body)};}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const flush=()=>new Promise(r=>setImmediate(r));
function env(options={}) {
 const storage=clone({...AUTH,...options.storage});
 const events={}; const calls={network:[],logs:[],writes:[],removed:[],tabs:[],cookies:[],scripts:[]};
 const event = name => events[name] || (events[name]={listeners:[],addListener(fn){this.listeners.push(fn);},removeListener(fn){this.listeners=this.listeners.filter(x=>x!==fn);}});
 let context;
 const runtime={lastError:undefined,id:'fixture-extension',getManifest:()=>({version:JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'))).version,name:'Test Extension'}),getURL:p=>'chrome-extension://fixture-extension/'+p,onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message'),onMessageExternal:event('external')};
 const complete = (cb,result,error) => queueMicrotask(()=>{runtime.lastError=error?{message:error}:undefined;try{cb&&cb(clone(result));}finally{runtime.lastError=undefined;}});
 const chrome={runtime,storage:{onChanged:event('storage'),local:{
  get(keys,cb){let out={};for(const k of keys===null?Object.keys(storage):[].concat(keys)){if(k in storage)out[k]=clone(storage[k]);}complete(cb,out);},
  set(data,cb){calls.writes.push(clone(data));const fail=options.writeError&&options.writeError(data);if(!fail)Object.assign(storage,clone(data));complete(cb,undefined,fail);},
  remove(keys,cb){for(const k of [].concat(keys)){delete storage[k];calls.removed.push(k);}complete(cb);},
  clear(cb){for(const k of Object.keys(storage))delete storage[k];complete(cb);}
 }},action:{setBadgeText(){},setBadgeBackgroundColor(){}},alarms:{onAlarm:event('alarm'),create(){},clear:async()=>true},
 notifications:{create(){}},permissions:{contains:async()=>options.permission===true},
 tabs:{onUpdated:event('updated'),onRemoved:event('removed'),query:async()=>[],get:async()=>({id:1,url:'https://writehuman.ai/'}),sendMessage:async()=>{},update:async(id,p)=>{calls.tabs.push({id,...p});return {id,...p};},create:async p=>{calls.tabs.push(p);return {id:1,...p};}},
 cookies:{getAll:async()=>[],remove:async d=>{calls.cookies.push(d);return {};},set:async d=>{calls.cookies.push(d);return d;}},
 scripting:{executeScript:async d=>{calls.scripts.push(d);return [];},getRegisteredContentScripts:async()=>[],unregisterContentScripts:async()=>{}},
 management:{getAll:cb=>complete(cb,[])}
 };
 class Logger {debug(m,d){calls.logs.push({level:'debug',m,d:clone(d)});} info(m,d){calls.logs.push({level:'info',m,d:clone(d)});}warn(m,d){calls.logs.push({level:'warn',m,d:clone(d)});}error(m,d){calls.logs.push({level:'error',m,d:clone(d)});}}
 const timers=new Set();
 context=vm.createContext({console:{log(){},warn(){},error(){}},URL,Date,JSON,Map,Set,Promise,Error,TypeError,TextEncoder,AbortController,AbortSignal,crypto:crypto.webcrypto,chrome,Logger,
 getOrchestrator:()=>({}),enableDebugMode(){},disableDebugMode(){},isDebugModeEnabled:()=>false,getLogHistory:()=>[],exportLogs:()=>'',getShieldConfig:()=>({}),isShieldHost:()=>false,idleHostMatch:()=>null,IDLE_TIMEOUT_MINUTES:20,IDLE_TIMEOUT_HOSTS:[],
 setTimeout:(fn,ms,...args)=>{const t=setTimeout(fn,ms,...args);t.unref();timers.add(t);return t;},clearTimeout:t=>clearTimeout(t),setInterval:(fn,ms)=>{const t=setInterval(fn,ms);t.unref();timers.add(t);return t;},clearInterval:t=>clearInterval(t),
 fetch:async(url,init)=>{calls.network.push({url,method:init?.method||'GET',auth:init?.headers?.Authorization});if(options.fetch)return options.fetch(url,init,storage);const endpoint=new URL(url).pathname;if(endpoint.endsWith('/cleanup-manifest'))return response({ok:true,active:[],revoked:[]});return response({success:true,tools:[WH]});}
 });
 const api=fs.readFileSync(path.join(ROOT,'js/api.js'),'utf8').replace(/^export \{[\s\S]*?\};?\s*$/m,'');
 vm.runInContext(api,context,{filename:'js/api.js'});
 const bg=fs.readFileSync(path.join(ROOT,'js/background.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInContext(bg,context,{filename:'js/background.js'});
 const call=(name,...args)=>vm.runInContext(name,context)(...args);
 const message=payload=>new Promise(resolve=>{let sent=false;const send=x=>{if(!sent){sent=true;resolve(clone(x));}};for(const fn of events.message.listeners)fn(payload,{tab:{id:9,url:'https://app.genzdigitalstore.com/client/dashboard'},origin:'https://app.genzdigitalstore.com'},send);});
 return {storage,calls,chrome,context,call,message,eval:s=>vm.runInContext(s,context),close:()=>{for(const t of timers){clearTimeout(t);clearInterval(t);}}};
}
module.exports={env,WH,AUTH,response,deferred,flush,clone,ROOT};

'use strict';
// Executes the exact shipped background functions. Chrome/network boundaries are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = process.env.EXT_TEST_ROOT || path.join(__dirname, '..');
const BG = fs.readFileSync(path.join(ROOT, 'js/background.js'), 'utf8');
function lift(names) {
  return names.map(name => {
    const re = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
    const m = re.exec(BG); assert.ok(m, name + ' exists');
    // All helpers used here have no object-valued default parameter.
    let depth = 0;
    for (let k = BG.indexOf('{', m.index); k < BG.length; k++) {
      if (BG[k] === '{') depth++;
      if (BG[k] === '}' && --depth === 0) return BG.slice(m.index, k + 1);
    }
    throw new Error('Unbalanced function ' + name);
  }).join('\n');
}
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
function matches(pattern, url) {
  return new RegExp('^' + String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url);
}
const FN = ['withSessionMutation', 'sameAuthSession', 'accessError', 'assignedToolEnd', 'normalizeAssignedTools', 'performToolsSync', 'waitForAssignedTools', 'loadCachedData', 'checkForUpdates', '_handleOpenToolInner',
  'getTabBindings','getTabBinding','nextLaunchGeneration','bindTabToTool','pruneTabBindings',
  'getKnownTools','setKnownTools','toKnownEntry','clearCookiesForConfig','clearStorageAndRedirectTabs',
  'cleanupToolSession','runCleanupSync'];
function env(options = {}) {
  const storage = clone(options.storage || {});
  const tabs = clone(options.tabs || []);
  const cookies = clone(options.cookies || []);
  const origins = new Map(); const tabStores = new Map();
  const calls = { api: [], cookies: [], scripts: [], navigation: [], notifications: [], logs: [], events: [] };
  const getStorage = async keys => { const out = {}; for (const k of keys === null ? Object.keys(storage) : [].concat(keys)) if (k in storage) out[k] = clone(storage[k]); return out; };
  function webStorage(map) {
    return {get length(){return map.size;},clear(){map.clear();},getItem(k){return map.get(k) ?? null;},setItem(k,v){map.set(k,String(v));},removeItem(k){map.delete(k);}};
  }
  for (const t of tabs) {
    const origin = new URL(t.url).origin;
    if (!origins.has(origin)) origins.set(origin,new Map([['auth-session','synthetic'],['draft','keep-if-active']]));
    tabStores.set(t.id,new Map([['tab-session','synthetic']]));
  }
  const chrome = {
    action: {setBadgeText(){},setBadgeBackgroundColor(){}},
    alarms: {clear: async()=>true, create(){}},
    notifications: {create(...a){calls.notifications.push(a);}},
    permissions: {contains: async()=>false},
    runtime: {getURL:p=>'chrome-extension://fixture/'+p},
    tabs: {
      query: async q=>clone(!q || !q.url ? tabs : tabs.filter(t=>[].concat(q.url).some(p=>matches(p,t.url)))),
      get: async id=>{const t=tabs.find(t=>t.id===id); if(!t)throw new Error('No tab');return clone(t);},
      update: async(id,p)=>{const t=tabs.find(t=>t.id===id); if(!t)throw new Error('No tab'); Object.assign(t,p);calls.navigation.push({id,...p});calls.events.push('navigate:'+id);return clone(t);},
    },
    cookies: {
      getAll: async({domain})=>clone(cookies.filter(c=>{const h=c.domain.replace(/^\./,'');return h===domain||h.endsWith('.'+domain);})),
      remove: async d=>{calls.cookies.push(clone(d));calls.events.push('cookie:'+d.name);return {name:d.name};},
    },
    scripting: {executeScript: async spec=>{
      calls.scripts.push(spec);
      if (options.beforeScript) await options.beforeScript(spec,storage);
      const tab=tabs.find(t=>t.id===spec.target.tabId); if(!tab)throw new Error('No tab');
      const page=vm.createContext({localStorage:webStorage(origins.get(new URL(tab.url).origin)||new Map()),sessionStorage:webStorage(tabStores.get(tab.id)||new Map()),location:new URL(tab.url)});
      page.__args = spec.args || [];
      const result=vm.runInContext('('+spec.func.toString()+')(...__args)',page);
      calls.events.push('storage:'+tab.id);
      if (options.afterScript) await options.afterScript(spec,storage);
      return [{result}];
    }},
  };
  const logger=Object.fromEntries(['debug','info','warn','error'].map(k=>[k,(m,d)=>calls.logs.push({level:k,message:m,data:clone(d)})]));
  const context=vm.createContext({console,URL,Date,JSON,Set,Map,Promise,Error,chrome,logger,
    getStorage,
    setStorage:async v=>Object.assign(storage,clone(v)),
    removeStorage:async ks=>{for(const k of [].concat(ks))delete storage[k];},
    apiRequest:async p=>{calls.api.push(p);if(options.api)return options.api(p,storage);return {success:true,tools:[]};},
    applyExtensionUpdateInfo:async()=>{},
    notifyDashboardTabs:async()=>{},
    describeError:(e)=>({message:e.message,status:e.status||null,code:e.code||null}),
    getAppOrigin:async()=> 'https://app.genzdigitalstore.com',
    safeHost:u=>new URL(u).hostname,
    normalizeApiBase:u=>u,
    getOriginPattern:u=>new URL(u).origin+'/*',
    sessionCacheKey:id=>'sessCache_'+id,
    setTimeout:()=>0, clearTimeout(){},
  });
  vm.runInContext(`
    let toolsSyncGeneration=0; let toolsSyncPending=null; let connectionPending=null; let sessionMutationQueue=Promise.resolve();
    const domainToolMap=new Map();
    const toolCredentialsCache=new Map();
    const openIntentLock=new Map();
    const SYNC_RETRY_ALARM='retry'; const SYNC_RETRY_BASE_MINUTES=1; const SYNC_RETRY_MAX_MINUTES=15;
    const TAB_BINDINGS_KEY='genzTabBindings'; const LAUNCH_GEN_KEY='genzLaunchGeneration';
    const KNOWN_TOOLS_KEY='cleanupKnownTools'; let cleanupInProgress=false;
    const PROTECTED_HOST_RE=/(^|\\.)genzdigitalstore\\.com$/i;
    function isProtectedHost(h){return !!h && PROTECTED_HOST_RE.test(String(h));}
    `+lift(FN),context);
  if (options.skipCleanup) vm.runInContext('runCleanupSync = async () => {};',context);
  const call=(name,...a)=> {context.__args=a; return vm.runInContext(name+'(...__args)',context);};
  const evaluate=s=>vm.runInContext(s,context);
  return {storage,tabs,cookies,origins,tabStores,calls,context,call,evaluate};
}
const WH={id:'wh',name:'WriteHuman',domain:'writehuman.ai',targetUrl:'https://writehuman.ai/',credentialVersion:2,assignment:{id:'wh-assignment',status:'active',endDate:'2026-10-20'}};
const PLUS={toolId:'plus',cleanup:{name:'ChatGPT Plus',domains:['chatgpt.com'],cookieDomains:['chatgpt.com'],tabUrlPatterns:['*://chatgpt.com/*']}};
const PRO={toolId:'pro',cleanup:{name:'ChatGPT Pro',domains:['chatgpt.com'],cookieDomains:['chatgpt.com'],tabUrlPatterns:['*://chatgpt.com/*']}};
const CLAUDE={toolId:'claude',cleanup:{name:'Claude',domains:['claude.ai'],cookieDomains:['claude.ai'],tabUrlPatterns:['*://claude.ai/*']}};
function scope(...entries) {return {domains:new Set(entries.flatMap(e=>e.cleanup.domains)),patterns:new Set(entries.flatMap(e=>e.cleanup.tabUrlPatterns))};}
module.exports={env,WH,PLUS,PRO,CLAUDE,scope,BG,clone};

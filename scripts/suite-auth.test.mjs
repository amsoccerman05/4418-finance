import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/suite-auth.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const hub='https://team.frc4418.org',pit='https://pit.frc4418.org';
const makeSession=(token='token-1',id='scout')=>({access_token:token,expires_at:Math.floor(Date.now()/1000)+3600,user:{id}});
async function fixture({opened=false,initialError=false,delayFrameLoad=false}={}){
 const listeners={},docListeners={},intervals=[],events=[],frames=[],pending=[],authTokens=[];
 let session=makeSession(),error=initialError,hold=false,removed=0,id=0,frameTimeout,tokenProvider;
 const dispatch=(data,origin=hub,source=transport)=>{for(const f of listeners.message||[])f({data,origin,source});};
 const reply=(data,source)=>{const result={data:{session},error:error?{message:'temporary outage'}:null};if(data.method==='signOut'){session=null;dispatch({protocol:data.protocol,event:'SIGNED_OUT',session:null},hub,source);result.data.session=null;}if(data.method==='signInWithPassword'){error=false;session=makeSession();result.data.session=session;result.error=null;dispatch({protocol:data.protocol,event:'SIGNED_IN',session},hub,source);}const send=()=>dispatch({protocol:data.protocol,id:data.id,result},hub,source);if(hold&&data.method==='getSession')pending.push(send);else queueMicrotask(send);};
 const opener=opened?{closed:false,postMessage(data,origin){assert.equal(origin,hub);reply(data,opener);}}:null;
 const transport={postMessage(data,origin){assert.equal(origin,hub);reply(data,transport);}};
 const frame={contentWindow:transport};
 const window={opener,addEventListener(name,cb){(listeners[name]||=[]).push(cb);}};
 const document={referrer:opened?hub+'/':'',hidden:false,createElement:()=>frame,body:{append(f){frames.push(f);if(!delayFrameLoad)queueMicrotask(()=>f.onload());}},addEventListener(name,cb){(docListeners[name]||=[]).push(cb);}};
 const dataClient={realtime:{setAuth(token){authTokens.push(token);}},removeAllChannels(){removed++;}};
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require:()=>({createClient:(_url,_key,options)=>{tokenProvider=options.accessToken;return dataClient;}}),window,document,location:{origin:pit,search:'',hash:'',pathname:'/'},history:{replaceState(){}},URL,URLSearchParams,crypto:{randomUUID:()=>String(++id)},setTimeout(cb,ms){if(delayFrameLoad&&ms===15000){frameTimeout=cb;return 0;}return setTimeout(cb,ms);},clearTimeout,setInterval(cb){intervals.push(cb);},console});
 const client=module.exports.createSuiteClient('https://fixture.invalid','public-key');
 client.auth.onAuthStateChange((event,next)=>events.push({event,session:next}));
 const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
 return {client,opener,events,frames,authTokens,settle,accessToken:()=>tokenProvider(),timeoutFrame(){frameTimeout();},loadFrame(){frame.onload();},source:transport,dispatch,get removed(){return removed;},setSession(next){session=next;},setError(next){error=next;},setHold(next){hold=next;},release(){for(const send of pending.splice(0))send();},async fire(name){for(const cb of listeners[name]||[])cb();await settle();},async tick(){for(const cb of intervals)cb();await settle();}};
}
test('closing the Hub reconnects via the pinned broker without signing out a valid session',async()=>{const f=await fixture({opened:true});assert.equal(f.frames.length,0);f.opener.closed=true;await f.fire('focus');assert.equal(f.frames.length,1);assert.equal(f.events.some(e=>e.event==='SIGNED_OUT'),false);assert.equal((await f.client.auth.getSession()).data.session.user.id,'scout');await f.client.auth.signOut();assert.equal(f.events.at(-1).session,null);assert.ok(f.removed>0);});
test('direct visits reconcile missed refresh on resume, then confirmed signout',async()=>{const f=await fixture();f.setSession(makeSession('token-2'));await f.fire('focus');assert.equal(f.events.at(-1).event,'TOKEN_REFRESHED');assert.equal(f.events.at(-1).session.access_token,'token-2');f.setSession(null);await f.fire('online');assert.equal(f.events.at(-1).event,'SIGNED_OUT');});
test('transient broker errors do not manufacture signout',async()=>{const f=await fixture();const count=f.events.length;f.setError(true);await f.fire('online');await f.tick();assert.equal(f.events.length,count);assert.equal(f.events.at(-1).session.user.id,'scout');});
test('failed bootstrap can recover through broker login and getSession without reload',async()=>{const f=await fixture({initialError:true});assert.equal(f.events.at(-1).session,null);await f.client.auth.signInWithPassword({email:'fixture@example.test',password:'fixture'});assert.equal((await f.client.auth.getSession()).data.session.user.id,'scout');assert.equal(f.events.at(-1).session.user.id,'scout');});
test('origin and source checks reject forged auth events',async()=>{const f=await fixture();const count=f.events.length;const forged={protocol:'4418-suite-auth-v1',event:'SIGNED_OUT',session:null};f.dispatch(forged,'https://evil.example',f.source);f.dispatch(forged,hub,{});assert.equal(f.events.length,count);});
test('late session reply cannot resurrect a newer signout',async()=>{const f=await fixture();f.setHold(true);const request=f.client.auth.getSession();await f.settle();f.dispatch({protocol:'4418-suite-auth-v1',event:'SIGNED_OUT',session:null});f.release();assert.equal((await request).data.session,null);assert.equal(f.events.at(-1).session,null);assert.equal(f.events.filter(e=>e.event==='TOKEN_REFRESHED').length,0);});
test('shared clients do not add credential persistence or token handoff URLs',()=>{assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie/);assert.match(source,/e\.origin !== hub/);assert.match(source,/e\.source !== \(firstParty \|\| frame\.contentWindow\)/);});

test('a timed-out frame can finish loading and recover without reloading the app',async()=>{const f=await fixture({delayFrameLoad:true});f.timeoutFrame();await f.settle();assert.equal(f.events.at(-1).session,null);f.loadFrame();const result=await f.client.auth.getSession();assert.equal(result.error,null);assert.equal(result.data.session.user.id,'scout');});

test('in-flight data token lookup cannot reuse signed-out or switched-account credentials',async()=>{for(const next of [null,makeSession('other-token','other-account')]){const f=await fixture();f.setHold(true);const lookup=f.accessToken();const rejected=assert.rejects(lookup,/account changed/);await f.settle();f.dispatch({protocol:'4418-suite-auth-v1',event:next?'SIGNED_IN':'SIGNED_OUT',session:next});f.release();await rejected;}});

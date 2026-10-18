import {test,expect} from '@playwright/test';
import {deliveryAllowed,resolveAccount} from '../supabase/functions/finance-notifications/account';
import {render,type Notification,type Email} from '../supabase/functions/finance-notifications/email';
import {processBatch,type Store} from '../supabase/functions/finance-notifications/worker';

// Preserve the Attendance contract discovered in deployed worker v12. The
// renderer/account branch were copied unchanged; the final check uses its RPC.
const n:Notification={
 id:'attendance-notification',recipient_id:'synthetic-recipient',source:'attendance',
 entity_id:null,lease_token:'synthetic-lease',provider_request:null,event:'request_review',
 payload:{meeting:'Build <img src=x onerror=bad> & practice',starts_at:'2026-10-18T18:00:00Z',reason:'PRIVATE REQUEST REASON',student:'PRIVATE STUDENT NAME'},
};
const titles={
 request_review:'Attendance request needs review',
 request_approved:'Your attendance request was approved',
 request_denied:'Your attendance request was denied',
 strike_assigned:'An attendance notice was recorded',
};
function fixture(event='request_review'){
 let queued=true,allowed:unknown=true,frozen:Email|null=null;
 const calls:{path:string;body?:unknown}[]=[],order:string[]=[],outcomes:any[]=[];
 const api=async(path:string,body?:unknown)=>{
  calls.push({path,body});
  if(path==='/auth/v1/admin/users/synthetic-recipient')return {email:'fixture@example.invalid',email_confirmed_at:'2026-01-01'};
  if(path==='/rest/v1/rpc/team_attendance_delivery_allowed')return allowed;
  throw Error('Unexpected API path');
 };
 const s:Store={
  claim:async()=>queued?(queued=false,[{...n,event,provider_request:frozen}]):[],
  account:(id,n)=>resolveAccount(api,id,n),
  prepare:async(_n,email)=>{order.push('prepare');return frozen||(frozen=email);},
  allowed:async n=>{order.push('eligibility');return deliveryAllowed(api,n);},
  finish:async(_n,r)=>{outcomes.push(r);if(r.outcome==='retry')queued=true;},
 };
 return {s,api,calls,order,outcomes,setAllowed:(value:unknown)=>{allowed=value;}};
}

for(const [event,title] of Object.entries(titles)){
 test(`production Attendance renderer preserves ${event} content and token-free route`,()=>{
  const email=render({...n,event},'fixture@example.invalid','sender');
  const url='https://team.frc4418.org/#attendance/'+(event==='strike_assigned'?'strikes':'notices');
  expect(email).toEqual({
   from:'sender',to:['fixture@example.invalid'],subject:title,
   text:`4418 IMPULSE\n${title}\nBuild <img src=x onerror=bad> & practice\nOct 18, 2026, 12:00 PM\nOpen Attendance: ${url}`,
   html:`<!doctype html><html><body style="font-family:Arial,sans-serif"><h1>${title}</h1><p>Build &lt;img src=x onerror=bad&gt; &amp; practice</p><p>Oct 18, 2026, 12:00 PM</p><p><a href="${url}">Open Attendance</a></p><p>Sign in with your Team 4418 account.</p></body></html>`,
  });
  expect(JSON.stringify(email)).not.toContain('PRIVATE');
  expect(email.html).not.toContain('<img');expect(email.html).not.toContain('access_token');
 });
 test(`valid Attendance ${event} passes account and final gate without a profile read`,async()=>{
  const {s,calls,order,outcomes}=fixture(event);let sends=0;
  expect(await processBatch(s,'sender',async(email,key)=>{
   order.push('delivery');sends++;expect(email.subject).toBe(title);expect(key).toBe('impulse-notification/'+n.id);return {outcome:'sent'};
  })).toEqual({processed:1,errors:0});
  expect(sends).toBe(1);expect(order).toEqual(['prepare','eligibility','delivery']);
  expect(calls).toEqual([
   {path:'/auth/v1/admin/users/synthetic-recipient',body:undefined},
   {path:'/rest/v1/rpc/team_attendance_delivery_allowed',body:{notification_id:n.id}},
   {path:'/rest/v1/rpc/team_attendance_delivery_allowed',body:{notification_id:n.id}},
  ]);
  expect(outcomes).toEqual([{outcome:'sent'}]);
 });
}

test('Attendance keeps production fallback meeting/date and unsupported-event rejection',()=>{
 const email=render({...n,payload:{}},'fixture@example.invalid','sender');
 expect(email.text).toContain('\nTeam meeting\n\nOpen Attendance:');
 expect(()=>render({...n,event:'unknown'},'fixture@example.invalid','sender')).toThrow('Unsupported Attendance event');
});
for(const value of [false,null,undefined,'true',1,{allowed:true}]){
 test(`Attendance account and final RPC accept only boolean true: ${JSON.stringify(value)}`,async()=>{
  const {api,setAllowed,s,outcomes}=fixture();setAllowed(value);
  expect((await resolveAccount(api,n.recipient_id,n)).active).toBe(false);
  expect(await deliveryAllowed(api,n)).toBe(false);
  let sends=0;await processBatch(s,'sender',async()=>{sends++;return {outcome:'sent'};});
  expect(sends).toBe(0);expect(outcomes).toEqual([{outcome:'skipped',error_code:'recipient_unavailable'}]);
 });
}
test('Attendance audience revocation during preparation skips before provider handoff',async()=>{
 const {s,setAllowed,order,outcomes}=fixture();const prepare=s.prepare;let sends=0;
 s.prepare=async(n,email)=>{const body=await prepare(n,email);setAllowed(false);return body;};
 await processBatch(s,'sender',async()=>{sends++;return {outcome:'sent'};});
 expect(sends).toBe(0);expect(order).toEqual(['prepare','eligibility']);
 expect(outcomes).toEqual([{outcome:'skipped',error_code:'recipient_no_longer_eligible'}]);
});
test('Attendance frozen retry preserves provider request and checks current audience again',async()=>{
 const {s,calls,outcomes}=fixture('strike_assigned');const requests:{email:Email;key:string}[]=[];
 await processBatch(s,'original sender',async(email,key)=>{requests.push({email,key});return {outcome:'retry'};});
 await processBatch(s,'changed sender',async(email,key)=>{requests.push({email,key});return {outcome:'sent'};});
 expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
 expect(calls.filter(c=>c.path.includes('delivery_allowed'))).toHaveLength(4);
 expect(outcomes.map(x=>x.outcome)).toEqual(['retry','sent']);
});
test('Attendance frozen retry after audience revocation never resends',async()=>{
 const {s,setAllowed,outcomes}=fixture();let sends=0;
 const deliver=async()=>{sends++;return {outcome:'retry' as const};};
 await processBatch(s,'sender',deliver);setAllowed(false);await processBatch(s,'sender',deliver);
 expect(sends).toBe(1);expect(outcomes.map(x=>x.outcome)).toEqual(['retry','skipped']);
});
for(const stage of ['account','eligibility'] as const)test(`Attendance ${stage} RPC failure sends nothing and retains bounded retry behavior`,async()=>{
 const {s,outcomes}=fixture();let sends=0;
 const failingApi=async(path:string)=>{if(path.startsWith('/auth/'))return {email:'fixture@example.invalid',email_confirmed_at:'now'};throw Error('eligibility_http_503');};
 if(stage==='account')s.account=(id,n)=>resolveAccount(failingApi,id,n);
 else s.allowed=n=>deliveryAllowed(failingApi,n);
 expect(await processBatch(s,'sender',async()=>{sends++;return {outcome:'sent'};})).toEqual({processed:0,errors:1});
 expect(sends).toBe(0);expect(outcomes).toEqual([{outcome:'retry',error_code:stage+'_eligibility_http_503'}]);
});

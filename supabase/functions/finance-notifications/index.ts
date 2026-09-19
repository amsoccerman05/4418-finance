import {resolveAccount} from './account.ts';
import {handle,type Store} from './worker.ts';
const url=Deno.env.get('SUPABASE_URL')||'';
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
// Supabase's server-injected credential is used ONLY here, never in Vite.
async function api(path:string,body?:unknown){
 const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw new Error(`${path.startsWith('/auth/')?'auth':path.includes('delivery_allowed')?'eligibility':path.includes('profiles')?'profile':'server'}_http_${r.status}`);
 return r.status===204?null:r.json();
}
const rpc=(name:string,p:unknown)=>api('/rest/v1/rpc/'+name,p);
const store:Store={
 claim:()=>rpc('team_notification_claim',{batch_size:3}),
 account:(id,n)=>resolveAccount(api,id,n),
 prepare:(n,email)=>rpc('team_notification_prepare',{notification_id:n.id,token:n.lease_token,request_body:email}),
 finish:(n,r)=>rpc('team_notification_finish',{notification_id:n.id,token:n.lease_token,outcome:r.outcome,error_code:r.error_code||null,provider_message_id:'provider_message_id' in r?r.provider_message_id||null:null}),
};
Deno.serve(req=>handle(req,{secret:Deno.env.get('NOTIFICATIONS_WORKER_SECRET')||'',from:Deno.env.get('NOTIFICATIONS_FROM')||'',resendKey:Deno.env.get('RESEND_API_KEY')||''},store));

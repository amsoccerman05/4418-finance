import {render,type Notification,type Email} from './email.ts';
import {sendEmail,type DeliveryResult} from './provider.ts';
export type Account={email?:string;email_confirmed_at?:string;banned_until?:string;deleted_at?:string;active:boolean};
export type Store={claim:()=>Promise<Notification[]>;account:(id:string,n?:Notification)=>Promise<Account>;prepare:(n:Notification,email:Email)=>Promise<Email>;finish:(n:Notification,r:DeliveryResult|{outcome:'skipped';error_code:string})=>Promise<void>};
export async function processBatch(store:Store,from:string,deliver:(email:Email,key:string)=>Promise<DeliveryResult>){
 let processed=0,errors=0;
 const safe=(e:unknown)=>e instanceof Error&&/^(server_http_[0-9]{3}|[a-z_]+_http_[0-9]{3})$/.test(e.message)?e.message:'exception';
 for(const n of await store.claim()){
  let stage='account';
  try{
   const a=await store.account(n.recipient_id,n);
   if(!a.active||!a.email||!a.email_confirmed_at||a.deleted_at||(a.banned_until&&Date.parse(a.banned_until)>Date.now())){
    await store.finish(n,{outcome:'skipped',error_code:'recipient_unavailable'});continue;
   }
   // Freeze the entire provider request. Never reuse an idempotency key with a
   // different recipient, sender, subject, or template on a later attempt.
   if(n.provider_request&&n.provider_request.to[0]!==a.email){await store.finish(n,{outcome:'skipped',error_code:'recipient_email_changed'});continue;}
   stage='render';
   const request=n.provider_request||render(n,a.email,from);
   stage='prepare';
   const email=await store.prepare(n,request);
   stage='delivery';
   await store.finish(n,await deliver(email,`impulse-notification/${n.id}`));processed++;
  }catch(e){errors++;
   const code=stage+'_'+safe(e);
   console.error(JSON.stringify({notification_id:n.id,source:n.source,stage,error:code}));
   try{await store.finish(n,{outcome:stage==='render'?'failed':'retry',error_code:code});}catch{console.error(JSON.stringify({notification_id:n.id,stage:'finish',error:'finish_failed'})); /* Lease expiry remains the fallback when the database is unavailable. */}
  }
 }
 return {processed,errors};
}
export async function handle(request:Request,config:{secret:string;from:string;resendKey:string},store:Store,deliver=(e:Email,k:string)=>sendEmail(e,k,config.resendKey)){
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const supplied=request.headers.get('x-worker-secret')||'';
 const digest=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([digest(supplied),digest(config.secret)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
 if(!config.secret||config.secret.length<32||diff)return new Response('Unauthorized',{status:401});
 if(!config.from||!config.resendKey)return new Response('Worker not configured',{status:503});
 try{return Response.json(await processBatch(store,config.from,deliver));}catch{return new Response('Worker unavailable',{status:503});}
}

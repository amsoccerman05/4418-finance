import type {Email} from './email.ts';
export type DeliveryResult={outcome:'sent'|'retry'|'failed';error_code?:string;provider_message_id?:string};
// Provider boundary. Never log provider request bodies, addresses, or secrets.
export async function sendEmail(email:Email,key:string,apiKey:string,fetcher:typeof fetch=fetch):Promise<DeliveryResult>{
 try {
  const r=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(email),signal:AbortSignal.timeout(8000)});
  if(r.ok){const body=await r.json();return typeof body.id==='string'?{outcome:'sent',provider_message_id:body.id}:{outcome:'retry',error_code:'provider_response_incomplete'};}
  return {outcome:r.status===429||r.status===409||r.status>=500?'retry':'failed',error_code:`provider_http_${r.status}`};
 }catch{return {outcome:'retry',error_code:'provider_network_or_timeout'};}
}

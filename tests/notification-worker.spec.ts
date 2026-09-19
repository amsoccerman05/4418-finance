import {test,expect} from '@playwright/test';
import {render,type Notification,type Email} from '../supabase/functions/finance-notifications/email';
import {sendEmail} from '../supabase/functions/finance-notifications/provider';
import {handle,processBatch,type Store} from '../supabase/functions/finance-notifications/worker';
const n:Notification={id:'notification-id',entity_id:'00000000-0000-0000-0000-000000000001',recipient_id:'student',lease_token:'lease',event:'changes_requested',provider_request:null,payload:{po_number:27,vendor:'<img src=x onerror="alert(1)">',amount:123.5,requester:'A & B',area:'Build',revision:2,purpose:'<script>bad</script>',actor:'Coach',explanation:'"fix" <b>this</b>'}};
function store(){let queued=true;const outcomes:any[]=[];let frozen:Email|null=null;const s:Store={claim:async()=>queued?(queued=false,[{...n,provider_request:frozen}]):[],account:async()=>({active:true,email:'test@example.invalid',email_confirmed_at:'2026-01-01'}),prepare:async(_n,e)=>frozen|| (frozen=e),finish:async(_n,r)=>{outcomes.push(r);if(r.outcome==='retry')queued=true;}};return {s,outcomes,requeue:()=>{queued=true;}};}
test('email escapes user-controlled HTML and uses a token-free Finance deep link',()=>{const e=render(n,'test@example.invalid','4418 IMPULSE <notifications@frc4418.org>');expect(e.html).not.toContain('<script>');expect(e.html).not.toContain('<img');expect(e.html).toContain('&lt;script&gt;');expect(e.html).toContain('A &amp; B');expect(e.html).toContain('#po/00000000-0000-0000-0000-000000000001');expect(e.text).toContain('Revision: 2');expect(e.html).not.toContain('access_token');});
test('worker rejects browser invocations before touching database or provider',async()=>{const {s}=store();s.claim=async()=>{throw Error('must not call')};expect((await handle(new Request('https://worker',{method:'POST'}),{secret:'x'.repeat(40),from:'sender',resendKey:'key'},s)).status).toBe(401);});
test('parallel invocations claim once and send once',async()=>{const {s}=store();let count=0;const deliver=async()=>{count++;return {outcome:'sent' as const,provider_message_id:'sent'};};await Promise.all([processBatch(s,'sender',deliver),processBatch(s,'sender',deliver)]);expect(count).toBe(1);});
test('provider failure is recorded, retried with the identical key and frozen payload',async()=>{const {s,outcomes}=store();const sent:{email:Email;key:string}[]=[];await processBatch(s,'original',async(email,key)=>{sent.push({email,key});return {outcome:'retry',error_code:'timeout'};});await processBatch(s,'changed-sender',async(email,key)=>{sent.push({email,key});return {outcome:'sent'};});expect(sent[0]).toEqual(sent[1]);expect(outcomes.map(o=>o.outcome)).toEqual(['retry','sent']);});
for(const account of [{active:false,email:'x@y.invalid',email_confirmed_at:'now'},{active:true,email:'x@y.invalid'}, {active:true,email:'x@y.invalid',email_confirmed_at:'now',banned_until:'2099-01-01'}])test(`unavailable account skipped ${JSON.stringify(account)}`,async()=>{const {s,outcomes}=store();s.account=async()=>account;await processBatch(s,'sender',async()=>{throw Error('must not send')});expect(outcomes[0].outcome).toBe('skipped');});
test('Resend adapter sends idempotency header and classifies transient/permanent errors',async()=>{for(const [status,outcome] of [[200,'sent'],[429,'retry'],[503,'retry'],[422,'failed']] as const){const fetcher:typeof fetch=async(_url,init)=>{expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('stable-key');return new Response(JSON.stringify({id:'provider-id'}),{status});};expect((await sendEmail(render(n,'test@example.invalid','sender'),'stable-key','test-key',fetcher)).outcome).toBe(outcome);}});
test('provider network failure yields bounded retry without exposing raw errors',async()=>{const result=await sendEmail(render(n,'test@example.invalid','sender'),'key','secret',async()=>{throw Error('sensitive provider response')});expect(result).toEqual({outcome:'retry',error_code:'provider_network_or_timeout'});});
test('changed account email does not reuse a frozen delivery for a new address',async()=>{const {s,outcomes,requeue}=store();await processBatch(s,'sender',async()=>({outcome:'retry'}));requeue();s.account=async()=>({active:true,email:'changed@example.invalid',email_confirmed_at:'now'});await processBatch(s,'sender',async()=>{throw Error('must not send')});expect(outcomes.at(-1).outcome).toBe('skipped');});

test('lost delivery acknowledgement retries without another provider email',async()=>{
 const {s,outcomes}=store();const finish=s.finish;let lose=true;let actualEmails=0;const accepted=new Map<string,string>();
 s.finish=async(n,r)=>{if(r.outcome==='sent'&&lose){lose=false;throw Error('DB unavailable');}await finish(n,r);};
 const deliver=async(_e:Email,key:string)=>{if(!accepted.has(key)){actualEmails++;accepted.set(key,'provider-message');}return {outcome:'sent' as const,provider_message_id:accepted.get(key)};};
 await processBatch(s,'sender',deliver);await processBatch(s,'sender',deliver);expect(actualEmails).toBe(1);expect(outcomes.map(o=>o.outcome)).toEqual(['retry','sent']);
});
for(const [severity,prefix] of [['normal','[4418]'],['important','[4418 IMPORTANT]'],['urgent','[4418 URGENT]']])test(`announcement email priority and HTML escaping ${severity}`,()=>{
 const a:Notification={...n,source:'hub',entity_id:null,announcement_id:'announcement',event:'announcement_published',payload:{title:'<img onerror=x>\r\nTeam update',body:'<script>alert(1)</script> & notes',severity,has_image:true}};
 const e=render(a,'test@example.invalid','sender');expect(e.subject.startsWith(prefix)).toBe(true);expect(e.subject).not.toMatch(/[\r\n]/);expect(e.html).not.toContain('<script>');expect(e.html).not.toContain('<img');expect(e.html).toContain('&lt;script&gt;');expect(e.html).toContain('Open Team Hub');expect(e.html).toContain('https://team.frc4418.org/');expect(e.html).not.toContain('access_token');expect(e.html).not.toContain('storage/v1');
});
test('announcement uses existing frozen-payload retry and eligibility skip',async()=>{
 const {s,outcomes}=store();const claim=s.claim;s.claim=async()=>(await claim()).map(x=>({...x,source:'hub',announcement_id:'announcement',entity_id:null,payload:{title:'Announcement',body:'Body',severity:'normal'}}));
 let allowed=true; s.account=async(_id,notification)=>{expect(notification?.source).toBe('hub');return {active:allowed,email:'test@example.invalid',email_confirmed_at:'now'};};
 let sends=0;await processBatch(s,'sender',async()=>{sends++;return {outcome:'retry'};});allowed=false;await processBatch(s,'sender',async()=>{sends++;return {outcome:'sent'};});expect(sends).toBe(1);expect(outcomes.map(x=>x.outcome)).toEqual(['retry','skipped']);
});

test('Hub Auth lookup and eligibility reach prepare without a forbidden profile read',async()=>{
 const {resolveAccount}=await import('../supabase/functions/finance-notifications/account');
 for(const allowed of [true,false]){
 const {s,outcomes}=store();s.claim=async()=>[{...n,source:'hub',entity_id:null,payload:{title:'Test',body:'Body'}}];
 s.account=(id,n)=>resolveAccount(async(path)=>{if(path.startsWith('/auth/'))return {email:'test@example.invalid',email_confirmed_at:'now'};if(path.includes('delivery_allowed'))return allowed;throw Error('profile_http_403');},id,n);
 let prepared=0,sent=0;const prepare=s.prepare;s.prepare=async(n,e)=>{prepared++;return prepare(n,e)};
 await processBatch(s,'sender',async()=>{sent++;return {outcome:'sent',provider_message_id:'one'}});
 expect(prepared).toBe(allowed?1:0);expect(sent).toBe(allowed?1:0);expect(outcomes[0].outcome).toBe(allowed?'sent':'skipped');
 }
});
test('pre-send errors persist sanitized stages and deterministic rendering failures terminate',async()=>{
 for(const stage of ['account','render','prepare']){
 const {s,outcomes}=store();if(stage==='account')s.account=async()=>{throw Error('auth_http_503')};
 if(stage==='render')s.claim=async()=>[{...n,source:'hub',payload:null as any}];
 if(stage==='prepare')s.prepare=async()=>{throw Error('server_http_503')};
 let sent=0;await processBatch(s,'sender',async()=>{sent++;return {outcome:'sent'}});
 expect(sent).toBe(0);expect(outcomes[0].outcome).toBe(stage==='render'?'failed':'retry');expect(outcomes[0].error_code).toMatch(new RegExp('^'+stage+'_'));
 }
});

test('new Finance actions use concise branded messages with actor, reason and PO link',()=>{
 for(const [event,title] of [['cancelled','was canceled'],['approval_recorded','received an approval'],['ready_for_school','ready for school']]){
 const email=render({...n,event,payload:{...n.payload,actor:'Coach',explanation:'Different parts',slot:'po_approver'}},'test@example.invalid','sender');expect(email.subject).toContain(title);expect(email.text).toContain('Coach');expect(email.text).toContain('#po/');if(event==='cancelled')expect(email.text).toContain('Different parts');
 }
 expect(render({...n,event:'approval_needed',payload:{...n.payload,resubmitted:true}},'test@example.invalid','sender').subject).toContain('resubmitted');
});

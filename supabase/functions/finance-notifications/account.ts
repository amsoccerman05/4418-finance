import type {Notification} from './email.ts';
import type {Account} from './worker.ts';
type Api=(path:string,body?:unknown)=>Promise<any>;
export async function resolveAccount(api:Api,id:string,n?:Notification):Promise<Account>{
 const user=await api('/auth/v1/admin/users/'+encodeURIComponent(id));
 // This existing RPC checks active membership and both queued/current audiences.
 // Hub delivery does not require a direct service-role SELECT on shared profiles.
 if(n?.source==='hub')return {...user,active:(await api('/rest/v1/rpc/team_announcement_delivery_allowed',{notification_id:n.id}))===true};
 const profiles=await api('/rest/v1/profiles?id=eq.'+encodeURIComponent(id)+'&select=active,role');
 const p=profiles[0];return {...user,active:!!p?.active&&['student','lead','admin','mentor'].includes(p.role)};
}

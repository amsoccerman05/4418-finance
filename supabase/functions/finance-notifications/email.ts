export type Notification = { id:string; event:string; entity_id:string|null; source?:string; announcement_id?:string|null; recipient_id:string; lease_token:string; payload:Record<string,unknown>; provider_request:Email|null };
export type Email = {from:string;to:string[];subject:string;html:string;text:string};
export const escapeHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function render(n:Notification,to:string,from:string):Email {
 if(n.source==='hub')return renderAnnouncement(n,to,from);
 if(!n.entity_id)throw new Error('Finance entity required');
 const p=n.payload,number=String(p.po_number),revision=String(p.revision);
 const titles:Record<string,string>={approval_needed:'needs approval',approval_remaining:'needs your approval',changes_requested:'changes requested',ready_for_school:'approved — ready for school submission',submitted_to_school:'was submitted to the school',approval_recorded:'received an approval',cancelled:'was canceled'};
 const title=`PO #${number} ${n.event==='approval_needed'&&p.resubmitted?'was resubmitted — needs your approval':titles[n.event]||'updated'}`;
 const subject=`${title} — ${p.vendor??''}`.replace(/[\r\n]/g,' ').slice(0,200);
 const url=`https://finance.frc4418.org/#po/${encodeURIComponent(n.entity_id)}`;
 const rows:[string,unknown][]=[['Vendor',p.vendor],['Amount',new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(p.amount))],['Requester',p.requester],['Area',p.area],['Revision',revision],['Purpose',p.purpose]];
 if(n.event==='approval_recorded'||n.event==='ready_for_school')rows.push(['Approved by',p.actor],['Approval',p.slot==='po_approver'?'Lead Coach':p.slot==='finance_approver'?'Finance Lead':null]);
 if(n.event==='cancelled')rows.push(['Canceled by',p.actor],['Reason',p.explanation]);
 if(n.event==='changes_requested')rows.push(['Requested by',p.actor],['Changes requested',p.explanation]);
 if(n.event==='submitted_to_school')rows.push(['Submitted by',p.actor],['Submitted at',p.submitted_at],['School reference',p.reference]);
 const visible=rows.filter(([,v])=>v!==null&&v!==undefined&&v!=='');
 return {from,to:[to],subject,text:`4418 IMPULSE\n${title}\n${visible.map(([k,v])=>`${k}: ${v}`).join('\n')}\nOpen in Finance: ${url}\nSign in with your Team 4418 account.`,
 html:`<!doctype html><html><body style="margin:0;background:#fbfbfb;font-family:Arial,sans-serif;color:#333333"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #d5d5d5;border-top:4px solid #006bb3;border-radius:12px" cellspacing="0" cellpadding="24"><tr><td><p style="font-weight:bold;color:#171717;letter-spacing:1px">4418 IMPULSE</p><h1 style="font-size:23px;line-height:1.3;color:#171717">${escapeHtml(title)}</h1>${visible.map(([k,v])=>`<p style="font-size:15px;line-height:1.5;overflow-wrap:anywhere"><strong>${escapeHtml(k)}</strong><br>${escapeHtml(v)}</p>`).join('')}<p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#006bb3;color:#ffffff;text-decoration:none;padding:14px 20px;border-radius:6px;font-weight:bold">Open in Finance</a></p><p style="font-size:12px;color:#606060">Sign in with your Team 4418 account. Approval and school submission happen securely in Finance.</p></td></tr></table></td></tr></table></body></html>`};
}

function renderAnnouncement(n:Notification,to:string,from:string):Email {
 const p=n.payload;const priority=p.severity==='urgent'?'URGENT':p.severity==='important'?'IMPORTANT':'';
 const subject=`[4418${priority?' '+priority:''}] ${String(p.title??'Team update')}`.replace(/[\r\n]/g,' ').slice(0,200);
 const url='https://team.frc4418.org/';const color=priority==='URGENT'?'#9c493f':priority==='IMPORTANT'?'#80651f':'#006bb3';
 const imageNote=p.has_image?'An image is attached. View it securely in Team Hub.':'';
 return {from,to:[to],subject,text:`4418 IMPULSE\n${priority||'Team announcement'}\n${p.title}\n${p.body}\n${imageNote}\nOpen Team Hub: ${url}`,
 html:`<!doctype html><html><body style="margin:0;background:#fbfbfb;font-family:Arial,sans-serif;color:#333333"><div style="max-width:560px;margin:24px auto;padding:24px;background:white;border:1px solid #d5d5d5;border-top:4px solid ${color};border-radius:12px"><p style="font-weight:bold">4418 IMPULSE</p><p style="color:${color};font-weight:bold">${priority||'Team announcement'}</p><h1 style="font-size:23px;color:#171717">${escapeHtml(p.title)}</h1><p style="font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(p.body)}</p>${imageNote?`<p>${imageNote}</p>`:''}<p><a href="${url}" style="display:inline-block;background:#006bb3;color:white;text-decoration:none;padding:14px 20px;border-radius:6px;font-weight:bold">Open Team Hub</a></p><p style="font-size:12px;color:#606060">Sign in with your Team 4418 account.</p></div></body></html>`};
}

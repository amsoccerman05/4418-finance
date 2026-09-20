import type { Budget, Category } from './budget-service';
import { money } from './service';
export function object(value: unknown): Record<string, any> {return value && typeof value === 'object' ? value as Record<string, any> : {};}
/** Display aggregation only. Current financial buckets/totals remain server supplied. */
export function spendingMonths(budget: Budget, category = '', today = new Date().toISOString().slice(0,10)) {
 const amounts = new Map<string, number>();let missing=0, outside=0;
 const add = (date: unknown, amount: number) => {
  if(typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date))) {missing++;return;}
  if(date.slice(0,10)>today){outside++;return;}
  const month=date.slice(0,7);amounts.set(month,(amounts.get(month)||0)+Math.round(amount*100));
 };
 for(const po of budget.po_links.filter(p=>p.bucket==='spent'&&(!category||p.category_id===category))){
  const event=budget.history.filter(h=>h.po_id===po.po_id&&h.action==='school_submit'&&h.revision===po.revision).sort((a,b)=>b.id-a.id)[0];
  const after=object(event?.details.after);
  add(after.school_submitted_at || event?.created_at,Number(po.amount));
 }
 for(const e of budget.expenses.filter(e=>!category||e.category_id===category))add(e.occurred_on,Number(e.amount)*(e.kind==='credit'?-1:1));
 return {months:[...amounts].sort(([a],[b])=>a.localeCompare(b)).map(([month,cents])=>({month,amount:cents/100})),missing,outside};
}
export function activityText(h: Budget['history'][number], budget: Budget) {
 const after=object(h.details.after),before=object(h.details.before);
 const category=(id: unknown)=>budget.summary?.categories.find(c=>c.id===id)?.name || 'Unallocated';
 const po=budget.po_links.find(p=>p.po_id===h.po_id);const prefix=po?`PO #${po.po_number}`:'Purchase order';
 switch(h.action){
 case 'approve':return `${prefix} approved`;
 case 'school_submit':return `${prefix} submitted to school`;
 case 'submit':return `${prefix} submitted for review`;
 case 'cancel':return `${prefix} canceled`;
 case 'request_changes':return `${prefix} needs changes`;
 case 'budget_income':return `${after.source || 'Income'} · ${money(Number(after.amount)||0)} ${after.status || 'updated'}`;
 case 'budget_transfer':return `${money(Number(after.amount)||0)} moved ${category(after.from_id)} → ${category(after.to_id)}`;
 case 'budget_category':return `${after.name || 'Category'} ${before.allocation!==undefined&&before.allocation!==after.allocation?'allocation changed':'updated'}`;
 case 'budget_expense':return `${money(Number(after.amount)||0)} expense · ${after.payee || category(after.category_id)}`;
 case 'budget_credit':return `${money(Number(after.amount)||0)} credit recorded`;
 case 'budget_activate':return 'Season budget activated';
 case 'budget_create_season':return 'Draft season created';
 case 'budget_season':return 'Season funding or settings updated';
 case 'budget_close':return 'Season closed';
 case 'budget_po_category':return `${prefix} assigned to ${category(after.category_id)}`;
 default:return null;
 }
}

export function categoryTotals(categories:Category[]) {return categories.reduce((t,c)=>({funded:t.funded+Number(c.funded),requested:t.requested+Number(c.requested),committed:t.committed+Number(c.committed),spent:t.spent+Number(c.spent),available:t.available+Number(c.available)}),{funded:0,requested:0,committed:0,spent:0,available:0});}

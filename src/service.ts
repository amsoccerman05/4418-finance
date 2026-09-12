import { createSuiteClient } from "./suite-auth";
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const client =
  url && key
    ? createSuiteClient(url, key, {
        auth: { storageKey: "4418-finance-auth", flowType: "pkce" },
      })
    : null;
export type PO = {
  id: string;
  po_number: number;
  requester_id: string;
  area_id: string;
  sheet_url: string;
  vendor: string;
  amount: number;
  purpose: string;
  notes: string;
  needed_by: string | null;
  status: string;
  revision: number;
  version: number;
  submitted_at: string | null;
  school_reference: string;
  school_note: string;
  school_submitted_by: string | null;
  school_submitted_at: string | null;
  created_at: string;
};
export type Approval = {
  id: string;
  po_id: string;
  revision: number;
  slot: string;
  action: string;
  actor_id: string;
  acted_at: string;
  explanation: string;
  override_reason: string;
};
export type History = {
  id: number;
  po_id: string | null;
  revision: number;
  action: string;
  actor_id: string;
  created_at: string;
  details: Record<string, unknown>;
};
export type Revision = {
  po_id: string;
  revision: number;
  metadata: PO;
  submitted_by: string;
  submitted_at: string;
};
export type Assignment = {
  id: string;
  user_id: string;
  capability: string;
  active: boolean;
};
export type Context = {
  profile: { id: string; display_name: string; role: string };
  can_create: boolean;
  is_admin: boolean;
  capabilities: string[];
  areas: { id: string; name: string; active: boolean }[];
  people: { id: string; name: string }[];
};
export type Data = {
  context: Context;
  orders: PO[];
  approvals: Approval[];
  history: History[];
  revisions: Revision[];
  assignments: Assignment[];
};
export const label = (s: string) =>
  ({ finance_approver: "Finance Lead", po_approver: "Lead Coach" } as Record<string,string>)[s] || s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
export const when = (s: string | null) =>
  s
    ? new Date(s).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
export function sheetURL(s: string) {
  return /^https:\/\/docs\.google\.com\/(spreadsheets|document)\/d\/[A-Za-z0-9_-]+([/?#][^\s]*)?$/.test(
    s,
  );
}
export async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (!client) throw new Error("Finance connection is not configured.");
  const r = await client.rpc(name, args);
  if (r.error) throw r.error;
  return r.data;
}
export const mutate = (action: string, p: Record<string, unknown>) =>
  rpc("finance_mutate", { action, p });
async function rows<T>(table: string, sort = "id") {
  const result: T[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = client!.from(table).select("*").order(sort);
    if (table === "finance_po_revisions") query = query.order("revision");
    const r = await query.range(offset, offset + 499);
    if (r.error) throw r.error;
    result.push(...(r.data as T[]));
    if (r.data.length < 500) return result;
  }
}
export async function load(): Promise<Data> {
  const context = await rpc("finance_context");
  const [orders, approvals, history, revisions, assignments] =
    await Promise.all([
      rows<PO>("finance_purchase_orders"),
      rows<Approval>("finance_po_approvals"),
      rows<History>("finance_po_history"),
      rows<Revision>("finance_po_revisions", "po_id"),
      rows<Assignment>("finance_assignments"),
    ]);
  return { context, orders, approvals, history, revisions, assignments };
}
export const slots = ["po_approver", "finance_approver"];
export function approved(d: Data, p: PO, slot: string) {
  return (
    !["draft", "cancelled"].includes(p.status) &&
    d.approvals.some(
      (a) =>
        a.po_id === p.id &&
        a.revision === p.revision &&
        a.slot === slot &&
        a.action === "approved",
    )
  );
}
export function needsMe(d: Data, p: PO) {
  return (
    p.status === "awaiting_approval" &&
    p.requester_id !== d.context.profile.id &&
    slots.some((s) => d.context.capabilities.includes(s) && !approved(d, p, s))
  );
}

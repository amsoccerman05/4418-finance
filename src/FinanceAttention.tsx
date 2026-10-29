import { needsMe, canChangePOs, type Data } from "./service";
import { selfApprovalBlocked, selfApprovalGuidance } from "./po-next-step";

/** Show only records already returned by Finance's existing row-level policies. */
export function FinanceAttention({ data, openPO }: { data: Data; openPO: (id: string) => void }) {
  const canSubmit = canChangePOs(data) && (data.context.capabilities.includes("school_submitter") ||
    ["mentor"].includes(data.context.profile.role));
  const attention = data.orders.filter(p => needsMe(data, p) || (p.status === "approved" && canSubmit));
  const blocked = data.orders.filter(p => selfApprovalBlocked(data, p));
  return <section className="panel attention-panel" aria-labelledby="finance-attention-title">
    <h2 id="finance-attention-title">Needs attention</h2>
    {attention.length > 0 ? <ul>{attention.map(p => <li key={p.id}>
      <button className="secondary" onClick={() => openPO(p.id)}>PO {p.po_number} · {p.vendor} · {p.status === "approved" ? "Submit to school" : "Review purchase"}</button>
    </li>)}</ul> : <p>No purchase orders currently need an approval or school submission from you.</p>}
    {blocked.length > 0 && <section aria-labelledby="finance-independent-review-title">
      <h3 id="finance-independent-review-title">Waiting for independent review</h3>
      <p>{selfApprovalGuidance}</p>
      <ul>{blocked.map(p => <li key={p.id}>
        <button className="secondary" onClick={() => openPO(p.id)}>PO {p.po_number} · {p.vendor} · View approval status</button>
      </li>)}</ul>
    </section>}
    <p><a href="#orders">Open purchase orders</a> for all requests you can access, including those waiting on someone else.</p>
  </section>;
}

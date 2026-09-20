import { FinanceExport } from "./FinanceExport";
import { Analytics, RecentActivity } from "./FinanceAnalytics";
import { BudgetRows } from "./FinanceBudgetRows";
import { Fragment, useEffect, useState, type ReactNode, type FormEvent } from "react";
import {
  LayoutDashboard,
  FileText,
  Wallet,
  HandCoins,
  Receipt,
  ClipboardList,
  Settings,
  Menu,
} from "lucide-react";
import { money, label, when, needsMe, type Data, type PO } from "./service";
import {
  loadBudget,
  budgetMutate,
  approvalBudget,
  type Budget,
  type Category,
  type ApprovalBudget,
} from "./budget-service";
import "./budget.css";
export const workspaces = [
  ["dashboard", "Dashboard", LayoutDashboard],
  ["orders", "Purchase Orders", FileText],
  ["budget", "Budget", Wallet],
  ["income", "Income", HandCoins],
  ["expenses", "Expenses", Receipt],
  ["reports", "Reports", ClipboardList],
  ["settings", "Admin / Settings", Settings],
] as const;
export type Workspace = (typeof workspaces)[number][0];
export const currentWorkspace = (): Workspace =>
  location.hash.startsWith("#po/")
    ? "orders"
    : workspaces.find(([id]) => location.hash === `#${id}`)?.[0] || "dashboard";
export function FinanceNav({
  page,
  canBudget,
  admin,
}: {
  page: Workspace;
  canBudget: boolean;
  admin: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <aside className="finance-nav">
      <button
        className="finance-menu"
        aria-expanded={open}
        aria-controls="finance-navigation"
        onClick={() => setOpen(!open)}
      >
        <Menu size={20} /> Finance menu
      </button>
      <nav
        id="finance-navigation"
        aria-label="Finance workspace"
        className={open ? "expanded" : ""}
      >
        {workspaces
          .filter(
            ([id]) =>
              !["budget", "income", "expenses", "reports", "settings"].includes(
                id,
              ) || (id === "settings" ? admin || canBudget : canBudget),
          )
          .map(([id, name, Icon]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={id === page ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <Icon size={19} />
              {name}
            </a>
          ))}
      </nav>
    </aside>
  );
}
type Run = (work: () => Promise<unknown>, message?: string) => Promise<void>;
type Field = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  value?: unknown;
  help?: string;
  advanced?: boolean;
};
const num = (name: string, label: string, value: unknown = 0): Field => ({
  name,
  label,
  type: "number",
  value,
  required: true,
});
const input = (
  name: string,
  label: string,
  value: unknown = "",
  required = false,
  type = "text",
): Field => ({ name, label, value, required, type });
const pick = (
  name: string,
  label: string,
  options: { value: string; label: string }[],
  value: unknown = "",
  required = false,
): Field => ({ name, label, options, value, required });
const options = (values: string[]) =>
  values.map((v) => ({ value: v, label: label(v) }));
function Editor({
  title,
  fields,
  save,
  children,
  submit = "Save",
  initiallyOpen = false,
}: {
  title: string;
  fields: Field[];
  save: (p: Record<string, unknown>) => void;
  children?: ReactNode;
  submit?: string;
  initiallyOpen?: boolean;
}) {
  const [status, setStatus] = useState(String(fields.find(f => f.name === "status")?.value || "expected"));
  const renderField = (f: Field) => (
          <label key={f.name} hidden={(f.name === "expected_on" && status !== "expected") || (f.name === "received_on" && status !== "received")}>
            {f.label}
            {f.options ? (
              <select
                name={f.name}
                onChange={f.name === "status" ? e => setStatus(e.target.value) : undefined}
                defaultValue={String(f.value ?? "")}
                required={f.required}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={f.name}
                type={f.type || "text"}
                defaultValue={String(f.value ?? "")}
                required={f.required || (f.name === "received_on" && status === "received")}
                maxLength={f.name === "reason" ? 2000 : undefined}
                min={f.type === "number" ? 0 : undefined}
                step={
                  f.name === "display_order"
                    ? 1
                    : f.type === "number"
                      ? "0.01"
                      : undefined
                }
              />
            )}
            {f.help && <small>{f.help}</small>}
          </label>
  );
  return (
    <details className="panel budget-editor" open={initiallyOpen || undefined}>
      <summary>{title}</summary>
      <form
        className="form"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const p = Object.fromEntries(new FormData(e.currentTarget));
          save(p);
        }}
      >
        {fields.filter(f=>!f.advanced).map(renderField)}
        {fields.some(f=>f.advanced) && <details className="budget-help"><summary>More options</summary>{fields.filter(f=>f.advanced).map(renderField)}</details>}
        {children}
        <button className="primary">{submit}</button>
      </form>
    </details>
  );
}
function Totals({ b, brief = false }: { b: NonNullable<Budget["summary"]>; brief?: boolean }) {
  return (
    <>
      <dl className="budget-totals">
        {[
          ...(b.season.status === "active" ? [["Requested", b.requested], ["Committed", b.committed], ["Spent · net of credits", b.spent], ["Available funding", b.available]] : []),
          ["Starting funds", b.starting_funds],
          ["Reserve target", b.season.reserve_target],
          ["Received income", b.received],
          ["Restricted received funds", b.restricted],
          ["Expected income · planning only", b.expected],
          ["Allocated", b.allocated],
          ["Unallocated · unrestricted", b.unallocated],
          ...(b.season.status === "closed" ? [["Requested", b.requested], ["Committed", b.committed], ["Spent · net of credits", b.spent], ["Available funding", b.available]] : []),
        ]
          .filter(([name]) => !brief || ["Received income", "Expected income · planning only", "Unallocated · unrestricted", "Available funding", "Reserve target"].includes(String(name)))
          .filter(
            ([name, value]) =>
              value !== 0 ||
              ["Requested", "Committed", "Spent · net of credits", "Starting funds", "Reserve target", "Received income", "Expected income · planning only", "Allocated", "Available funding", "Unallocated · unrestricted"].includes(
                name as string,
              ),
          )
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{money(value as number)}</dd>
            </div>
          ))}
      </dl>
      <details className="budget-help"><summary>What do these amounts mean?</summary><p>Expected income is a plan, not cash. Available funding is what remains after requests, commitments and net spending. Unallocated funds can be assigned to any category; restricted income stays with its category. Reserve is the amount you aim to keep aside.</p></details>
      {(b.available < b.season.reserve_target ||
        b.unallocated < b.season.reserve_target) && (
        <p className="budget-warning">
          Reserve target {money(b.season.reserve_target)} is at risk. This is a
          planning warning, not a spending block.
        </p>
      )}
      {b.unallocated < 0 && (
        <p className="budget-warning">
          Allocations exceed received unrestricted funding by{" "}
          {money(-b.unallocated)}.
        </p>
      )}
    </>
  );
}
export function BudgetWorkspace({
  page,
  data,
  run,
  openPO,
  assignments,
}: {
  page: Workspace;
  data: Data;
  run: Run;
  openPO: (id: string) => void;
  assignments: ReactNode;
}) {
  const [budget, setBudget] = useState<Budget | null>(null),
    [season, setSeason] = useState(""),
    [error, setError] = useState(""),
    [editingIncome, setEditingIncome] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError("");
    setBudget(null);
    void loadBudget(season)
      .then((b) => {
        if (alive) setBudget(b);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [season, data]);
  const s = budget?.summary?.season,
    b = budget?.summary,
    cats = b?.categories || [],
    editable = s && s.status !== "closed";
  const catOptions = [
    { value: "", label: "Unrestricted / Unallocated" },
    ...cats
      .filter((c) => c.active)
      .map((c) => ({ value: c.id, label: c.name })),
  ];
  const why = input("reason", "Reason for change", "", s?.status === "active");
  const save = (action: string, p: Record<string, unknown>) =>
    void run(async () => {
      await budgetMutate(action, {
        season_id: s?.id,
        version: s?.version,
        ...p,
      });
      setBudget(await loadBudget(season));
    }, "Finance updated");
  const categoryFields = (c?: Category): Field[] => [
    input("name", "Category name", c?.name, true),
    {...input("description", "Description", c?.description),advanced:true},
    {...num("display_order", "Display order", c?.display_order || 0),advanced:true},
    num("allocation", "Unrestricted allocation", c?.allocation || 0),
    { ...input(
      "forecast",
      "Forecast (optional)",
      c?.forecast ?? "",
      false,
      "number",
    ),advanced:true},
    {...pick(
      "active",
      "Category state",
      options(["true", "false"]).map((o) => ({
        ...o,
        label: o.value === "true" ? "Active" : "Archived",
      })),
      String(c?.active ?? true),
    ),advanced:true},
    {...why,advanced:s?.status !== "active"},
  ];
  const incomeFields = (i?: Budget["income"][number]): Field[] => [
    input("source", "Source / sponsor", i?.source, true),
    {
      ...input(
        "income_type",
        "Income type",
        i?.income_type || "Sponsorship",
        true,
      ),
      help: "Sponsorship, Grant, Fundraising, School Allocation, Donation, Team Fees, Reimbursement, or your own label.",
    },
    num("amount", "Amount", i?.amount || ""),
    pick(
      "status",
      "Income status",
      options(["expected", "received", "canceled"]),
      i?.status || "expected",
    ),
    input("expected_on", "Expected date", i?.expected_on || "", false, "date"),
    input(
      "received_on",
      "Received date",
      i?.received_on || "",
      false,
      "date",
    ),
    { ...pick("category_id", "Restricted to", [{value:"", label:"No restriction — any category"}, ...catOptions.slice(1)], i?.category_id || ""), help: "Choose a category only if the sponsor requires the money to be used there." },
    input("reference", "Reference", i?.reference),
    input("notes", "Notes", i?.notes),
    ...(i || s?.status === "active" ? [why] : []),
  ];
  const attention = data.orders.filter(p=>needsMe(data,p)||(p.status==='approved'&&(data.context.capabilities.includes('school_submitter')||['mentor','admin'].includes(data.context.profile.role))));
  const exceptions = cats.filter(c=>c.active&&(c.available<0||(c.funded>0&&c.available/c.funded<=0.1)));
  const overdue = budget?.income?.filter(i=>i.status==='expected'&&i.expected_on&&i.expected_on<new Date().toISOString().slice(0,10)) || [];
  const attentionPanel = attention.length > 0 ? <section className="panel attention-panel"><h2>Needs attention</h2><ul>{attention.map((p)=><li key={p.id}><button className="secondary" onClick={()=>openPO(p.id)}>PO {p.po_number} · {p.vendor} · {p.status === 'approved' ? 'Submit to school' : 'Review purchase'}</button></li>)}</ul></section> : null;
  return (
    <section className="budget-workspace" key={`${s?.id}-${s?.version}`}>
      <header className="finance-page-title"><h1>{page === "dashboard" && s ? `${s.name} Finance` : workspaces.find(([id]) => id === page)?.[1]}</h1>{s && <span className={`finance-badge ${s.status}`}>{label(s.status)}</span>}</header>
      {error && <p role="alert">{error}</p>}
      {page === "dashboard" && !budget?.can_manage && attentionPanel}
      {!budget && !error && <p role="status">Loading Finance…</p>}
      {budget &&
        !budget.can_manage &&
        page !== "dashboard" &&
        page !== "settings" && (
          <p>Budget access is available to designated team leadership.</p>
        )}
      {budget?.can_manage && (
        <>
          <label className="season-picker">
            Budget season
            <select
              value={s?.id || ""}
              onChange={(e) => setSeason(e.target.value)}
            >
              <option value="">Choose season</option>
              {budget.seasons.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {label(x.status)}
                </option>
              ))}
            </select>
          </label>
          {!s && (
            <div className="panel">
              <h2>No active budget</h2>
              <p>Create a season budget to start tracking team finances.</p>
              <a href="#budget">Set up a season</a>
            </div>
          )}
          {((page === "budget" && !s) || page === "settings") && (
            <Editor
              title="Create season"
              fields={[
                input("name", "Season name", "", true),
                input("starts_on", "Start date", "", false, "date"),
                input("ends_on", "End date", "", false, "date"),
                num("starting_funds", "Starting / rollover funds"),
                num("reserve_target", "Reserve target"),
                pick("copy_season", "Create from", [
                  { value: "", label: "Blank budget" },
                  ...budget.seasons.map((x) => ({
                    value: x.id,
                    label: `Copy ${x.name}`,
                  })),
                ]),
                pick(
                  "copy_allocations",
                  "Copy allocation amounts?",
                  options(["false", "true"]).map((x) => ({
                    ...x,
                    label:
                      x.value === "true"
                        ? "Yes, copy allocations"
                        : "No, structure and forecasts only",
                  })),
                  "false",
                ),
              ]}
              submit="Create draft season"
              save={(p) =>
                void run(async () => {
                  const id = await budgetMutate("create_season", {
                    ...p,
                    copy_allocations: p.copy_allocations === "true",
                  });
                  setSeason(id);
                }, "Draft season created")
              }
            />
          )}
          {s && (
            <>
              {page !== "dashboard" && <p>
                <strong>{s.name}</strong> · {label(s.status)}
                {s.status === "closed" && " · Historical records are read-only"}
              </p>}
              {page === "dashboard" && <p className="workspace-links"><a href="#budget">{s.status === "draft" ? "Continue budget setup" : "View category balances"}</a><a href="#income">Track income</a><a href="#expenses">Other spending & credits</a></p>}
              {(page === 'dashboard' || page === 'reports') && <Analytics key={s.id} budget={budget} reports={page==='reports'}>{page==='dashboard' && attentionPanel}</Analytics>}
              {page === 'dashboard' && <>
                {(exceptions.length>0||overdue.length>0)&&<section className="panel attention-panel"><h2>Budget watch</h2><ul>{exceptions.map(c=><li key={c.id}><a href="#budget">{c.name}</a> · {c.available<0?`${money(-c.available)} over budget`:`${money(c.available)} available · 10% or less remaining`}</li>)}{overdue.map(i=><li key={i.id}><a href="#income">{i.source}</a> · {money(i.amount)} expected on {i.expected_on}</li>)}</ul><small>Planning reminders only; these do not block purchases.</small></section>}
                <RecentActivity budget={budget}/>
              </>}
              {page === "budget" && (
                <>
                  {s.status === "draft" ? <>
                    <h2>Build your annual budget</h2>
                    <p>Set your funding, plan each category, then review together before activating.</p>
                    <ol className="builder-steps"><li>Funding</li><li>Categories & allocations</li><li>Review</li><li>Activate</li></ol>
                    <section className="panel"><h2>1. Funding</h2>
                      <Editor title="Starting funds & reserve" initiallyOpen fields={[
                        num("starting_funds", "Starting / rollover funds", s.starting_funds),
                        num("reserve_target", "Reserve target", s.reserve_target),
                      ]} submit="Save funding" save={p => save("season", {name:s.name,starts_on:s.starts_on,ends_on:s.ends_on,...p})}>
                        <p>Starting funds are money already on hand. Reserve is what you aim to keep aside.</p>
                      </Editor>
                      <p><a href="#income">Add expected or received income</a> for sponsorships, grants and fundraising.</p>
                    </section>
                    <h2>2. Categories & allocations</h2>
                  </> : <><h2>Category balances</h2><p>See what is planned, reserved and spent across your team.</p></>}
                  {b && <>{s.status === "draft" && <Totals b={b}/>}<p className="allocation-progress"><strong>{money(b.allocated)} allocated</strong> · {money(b.unallocated)} unallocated{s.status === "draft" && " — ready to assign or keep aside"}</p></>}
                  <h2>Categories</h2>
                  <details className="budget-help"><summary>Allocation and restricted funding</summary><p>Your allocation uses general team funds. Received restricted income adds funding only to its assigned category. Team areas describe responsibility, not budget categories.</p></details>
                  {!cats.length && (
                    <p>
                      No categories yet. Build the plan that fits your team.
                    </p>
                  )}
                  {b && cats.length>0 && <BudgetRows b={b} draft={s.status==='draft'} editable={!!editable} save={p=>save('category',p)} editor={c=><Editor title={`Edit ${c.name}`} initiallyOpen fields={categoryFields(c)} save={p=>save('category',{...p,id:c.id,active:p.active==='true'})}/>}/>}
                  {b && s.status !== "draft" && <p className="muted">Category totals exclude uncategorized POs. Season totals on Dashboard include them and unallocated funding.</p>}
                  {editable && (
                    <>
                      <Editor
                        title="Add category"
                        initiallyOpen={s.status === "draft" && cats.length === 0}
                        fields={categoryFields()}
                        save={(p) =>
                          save("category", {
                            ...p,
                            active: p.active === "true",
                          })
                        }
                      />
                      <details className="panel budget-tools" open={s.status === "active" || undefined}><summary>{s.status === "draft" ? "Advanced budget tools" : "Move funds & other actions"}</summary>
                      <Editor
                        title="Move funds"
                        fields={[
                          pick("from_id", "From", catOptions),
                          pick("to_id", "To", catOptions),
                          num("amount", "Amount", ""),
                          input("reason", "Reason", "", true),
                        ]}
                        save={(p) => save("transfer", p)}
                      >
                        <p>
                          Transfers move unrestricted allocations only.
                          Restricted funding stays with its category.
                        </p>
                      </Editor>
                      <Editor
                        title="Assign / change PO category"
                        fields={[
                          pick(
                            "po_id",
                            "Purchase order",
                            [
                              { value: "", label: "Choose purchase order" },
                              ...budget.po_links
                                .concat(
                                  (budget.uncategorized || []).map((p) => ({
                                    ...p,
                                    category_id: null,
                                    bucket: "uncategorized",
                                  })),
                                )
                                .map((p) => ({
                                  value: p.po_id,
                                  label: `PO ${p.po_number} · ${p.vendor}`,
                                })),
                            ],
                            "",
                            true,
                          ),
                          pick(
                            "category_id",
                            "Budget category",
                            catOptions.slice(1),
                            cats.find((c) => c.active)?.id,
                            true,
                          ),
                          input("reason", "Reason", "", true),
                        ]}
                        save={(p) => save("categorize_po", p)}
                      >
                        <p>
                          Only code relevant POs deliberately. Existing history
                          is not assigned automatically, and a PO cannot move
                          between seasons.
                        </p>
                      </Editor>
                      </details>
                    </>
                  )}
                  <details className="panel"><summary>PO budget tracking</summary>
                  {budget.po_links.length === 0 ? (
                    <p>No POs assigned to this season yet.</p>
                  ) : (
                    budget.po_links.map((p) => (
                      <p key={p.po_id}>
                        PO {p.po_number} · {p.vendor} ·{" "}
                        {cats.find((c) => c.id === p.category_id)?.name ||
                          "Uncategorized"}{" "}
                        · {label(p.bucket)} · {money(p.amount)}
                      </p>
                    ))
                  )}</details>
                  {s.status === "draft" && b && <section className="panel budget-review"><h2>3. Review your plan</h2>
                    <p>Check these amounts with your team. Expected income is not available to spend yet.</p>
                    <Totals b={b}/>
                    <p>{cats.filter(c=>c.active).length} active categories · {money(b.unallocated)} remains unallocated.</p>
                    {!cats.length && <p className="budget-warning">You have not added any categories yet.</p>}
                    <h2>4. Activate when ready</h2><p>Activation starts live budget tracking and requires budget categories during Finance approval.</p>
                    <button className="primary" onClick={()=>{if(confirm(`Activate ${s.name} after reviewing its funding and allocations?`))save("activate",{confirmed:true});}}>Activate season</button>
                  </section>}
                </>
              )}
              {page === "income" && (
                <>
                  <dl className="budget-totals"><div><dt>Received income</dt><dd>{money(b?.received || 0)}</dd></div><div><dt>Expected · not yet received</dt><dd>{money(b?.expected || 0)}</dd></div></dl>
                  {!budget.income.length && (
                    <div className="panel">
                      <h2>No income recorded yet</h2>
                      <p>
                        Add sponsorships, grants, fundraising, and other team
                        income here.
                      </p>
                    </div>
                  )}
                  {editable && (
                    <Editor
                      title="+ Add income"
                      fields={incomeFields()}
                      save={(p) => save("income", p)}
                    />
                  )}{" "}
                  {!!budget.income.length && <table className="finance-table"><caption className="sr-only">Income records</caption><thead><tr><th>Source</th><th>Type</th><th>Status</th><th>Amount</th><th>Date</th><th>Restricted to</th><th/></tr></thead><tbody>{budget.income.map(i=><Fragment key={`${i.id}-${s.version}`}><tr><td data-label="Source"><strong>{i.source}</strong></td><td data-label="Type">{i.income_type}</td><td data-label="Status"><span className={`finance-badge ${i.status}`}>{label(i.status)}</span></td><td data-label="Amount">{money(i.amount)}</td><td data-label="Date">{i.status==='received'?i.received_on:i.status==='expected'?i.expected_on||'Not set':'—'}</td><td data-label="Restricted to">{cats.find(c=>c.id===i.category_id)?.name||'No restriction'}</td><td>{editable&&<button aria-expanded={editingIncome===i.id} onClick={()=>setEditingIncome(editingIncome===i.id?null:i.id)}>Edit <span className="sr-only">{i.source}</span></button>}</td></tr>{editingIncome===i.id&&<tr className="editor-row"><td colSpan={7}><Editor title={`Edit ${i.source}`} initiallyOpen fields={incomeFields(i)} save={p=>save('income',{...p,id:i.id})}/></td></tr>}</Fragment>)}</tbody></table>}
                </>
              )}
              {page === "expenses" && (
                <>
                  <p>
                    Purchases made through POs are tracked automatically. Enter
                    only other spending here.
                  </p>
                  <dl className="budget-totals"><div><dt>Total spent · POs and other expenses, after credits</dt><dd>{money(b?.spent || 0)}</dd></div><div><dt>Credits recorded</dt><dd>{money(b?.credits || 0)}</dd></div></dl>
                  {!budget.expenses.length && <h2>No manual expenses</h2>}
                  {s.status === "draft" && <p>Activate the budget before recording expenses or credits.</p>}
                  {editable &&
                    s.status === "active" &&
                    (["expense", "credit"] as const).map((kind) => (
                      <Editor
                        key={kind}
                        title={
                          kind === "expense"
                            ? "+ Add expense"
                            : "+ Add credit"
                        }
                        fields={[
                          pick(
                            "category_id",
                            "Budget category",
                            catOptions.slice(1),
                            cats.find((c) => c.active)?.id,
                            true,
                          ),
                          num("amount", "Amount", ""),
                          input(
                            "payee",
                            "Vendor / payee",
                            "",
                            kind === "expense",
                          ),
                          input("occurred_on", "Date", "", true, "date"),
                          input("reference", "Reference"),
                          ...(kind === "credit"
                            ? [
                                pick("po_id", "Related PO (optional)", [
                                  { value: "", label: "None" },
                                  ...budget.po_links.map((p) => ({
                                    value: p.po_id,
                                    label: `PO ${p.po_number} · ${p.vendor}`,
                                  })),
                                ]),
                                pick(
                                  "expense_id",
                                  "Related manual expense (optional)",
                                  [
                                    { value: "", label: "None" },
                                    ...budget.expenses
                                      .filter((e) => e.kind === "expense")
                                      .map((e) => ({
                                        value: e.id,
                                        label: `${e.payee} · ${money(e.amount)}`,
                                      })),
                                  ],
                                ),
                              ]
                            : []),
                          input("reason", "Reason / notes", "", true),
                        ]}
                        save={(p) => save(kind, p)}
                      />
                    ))}
                  {!!budget.expenses.length && <table className="finance-table"><caption className="sr-only">Manual expenses and credits</caption><thead><tr><th>Type</th><th>Payee</th><th>Category</th><th>Date</th><th>Amount</th><th>Reason</th></tr></thead><tbody>{budget.expenses.map(e=><tr key={e.id}><td data-label="Type"><span className={`finance-badge ${e.kind}`}>{e.kind==='credit'?'Credit / refund':'Manual expense'}</span></td><td data-label="Payee">{e.payee||'—'}</td><td data-label="Category">{cats.find(c=>c.id===e.category_id)?.name}</td><td data-label="Date">{e.occurred_on}</td><td data-label="Amount">{money(e.amount)}</td><td data-label="Reason">{e.reason}</td></tr>)}</tbody></table>}
                </>
              )}
              {page === 'reports' && <FinanceExport key={s.id} season={s} />}
              {(page === "reports" || page === "budget") && (
                <details className="panel">
                  <summary>Budget history</summary>
                  {budget.history.map((h) => (
                    <details key={h.id}>
                      <summary>
                        {label(h.action.replace("budget_", ""))} ·{" "}
                        {h.actor_name} · {when(h.created_at)}
                      </summary>
                      <p>{h.details.reason}</p>
                      <pre>
                        {JSON.stringify(
                          { before: h.details.before, after: h.details.after },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ))}
                </details>
              )}
              {page === "settings" && editable && (
                <>
                  <Editor
                    title="Amend season settings"
                    fields={[
                      input("name", "Season name", s.name, true),
                      input(
                        "starts_on",
                        "Start date",
                        s.starts_on,
                        false,
                        "date",
                      ),
                      input("ends_on", "End date", s.ends_on, false, "date"),
                      num(
                        "starting_funds",
                        "Starting / rollover funds",
                        s.starting_funds,
                      ),
                      num("reserve_target", "Reserve target", s.reserve_target),
                      why,
                    ]}
                    save={(p) => save("season", p)}
                  />
                  <Editor
                    title="Close season"
                    fields={[input("reason", "Closing reason", "", true)]}
                    save={(p) => {
                      if (
                        confirm(
                          `Close ${s.name}? Its financial records will become read-only.`,
                        )
                      )
                        save("close", p);
                    }}
                    submit="Close season"
                  >
                    <p>
                      Resolve unfinished POs first (including drafts and changes
                      requested). No automatic rollover is created.
                    </p>
                  </Editor>
                </>
              )}
            </>
          )}
          {page === "settings" && budget.can_classify && (
            <>
              <details className="panel">
                <summary>Budget access history</summary>
                {budget.history
                  .filter((h) => h.action === "budget_classify_position")
                  .map((h) => (
                    <p key={h.id}>
                      {h.actor_name} · {when(h.created_at)} · {h.details.reason}
                      <br />
                      {JSON.stringify(h.details.after)}
                    </p>
                  ))}
              </details>
              <Editor
                title="Budget leadership positions"
                fields={[
                  pick(
                    "position_key",
                    "Team position",
                    budget.positions.map((p) => ({
                      value: p.key,
                      label: `${p.name}${p.enabled ? " · Budget access" : ""}`,
                    })),
                  ),
                  pick(
                    "enabled",
                    "Budget access",
                    options(["true", "false"]).map((o) => ({
                      ...o,
                      label: o.value === "true" ? "Allow" : "Remove",
                    })),
                    "true",
                  ),
                  input("reason", "Reason", "", true),
                ]}
                save={(p) =>
                  save("classify_position", {
                    ...p,
                    enabled: p.enabled === "true",
                    expected_enabled: budget.positions.find(
                      (x) => x.key === p.position_key,
                    )?.enabled,
                  })
                }
              >
                <p>
                  This grants budget management only. It never grants PO
                  approvals or other app permissions.
                </p>
              </Editor>
            </>
          )}
        </>
      )}
      {page === "settings" && data.context.is_admin && (
        <section className="panel">
          <h2>Finance assignments</h2>
          {assignments}
        </section>
      )}
      {page === "dashboard" && !budget?.can_manage && (
        <p>
          Your purchase orders and their approval history are available in
          Purchase Orders.
        </p>
      )}
    </section>
  );
}
export function ApprovalCoding({ po }: { po: PO }) {
  const [b, setB] = useState<ApprovalBudget | null>(null),
    [category, setCategory] = useState(""),
    [error, setError] = useState(""),
    [editingIncome, setEditingIncome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void approvalBudget(po.id)
      .then((x) => {
        if (live) {
          setB(x);
          setCategory(x.category_id || "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [po.id, po.version]);
  const c = b?.categories?.find((c) => c.id === category);
  return (
    <section className="approval-budget">
      {error && (
        <p role="alert">
          Budget preview unavailable: {error}. Refresh before approving.
        </p>
      )}
      {!b && !error && <p>Loading budget preview…</p>}
      {b?.required && (
        <>
          <label>
            Budget category
            <select
              name="category_id"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Choose category for approval</option>
              {b.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {c && (
            <>
              <p>
                Allocation {money(c.funded)} · Requested {money(c.requested)} ·
                Committed {money(c.committed)} · Spent {money(c.spent)}
              </p>
              <p>
                Category available {money(c.available)} · This PO{" "}
                {money(po.amount)} · After approval{" "}
                <strong>{money(c.projected_available)}</strong>
              </p>
              {b.category_id === category && (
                <p className="muted">
                  This PO is already included in Requested; approval does not
                  reserve it twice.
                </p>
              )}
              {c.projected_available < 0 && (
                <p role="alert" className="budget-warning">
                  This PO exceeds the {c.name} available budget by{" "}
                  {money(-c.projected_available)}. An authorized approver may
                  continue with an explanation.
                </p>
              )}
            </>
          )}
          <label>
            Budget override explanation (required when over budget)
            <textarea name="budget_reason" maxLength={2000} />
          </label>
        </>
      )}
      {b && !b.required && (
        <p className="muted">
          No active budget season. Existing PO approval remains available.
        </p>
      )}
    </section>
  );
}

import { useEffect, useState, type ReactNode, type FormEvent } from "react";
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
}: {
  title: string;
  fields: Field[];
  save: (p: Record<string, unknown>) => void;
  children?: ReactNode;
  submit?: string;
}) {
  return (
    <details className="panel budget-editor">
      <summary>{title}</summary>
      <form
        className="form"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const p = Object.fromEntries(new FormData(e.currentTarget));
          save(p);
        }}
      >
        {fields.map((f) => (
          <label key={f.name}>
            {f.label}
            {f.options ? (
              <select
                name={f.name}
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
                required={f.required}
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
        ))}
        {children}
        <button className="primary">{submit}</button>
      </form>
    </details>
  );
}
function Totals({ b }: { b: NonNullable<Budget["summary"]> }) {
  return (
    <>
      <dl className="budget-totals">
        {[
          ["Starting funds", b.starting_funds],
          ["Received income", b.received],
          ["Restricted received funds", b.restricted],
          ["Expected income · planning only", b.expected],
          ["Allocated", b.allocated],
          ["Unallocated · unrestricted", b.unallocated],
          ["Requested", b.requested],
          ["Committed", b.committed],
          ["Spent · net of credits", b.spent],
          ["Available funding", b.available],
        ]
          .filter(
            ([name, value]) =>
              value !== 0 ||
              ["Available funding", "Unallocated · unrestricted"].includes(
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
      <p className="muted">
        Available funding is received resources minus requested purchases,
        commitments and net spending. Expected income is not available cash.
        Available funding includes category-restricted funds; Unallocated is
        unrestricted.
      </p>
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
    [error, setError] = useState("");
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
    input("description", "Description", c?.description),
    num("display_order", "Display order", c?.display_order || 0),
    num("allocation", "Unrestricted allocation", c?.allocation || 0),
    input(
      "forecast",
      "Forecast (optional)",
      c?.forecast ?? "",
      false,
      "number",
    ),
    pick(
      "active",
      "Category state",
      options(["true", "false"]).map((o) => ({
        ...o,
        label: o.value === "true" ? "Active" : "Archived",
      })),
      String(c?.active ?? true),
    ),
    why,
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
      "Received date (required when received)",
      i?.received_on || "",
      false,
      "date",
    ),
    pick("category_id", "Restricted to", catOptions, i?.category_id || ""),
    input("reference", "Reference", i?.reference),
    input("notes", "Notes", i?.notes),
    why,
  ];
  return (
    <section className="budget-workspace" key={`${s?.id}-${s?.version}`}>
      <h1>{workspaces.find(([id]) => id === page)?.[1]}</h1>
      {error && <p role="alert">{error}</p>}
      {page === "dashboard" && (
        <section className="panel">
          <h2>Your next actions</h2>
          {data.orders
            .filter(
              (p) =>
                needsMe(data, p) ||
                (p.status === "approved" &&
                  (data.context.capabilities.includes("school_submitter") ||
                    ["mentor", "admin"].includes(data.context.profile.role))),
            )
            .map((p) => (
              <button
                key={p.id}
                className="secondary"
                onClick={() => openPO(p.id)}
              >
                PO {p.po_number} · {p.vendor}
              </button>
            ))}
          {!data.orders.some(
            (p) =>
              needsMe(data, p) ||
              (p.status === "approved" &&
                (data.context.capabilities.includes("school_submitter") ||
                  ["mentor", "admin"].includes(data.context.profile.role))),
          ) && <p>No purchase orders need your action.</p>}
          <a href="#orders">View purchase orders</a>
        </section>
      )}
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
          {(page === "budget" || page === "settings") && (
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
              <p>
                <strong>{s.name}</strong> · {label(s.status)}
                {s.status === "closed" && " · Historical records are read-only"}
              </p>
              {["dashboard", "budget", "reports"].includes(page) && b && (
                <Totals b={b} />
              )}
              {page === "dashboard" && (
                <section className="panel">
                  <h2>Recent Finance activity</h2>
                  {budget.history.slice(0, 8).map((h) => (
                    <p key={h.id}>
                      {label(h.action.replace("budget_", ""))} · {h.actor_name}{" "}
                      · {when(h.created_at)}
                    </p>
                  ))}
                  {budget.history.length === 0 && (
                    <p>No budget activity yet.</p>
                  )}
                </section>
              )}
              {page === "budget" && (
                <>
                  {s.status === "draft" && (
                    <section className="panel">
                      <h2>Ready to activate?</h2>
                      <p>
                        Review starting funds, received and expected income,
                        allocations, unallocated funds and reserve above.
                        Activation makes this the operational season; another
                        active season must first be closed.
                      </p>
                      <button
                        className="primary"
                        onClick={() => {
                          if (
                            confirm(
                              `Activate ${s.name} after reviewing its funding and allocations?`,
                            )
                          )
                            save("activate", { confirmed: true });
                        }}
                      >
                        Activate season
                      </button>
                    </section>
                  )}
                  <h2>Categories</h2>
                  <p className="muted">
                    Your unrestricted allocation plus restricted received funds
                    equals the category’s funded allocation. Functional team
                    areas remain separate.
                  </p>
                  {!cats.length && (
                    <p>
                      No categories yet. Build the plan that fits your team.
                    </p>
                  )}
                  {cats.map((c) => (
                    <article className="panel" key={`${c.id}-${s.version}`}>
                      <h3>
                        {c.name}
                        {!c.active && " · Archived"}
                      </h3>
                      <p>{c.description}</p>
                      <dl className="budget-totals compact">
                        {[
                          ["Funded allocation", c.funded],
                          ["Restricted received", c.restricted],
                          ["Requested", c.requested],
                          ["Committed", c.committed],
                          ["Spent", c.spent],
                          ["Category available", c.available],
                          ...(c.forecast === null
                            ? []
                            : [["Forecast", c.forecast]]),
                        ].map(([k, v]) => (
                          <div key={String(k)}>
                            <dt>{k}</dt>
                            <dd>{money(v as number)}</dd>
                          </div>
                        ))}
                      </dl>
                      {editable && (
                        <Editor
                          title={`Edit ${c.name}`}
                          fields={categoryFields(c)}
                          save={(p) =>
                            save("category", {
                              ...p,
                              id: c.id,
                              active: p.active === "true",
                            })
                          }
                        />
                      )}
                    </article>
                  ))}
                  {editable && (
                    <>
                      <Editor
                        title="Add category"
                        fields={categoryFields()}
                        save={(p) =>
                          save("category", {
                            ...p,
                            active: p.active === "true",
                          })
                        }
                      />
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
                    </>
                  )}
                  <h2>PO budget tracking</h2>
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
                  )}
                </>
              )}
              {page === "income" && (
                <>
                  <p>
                    Expected income supports planning. Only received income adds
                    available funding.
                  </p>
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
                      title="Add income"
                      fields={incomeFields()}
                      save={(p) => save("income", p)}
                    />
                  )}{" "}
                  {budget.income.map((i) => (
                    <article className="panel" key={`${i.id}-${s.version}`}>
                      <h3>
                        {i.source} · {money(i.amount)}
                      </h3>
                      <p>
                        {i.income_type} · {label(i.status)} ·{" "}
                        {i.category_id
                          ? `Restricted to ${cats.find((c) => c.id === i.category_id)?.name}`
                          : "Unrestricted"}
                      </p>
                      <p>{i.notes}</p>
                      {editable && (
                        <Editor
                          title={`Edit ${i.source}`}
                          fields={incomeFields(i)}
                          save={(p) => save("income", { ...p, id: i.id })}
                        />
                      )}
                    </article>
                  ))}
                </>
              )}
              {page === "expenses" && (
                <>
                  <p>
                    Purchases made through POs are tracked automatically. Enter
                    only other spending here.
                  </p>
                  {!budget.expenses.length && <h2>No manual expenses</h2>}
                  {editable &&
                    s.status === "active" &&
                    (["expense", "credit"] as const).map((kind) => (
                      <Editor
                        key={kind}
                        title={
                          kind === "expense"
                            ? "Record manual expense"
                            : "Record refund / credit"
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
                  {budget.expenses.map((e) => (
                    <article className="panel" key={e.id}>
                      <h3>
                        {e.kind === "credit"
                          ? "Refund / credit"
                          : "Manual expense"}{" "}
                        · {money(e.amount)}
                      </h3>
                      <p>
                        {e.payee} · {e.occurred_on} ·{" "}
                        {cats.find((c) => c.id === e.category_id)?.name}
                      </p>
                      <p>{e.reason}</p>
                    </article>
                  ))}
                </>
              )}
              {page === "reports" && (
                <>
                  <p>
                    Reports and exports will use the same authoritative Finance
                    records and totals shown here. Charts and Excel export are
                    planned for later phases.
                  </p>
                  <h2>Budget history</h2>
                </>
              )}
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
    [error, setError] = useState("");
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

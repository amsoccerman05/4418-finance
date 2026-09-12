import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  client,
  load,
  mutate,
  label,
  money,
  when,
  sheetURL,
  slots,
  approved,
  needsMe,
  type Data,
  type PO,
} from "./service";
import "./style.css";
import "./finance.css";
const fields = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
};
const err = (e: unknown) =>
  e && typeof e === "object" && "message" in e
    ? String(e.message)
    : "Unable to complete this action.";
function bounded<T>(work: PromiseLike<T>, message: string, ms = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(work).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
const loadFinance = () => bounded(load(), "Finance data timed out. Reload to try again.");
type Run = (work: () => Promise<unknown>, message?: string) => Promise<void>;
function App() {
  const [data, setData] = useState<Data | null>(null),
    [signed, setSigned] = useState(false),
    [loading, setLoading] = useState(!!client),
    [denied, setDenied] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [editing, setEditing] = useState<PO | "new" | null>(null),
    [admin, setAdmin] = useState(false),
    [recovery, setRecovery] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!client) return;
    let mounted = true;
    const receive = (event: string, session: unknown) => {
      const gen = ++generation.current;
      setSigned(!!session);
      setData(null);
      setDenied(false);
      setSelected(null);
      setEditing(null);
      setError("");
      setLoading(!!session);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (session)
        setTimeout(() => {
          void loadFinance()
            .then((d) => {
              if (mounted && gen === generation.current) setData(d);
            })
            .catch((e) => {
              if (mounted && gen === generation.current) {
                setDenied(e?.code === "42501" || e?.status === 403);
                setError(err(e));
              }
            })
            .finally(() => {
              if (mounted && gen === generation.current) setLoading(false);
            });
        }, 0);
    };
    let eventReceived = false;
    const sub = client.auth.onAuthStateChange((event, session) => {
      eventReceived = true;
      receive(event, session);
    });
    // Do not rely on an auth event being emitted: failed broker bootstrap must
    // also settle the initial screen, and stale session reads must not win.
    void bounded(client.auth.getSession(), "Team sign-in timed out. Reload or open Team Hub.")
      .then(({ data, error }) => {
        if (!mounted || eventReceived) return;
        if (error) throw error;
        receive("INITIAL_SESSION", data.session);
      })
      .catch((e) => {
        if (!mounted || eventReceived) return;
        setLoading(false);
        setError(err(e));
      });
    return () => {
      mounted = false;
      generation.current++;
      sub.data.subscription.unsubscribe();
    };
  }, []);
  async function run(work: () => Promise<unknown>, text = "Saved") {
    setBusy(true);
    setError("");
    setMessage("");
    const gen = generation.current;
    try {
      await work();
      if (signed) {
        const d = await loadFinance();
        if (gen === generation.current) setData(d);
      }
      if (gen === generation.current) setMessage(text);
    } catch (e) {
      if (gen === generation.current) setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  const po = data?.orders.find((p) => p.id === selected);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark">
              <img
                src="/branding/4418-impulse-emblem.png"
                alt="Team 4418 IMPULSE"
              />
            </span>
            <div>
              4418<span>FINANCE</span>
            </div>
          </div>
          <a className="suite-home" href="https://team.frc4418.org">
            Team Hub / Home
          </a>
          <select
            aria-label="Team 4418 apps"
            value="finance"
            onChange={(e) => {
              location.href = e.target.value;
            }}
          >
            <option value="finance">Finance</option>
            <option value="https://team.frc4418.org">Team Hub</option>
            <option value="https://inventory.frc4418.org">Inventory</option>
            <option value="https://pit.frc4418.org">Pit Operations</option>
            <option value="https://team.frc4418.org/#attendance">
              Attendance
            </option>
          </select>
          {signed && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await client!.auth.signOut();
                  if (r.error) throw r.error;
                }, "Signed out")
              }
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="main">
        <div className="page-heading">
          <div>
            <span className="eyebrow">TEAM 4418 / FINANCE</span>
            <h1>Purchase orders</h1>
            <p>
              The Google Sheet is your PO. Finance keeps its approvals moving.
            </p>
          </div>
          {data?.context.can_create && (
            <button className="primary" onClick={() => setEditing("new")}>
              New purchase order
            </button>
          )}
        </div>
        {!client ? (
          <div className="panel">
            Finance setup is pending. Configure the shared public Supabase
            environment after schema review.
          </div>
        ) : (
          <>
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            {message && <p role="status">{message}</p>}
            {loading ? (
              <p role="status">Loading Finance…</p>
            ) : !signed ? (
              <form
                className="panel form auth"
                onSubmit={(e) => {
                  const f = fields(e);
                  void run(async () => {
                    const r = await client!.auth.signInWithPassword({
                      email: f.email,
                      password: f.password,
                    });
                    if (r.error) throw r.error;
                  }, "");
                }}
              >
                <h2>Team sign-in</h2>
                <p>Use your existing Team 4418 account.</p>
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Sign in
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => {
                    const form = e.currentTarget.form!;
                    const email = (
                      form.elements.namedItem("email") as HTMLInputElement
                    ).value;
                    void run(async () => {
                      if (!email) throw new Error("Enter your email first.");
                      const r = await client!.auth.resetPasswordForEmail(
                        email,
                        {
                          redirectTo: location.origin + "/?password-reset=1",
                        },
                      );
                      if (r.error) throw r.error;
                    }, "If eligible, a reset email has been sent.");
                  }}
                >
                  Reset password
                </button>
              </form>
            ) : recovery ? (
              <form
                className="panel form"
                onSubmit={(e) => {
                  const f = fields(e);
                  void run(async () => {
                    const r = await client!.auth.updateUser({
                      password: f.password,
                    });
                    if (r.error) throw r.error;
                    setRecovery(false);
                  }, "Password updated");
                }}
              >
                <h2>Set your password</h2>
                <label>
                  New password
                  <input
                    name="password"
                    type="password"
                    minLength={8}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button className="primary">Save password</button>
              </form>
            ) : data ? (
              <>
                <div className="toolbar">
                  <span>Welcome, {data.context.profile.display_name}</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(async () => {}, "Refreshed")}
                  >
                    Refresh
                  </button>
                  {data.context.is_admin && (
                    <button
                      className="secondary"
                      onClick={() => setAdmin(true)}
                    >
                      Finance assignments
                    </button>
                  )}
                </div>
                <Overview data={data} onOpen={setSelected} />
              </>
            ) : (
              <div className="panel">
                <h2>{denied ? "Finance access denied" : "Finance could not load"}</h2>
                <p>{denied ? "Your account does not have an active Finance profile. Contact a mentor." : "The Finance service is unavailable. Reload to try again."}</p>
                <button onClick={() => location.reload()}>Reload Finance</button>
              </div>
            )}
            {data && (po || editing || admin) && (
              <Dialog
                title={
                  editing
                    ? "Purchase order details"
                    : admin
                      ? "Finance assignments"
                      : `PO ${po?.po_number}`
                }
                busy={busy}
                onClose={() => {
                  setSelected(null);
                  setEditing(null);
                  setAdmin(false);
                }}
              >
                {error && (
                  <p className="alert" role="alert">
                    {error}
                  </p>
                )}
                {message && <p role="status">{message}</p>}
                <fieldset disabled={busy} className="unboxed">
                  {editing ? (
                    <POForm
                      data={data}
                      po={editing === "new" ? undefined : editing}
                      run={run}
                      done={(id) => {
                        setEditing(null);
                        setSelected(id);
                      }}
                    />
                  ) : admin ? (
                    <Assignments data={data} run={run} />
                  ) : (
                    po && (
                      <Detail
                        key={`${po.id}-${po.version}`}
                        data={data}
                        po={po}
                        run={run}
                        edit={() => setEditing(po)}
                      />
                    )
                  )}
                </fieldset>
              </Dialog>
            )}
          </>
        )}
        <footer>
          4418 IMPULSE · Google Sheets remains the authoritative purchase order.
        </footer>
      </main>
    </>
  );
}
function Dialog({
  title,
  children,
  busy,
  onClose,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current!.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="toolbar">
        <h2>{title}</h2>
        <button className="secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Overview({
  data: d,
  onOpen,
}: {
  data: Data;
  onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [area, setArea] = useState(""),
    [vendor, setVendor] = useState(""),
    [requester, setRequester] = useState(""),
    [approval, setApproval] = useState("");
  const privileged = d.context.is_admin || d.context.capabilities.length > 0;
  const who = (id: string) =>
    d.context.people.find((x) => x.id === id)?.name || "Team member";
  const counts = [
    [
      "Needs your approval",
      d.orders.filter((p) => needsMe(d, p)).length,
      "mine",
    ],
    [
      "Waiting on other approval",
      d.orders.filter((p) => p.status === "awaiting_approval" && !needsMe(d, p))
        .length,
      "waiting",
    ],
    [
      "Ready for school",
      d.orders.filter((p) => p.status === "approved").length,
      "ready",
    ],
    [
      "Submitted",
      d.orders.filter((p) => p.status === "submitted_to_school").length,
      "submitted",
    ],
  ];
  const queue = d.orders
    .filter(
      (p) =>
        (!status || p.status === status) &&
        (!area || p.area_id === area) &&
        (!vendor || p.vendor === vendor) &&
        (!requester || p.requester_id === requester) &&
        (!approval ||
          (approval === "mine"
            ? needsMe(d, p)
            : approval === "waiting"
              ? p.status === "awaiting_approval" && !needsMe(d, p)
              : approval === "ready"
                ? p.status === "approved"
                : approval === "submitted"
                  ? p.status === "submitted_to_school"
                  : p.status === "awaiting_approval" &&
                    !approved(d, p, approval))) &&
        `${p.vendor} ${p.purpose} ${who(p.requester_id)} ${p.school_reference}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      const rank = (p: PO) =>
        needsMe(d, p)
          ? 0
          : p.status === "changes_requested"
            ? 1
            : p.status === "approved"
              ? 2
              : 3;
      return rank(a) - rank(b) || b.po_number - a.po_number;
    });
  return (
    <>
      {privileged && (
        <div className="stats">
          {counts.map(([name, count, value]) => (
            <button
              key={name}
              className="panel stat"
              onClick={() => {
                setApproval(String(value));
                setStatus("");
              }}
            >
              <strong>{count}</strong>
              {name}
            </button>
          ))}
        </div>
      )}
      <h2>
        {privileged
          ? "Approval queue"
          : d.context.profile.role === "lead"
            ? "My and area purchase orders"
            : "My purchase orders"}
      </h2>
      <div className="panel filters">
        <label className="search">
          Search
          <input
            type="search"
            placeholder="Vendor, purpose, requester or school reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {[
              "draft",
              "awaiting_approval",
              "changes_requested",
              "approved",
              "submitted_to_school",
              "cancelled",
            ].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Area
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All areas</option>
            {d.context.areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vendor
          <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">All vendors</option>
            {[...new Set(d.orders.map((p) => p.vendor))].sort().map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Requester
          <select
            value={requester}
            onChange={(e) => setRequester(e.target.value)}
          >
            <option value="">All visible requesters</option>
            {d.context.people
              .filter((n) => d.orders.some((p) => p.requester_id === n.id))
              .map((n) => (
                <option value={n.id} key={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Approval state
          <select
            value={approval}
            onChange={(e) => setApproval(e.target.value)}
          >
            <option value="">All approvals</option>
            <option value="mine">Needs your approval</option>
            <option value="waiting">Waiting on other approval</option>
            <option value="ready">Ready for school</option>
            <option value="submitted">Submitted</option>
            <option value="finance_approver">Finance Lead pending</option>
            <option value="po_approver">Lead Coach pending</option>
          </select>
        </label>
      </div>
      {!queue.length ? (
        <div className="panel empty">
          No purchase orders in this view.{" "}
          {d.context.can_create
            ? "Create a request or adjust your filters."
            : "Requests will appear when you have access."}
        </div>
      ) : (
        <div className="po-list">
          {queue.map((p) => (
            <button
              className="panel po-row"
              key={p.id}
              onClick={() => onOpen(p.id)}
            >
              <div>
                <small>
                  PO {p.po_number} · Revision {p.revision}
                </small>
                <h3>{p.vendor}</h3>
                <p>{p.purpose}</p>
                <small>
                  {who(p.requester_id)} ·{" "}
                  {d.context.areas.find((a) => a.id === p.area_id)?.name}
                </small>
              </div>
              <div>
                <strong>{money(p.amount)}</strong>
                <Badge status={p.status} />
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{label(status)}</span>;
}
function POForm({
  data,
  po,
  run,
  done,
}: {
  data: Data;
  po?: PO;
  run: Run;
  done: (id: string) => void;
}) {
  return (
    <form
      className="form"
      onSubmit={(e) => {
        const f = fields(e);
        void run(async () => {
          if (!sheetURL(f.sheet_url.trim()))
            throw new Error(
              "Use an HTTPS docs.google.com spreadsheet/document link.",
            );
          const id = await mutate(po ? "edit" : "create", {
            ...f,
            ...(po ? { id: po.id, version: po.version } : {}),
          });
          done(id);
        }, "Draft saved. Submit it when the Google Sheet is ready.");
      }}
    >
      <label>
        Google Sheet URL
        <input
          type="url"
          name="sheet_url"
          defaultValue={po?.sheet_url}
          placeholder="https://docs.google.com/spreadsheets/d/…"
          required
        />
      </label>
      <div className="grid">
        <label>
          Vendor
          <input
            name="vendor"
            defaultValue={po?.vendor}
            maxLength={150}
            required
          />
        </label>
        <label>
          Total amount (USD)
          <input
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            max="999999999999.99"
            defaultValue={po?.amount}
            required
          />
        </label>
        <label>
          Functional area
          <select name="area_id" defaultValue={po?.area_id || ""} required>
            <option value="" disabled>
              Select an area
            </option>
            {data.context.areas
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Needed by (optional)
          <input
            name="needed_by"
            type="date"
            defaultValue={po?.needed_by || ""}
          />
        </label>
      </div>
      <label>
        Purpose / short description
        <textarea
          name="purpose"
          defaultValue={po?.purpose}
          maxLength={2000}
          required
        />
      </label>
      <details>
        <summary>Optional notes</summary>
        <textarea
          aria-label="Notes"
          name="notes"
          defaultValue={po?.notes}
          maxLength={4000}
        />
      </details>
      <p className="muted">
        Keep line items in the Google Sheet. Saving edits returns this PO to
        Draft; submitting again requires both approvals on a new revision.
      </p>
      <button className="primary">Save draft</button>
    </form>
  );
}
function Detail({
  data: d,
  po: p,
  run,
  edit,
}: {
  data: Data;
  po: PO;
  run: Run;
  edit: () => void;
}) {
  const name = (id: string | null) =>
    d.context.people.find((n) => n.id === id)?.name || "Team member";
  const canOverride = ["admin", "mentor"].includes(d.context.profile.role);
  const owner = p.requester_id === d.context.profile.id || d.context.is_admin;
  const locked = ["cancelled", "submitted_to_school"].includes(p.status);
  return (
    <>
      <div className="detail-heading">
        <div>
          <h1>{p.vendor}</h1>
          <p>{p.purpose}</p>
          <small>
            {name(p.requester_id)} ·{" "}
            {d.context.areas.find((a) => a.id === p.area_id)?.name} · Revision{" "}
            {p.revision}
          </small>
        </div>
        <strong>{money(p.amount)}</strong>
      </div>
      <Badge status={p.status} />
      <p>
        Submitted for approval: {when(p.submitted_at)}
        {p.needed_by && <> · Needed by {p.needed_by}</>}
      </p>
      {p.notes && <p>{p.notes}</p>}
      {sheetURL(p.sheet_url) && (
        <a
          className="primary sheet-link"
          href={p.sheet_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Google Sheet ↗
        </a>
      )}
      <p className="muted">
        Approvals apply to this revision. After changing the spreadsheet,
        edit/resubmit this request—even if its metadata is unchanged.
      </p>
      {owner && !locked && (
        <div className="toolbar">
          <button className="secondary" onClick={edit}>
            Edit / revise
          </button>
          {["draft", "changes_requested"].includes(p.status) && (
            <button
              className="primary"
              onClick={() =>
                void run(
                  () => mutate("submit", { id: p.id, version: p.version }),
                  "Submitted for approval",
                )
              }
            >
              {p.revision ? "Resubmit for approval" : "Submit for approval"}
            </button>
          )}
          <details>
            <summary>Cancel request</summary>
            <form
              className="form"
              onSubmit={(e) => {
                const f = fields(e);
                void run(
                  () =>
                    mutate("cancel", {
                      id: p.id,
                      version: p.version,
                      reason: f.reason,
                    }),
                  "Cancelled",
                );
              }}
            >
              <label>
                Cancellation reason
                <input name="reason" maxLength={2000} required />
              </label>
              <button className="danger">Cancel purchase order</button>
            </form>
          </details>
        </div>
      )}
      <div className="grid">
        {slots.map((slot) => {
          const actions = d.approvals
            .filter(
              (a) =>
                a.po_id === p.id &&
                a.revision === p.revision &&
                a.slot === slot,
            )
            .sort((a, b) => b.acted_at.localeCompare(a.acted_at));
          const latest = p.status === "draft" ? undefined : actions[0];
          const canAct =
            p.status === "awaiting_approval" &&
            (d.context.capabilities.includes(slot) || canOverride) &&
            (p.requester_id !== d.context.profile.id || canOverride);
          const alreadyActed = d.approvals.some(
            (a) =>
              a.po_id === p.id &&
              a.revision === p.revision &&
              a.action === "approved" &&
              a.actor_id === d.context.profile.id,
          );
          return (
            <section className="panel" key={slot}>
              <h2>
                {slot === "finance_approver"
                  ? "Finance Lead Approval"
                  : "Lead Coach Approval"}
              </h2>
              <Badge status={latest?.action || "pending"} />
              {!latest && <p>Waiting for {slot === "finance_approver" ? "Finance Lead" : "Lead Coach"}</p>}
              {latest && (
                <>
                  <p>
                    {name(latest.actor_id)} · {when(latest.acted_at)}
                  </p>
                  {latest.explanation && <p>{latest.explanation}</p>}
                  {latest.override_reason && (
                    <p>Override: {latest.override_reason}</p>
                  )}
                </>
              )}
              {canAct && (
                <form
                  className="form"
                  onSubmit={(e) => {
                    const f = fields(e);
                    const action = (
                      e.nativeEvent as SubmitEvent
                    ).submitter?.getAttribute("value");
                    void run(
                      () =>
                        mutate(action || "approve", {
                          id: p.id,
                          version: p.version,
                          slot,
                          reason: f.reason,
                          override_reason: f.override_reason,
                        }),
                      "Approval action recorded",
                    );
                  }}
                >
                  <label>
                    Explanation / requested changes
                    <textarea name="reason" maxLength={2000} />
                  </label>
                  {canOverride && (
                    <label>
                      Override reason (required if unassigned or requester)
                      <input name="override_reason" maxLength={2000} />
                    </label>
                  )}
                  {alreadyActed && (
                    <p className="muted">
                      Another person must complete the other approval.
                    </p>
                  )}
                  <div className="toolbar">
                    {!approved(d, p, slot) && !alreadyActed && (
                      <button className="primary" value="approve">
                        Approve {slot === "finance_approver" ? "Finance Lead" : "Lead Coach"}
                      </button>
                    )}
                    <button className="secondary" value="request_changes">
                      Request changes
                    </button>
                  </div>
                </form>
              )}
            </section>
          );
        })}
      </div>
      <section className="panel">
        <h2>School Submission</h2>
        {p.status === "submitted_to_school" ? (
          <>
            <Badge status={p.status} />
            <p>
              {name(p.school_submitted_by)} · {when(p.school_submitted_at)}
            </p>
            <p>Reference: {p.school_reference || "Not provided"}</p>
            <p>{p.school_note}</p>
          </>
        ) : p.status === "approved" &&
          (canOverride ||
            d.context.capabilities.includes("school_submitter")) ? (
          <form
            className="form"
            onSubmit={(e) => {
              const f = fields(e);
              void run(
                () =>
                  mutate("school_submit", {
                    id: p.id,
                    version: p.version,
                    ...f,
                  }),
                "Submitted to school",
              );
            }}
          >
            <p>
              Confirm you have sent the approved Google Sheet to school. This
              action records submission; it does not send the document.
            </p>
            <label>
              School PO / reference number (optional)
              <input name="reference" maxLength={150} />
            </label>
            <label>
              Submission note (optional)
              <textarea name="note" maxLength={2000} />
            </label>
            <button className="primary">Mark submitted to school</button>
          </form>
        ) : (
          <p>
            {p.status === "approved"
              ? "Ready for a designated school submitter."
              : "Both approvals on the current revision are required."}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Activity History</h2>
        {d.history
          .filter((h) => h.po_id === p.id)
          .sort((a, b) => b.id - a.id)
          .map((h) => (
            <article className="activity" key={h.id}>
              <strong>
                {name(h.actor_id)} · {label(h.action)} · Revision {h.revision}
              </strong>
              <small>{when(h.created_at)}</small>
              {typeof h.details.reason === "string" && (
                <p>{h.details.reason}</p>
              )}
              {typeof h.details.slot === "string" && (
                <small>{label(h.details.slot)}</small>
              )}
              {typeof h.details.override_reason === "string" &&
                h.details.override_reason && (
                  <p>Override: {h.details.override_reason}</p>
                )}
            </article>
          ))}
      </section>
      <details className="panel">
        <summary>Previous revision snapshots</summary>
        {d.revisions
          .filter((r) => r.po_id === p.id)
          .sort((a, b) => b.revision - a.revision)
          .map((r) => (
            <article className="activity" key={r.revision}>
              <h3>
                Revision {r.revision} · {when(r.submitted_at)}
              </h3>
              <p>
                {r.metadata.vendor} · {money(r.metadata.amount)} ·{" "}
                {r.metadata.purpose}
              </p>
              {sheetURL(r.metadata.sheet_url) && (
                <a
                  href={r.metadata.sheet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open revision's Google Sheet link ↗
                </a>
              )}
              <p className="muted">
                Metadata snapshot only; the external sheet remains editable.
              </p>
            </article>
          ))}
      </details>
    </>
  );
}
function Assignments({ data: d, run }: { data: Data; run: Run }) {
  return (
    <>
      <p>
        Lead Coach and Finance Lead positions are managed in Team Hub.
        Two distinct people must approve each revision. This page manages only
        school submission and Finance administration access.
      </p>
      <p><a href="https://team.frc4418.org/#team-management">Manage team positions in Team Hub →</a></p>
      <form
        className="form"
        onSubmit={(e) => {
          const f = fields(e);
          void run(
            () => mutate("assignment", { ...f, active: f.active === "true" }),
            "Assignment recorded",
          );
        }}
      >
        <label>
          Team member
          <select name="user_id" required>
            {d.context.people.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capability
          <select name="capability">
            {["school_submitter", "finance_admin"].map((c) => (
              <option value={c} key={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignment state
          <select name="active">
            <option value="true">Active</option>
            <option value="false">Revoked</option>
          </select>
        </label>
        <label>
          Assignment explanation
          <input name="reason" required maxLength={2000} />
        </label>
        <button className="primary">Save assignment</button>
      </form>
      {d.assignments.filter(a => !slots.includes(a.capability)).map((a) => (
        <p className="activity" key={a.id}>
          {d.context.people.find((p) => p.id === a.user_id)?.name ||
            "Former team member"}{" "}
          · {label(a.capability)} · {a.active ? "Active" : "Revoked"}
        </p>
      ))}
      <h3>Assignment history</h3>
      {d.history
        .filter((h) => !h.po_id)
        .sort((a, b) => b.id - a.id)
        .map((h) => (
          <p key={h.id}>
            {when(h.created_at)} · {String(h.details.capability)} ·{" "}
            {String(h.details.reason)}
          </p>
        ))}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

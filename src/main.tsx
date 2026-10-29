import { FinanceFeedback } from "./FinanceFeedback";
import { FinancePageHeader } from "./FinancePageHeader";
import { Plus, FileText, ChevronRight, ClipboardCheck, Clock3, Send, CheckCheck } from "lucide-react";
import { FinanceNav, BudgetWorkspace, ApprovalCoding, currentWorkspace, workspaces } from './BudgetWorkspace';
import {loadBudget} from './budget-service';
import {AuthSurface} from './AuthSurface';
import { SuiteHeader } from './SuiteHeader';
import { poNextStep, selfApprovalGuidance, closedSeasonGuidance } from "./po-next-step";
import { poListContextStore, emptyPOListContext, type POListContext } from "./po-list-context";
import { createPOEditorGuard, preservesPOEditor, poFormSnapshot } from './po-editor-guard';
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import {
  client,
  load,
  canChangePOs, coachSelfFact, canSelfApproveCoach, hasCoachSelfApproval,
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
  const [workspace,setWorkspace]=useState(currentWorkspace);
  const [canBudget,setCanBudget]=useState(false);
  useEffect(()=>{const changed=()=>setWorkspace(currentWorkspace());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed)},[]);
  const [data, setData] = useState<Data | null>(null),
    [signed, setSigned] = useState(false),
    [loading, setLoading] = useState(!!client),
    [denied, setDenied] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [pendingMessage, setPendingMessage] = useState("Saving changes…"),
    [selected, setSelected] = useState<string | null>(null),
    [editing, setEditing] = useState<PO | "new" | null>(null),
    [admin, setAdmin] = useState(false),
    [recovery, setRecovery] = useState(false);
  const [, updateEditorGuard] = useState(0);
  const [editorGuard] = useState(() => createPOEditorGuard(() => updateEditorGuard(n => n + 1)));
  const poForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!editorGuard.dirty) return;
    window.addEventListener('beforeunload', editorGuard.beforeUnload);
    return () => window.removeEventListener('beforeunload', editorGuard.beforeUnload);
  }, [editorGuard, editorGuard.dirty]);
  const returnToResults = () => {
    closeDialog();
    if (workspace !== 'orders' || location.hash.startsWith('#po/')) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#orders`);
      setWorkspace('orders');
    }
    requestAnimationFrame(() => {
      if (data) window.scrollTo(0, poListContextStore.read(data.context.profile.id).scrollY);
    });
  };
  const closeDialog = () => {
    editorGuard.reset();
    setSelected(null);
    setEditing(null);
    setAdmin(false);
  };
  const purchaseIntent = useRef(new URLSearchParams(location.search).get('action') === 'request-purchase');
  useEffect(() => {
    if (!data || recovery || !purchaseIntent.current) return;
    // Consume only after authentication and capability loading. Replace, never
    // push, so Close/Back/refresh cannot replay an already handled request.
    purchaseIntent.current = false;
    const url = new URL(location.href);
    url.searchParams.delete('action');
    url.hash = 'orders';
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    setWorkspace('orders');
    setSelected(null);
    if (canChangePOs(data) && data.context.can_create) setEditing('new');
    else setMessage('Your account cannot create a purchase request. Contact a mentor for help.');
  }, [data, recovery]);
  const linkedPO = useRef(/^#po\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(location.hash)?.[1] || null);
  useEffect(() => {
    if (!data) return;
    const openLink = (id: string | null) => {
      if (!id) return;
      const visible = data.orders.some(order => order.id === id);
      setSelected(visible ? id : null);
      if (!visible) setMessage('This purchase order is unavailable or your account does not have access.');
    };
    openLink(linkedPO.current); linkedPO.current = null;
    const changed = () => openLink(/^#po\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(location.hash)?.[1] || null);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [data]);
  useEffect(()=>{let alive=true;setCanBudget(false);if(data && canChangePOs(data))void loadBudget().then(b=>{if(alive)setCanBudget(b.can_manage===true)}).catch(()=>{});return()=>{alive=false}},[data]);
  const generation = useRef(0);
  useEffect(() => {
    if (!client) return;
    let mounted = true;
    let sessionUserId: string | null = null;
    const receive = (event: string, session: unknown) => {
      const nextId = (session as { user?: { id?: string } } | null)?.user?.id || null;
      // Returning from the Google Sheet may refresh the same user's session.
      // It must not unmount their editor. Account changes/recovery still reset it.
      if (editorGuard.dirty && preservesPOEditor(event, sessionUserId, nextId)) return;
      poListContextStore.setUser(nextId);
      if (event === 'SIGNED_OUT' || (sessionUserId && sessionUserId !== nextId)) {
        purchaseIntent.current = false;
        const url = new URL(location.href);
        if (url.searchParams.get('action') === 'request-purchase') {
          url.searchParams.delete('action');
          history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        }
      }
      sessionUserId = nextId;
      const gen = ++generation.current;
      setSigned(!!session);
      setData(null);
      setDenied(false);
      setSelected(null);
      setEditing(null);
      editorGuard.reset();
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
    setPendingMessage(text === "Refreshed" ? "Refreshing Finance…" : text === "Signed out" ? "Signing out…" : "Saving changes…");
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
      if (gen === generation.current) {
        setError(err(e));
        // Refresh authority after a denied write without remounting or erasing the editor.
        if ((e as {code?: string})?.code === '42501') {
          try { const fresh = await loadFinance(); if (gen === generation.current) setData(fresh); }
          catch { /* Keep the original error and unsaved draft; never auto-retry a write. */ }
        }
      }
    } finally {
      setBusy(false);
    }
  }
  if (!signed) return <AuthSurface>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!client ? <p role="alert">Unable to connect securely. Please try again.</p> : loading ? <p role="status">Connecting securely…</p> : (
<form
                className="panel form auth"
                onSubmit={(e) => {
                  const f = fields(e);
                  if (busy) return;
                  void run(async () => {
                    const r = await client!.auth.signInWithPassword({
                      email: f.email,
                      password: f.password,
                    });
                    if (r.error) throw r.error;
                  }, "");
                }}
              >
                <h1>Finance sign in</h1>
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
    )}
    <p><a href="https://team.frc4418.org/">Team Hub / Home</a></p>
  </AuthSurface>;
  const po = data?.orders.find((p) => p.id === selected);
  const editorGeneration = generation.current;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SuiteHeader app="Finance" context={workspaces.find(([id])=>id===workspace)?.[1]} name={data?.context.profile.display_name} busy={busy} onSignOut={()=>editorGuard.requestLeave(()=>{closeDialog();void run(async()=>{const r=await client!.auth.signOut();if(r.error)throw r.error;},'Signed out');})}/>

      <div className="finance-layout"><FinanceNav page={workspace} canBudget={canBudget} admin={!!data && canChangePOs(data) && data.context.is_admin}/>
      <main id="main">
        {workspace === 'orders' && <FinancePageHeader title="Purchase orders" description="The Google Sheet is your PO. Finance keeps its approvals moving.">
          {data && canChangePOs(data) && data.context.can_create && <button className="primary" disabled={busy} onClick={() => setEditing("new")}><Plus size={18} aria-hidden="true" />New purchase order</button>}
        </FinancePageHeader>}
        {!client ? (
          <div className="panel">
            Finance setup is pending. Configure the shared public Supabase
            environment after schema review.
          </div>
        ) : (
          <>
            {!(data && (po || editing || admin)) && <FinanceFeedback busy={busy} pending={pendingMessage} error={error} message={message} onDismiss={() => { setError(""); setMessage(""); }} />}
            {loading ? (
              <p role="status">Loading Finance…</p>
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
                <div className="toolbar"><button className="secondary" disabled={busy} onClick={()=>void run(async()=>{},'Refreshed')}>Refresh</button></div>
                {workspace==='orders'?<Overview key={data.context.profile.id} data={data} onOpen={setSelected}/>:<fieldset disabled={busy} className="unboxed"><BudgetWorkspace page={workspace} data={data} run={run} openPO={setSelected} newPO={()=>setEditing("new")} assignments={<Assignments data={data} run={run}/>}/></fieldset>}
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
                onClose={() => editorGuard.requestLeave(closeDialog)}
              >
                {!admin && <button className="secondary po-back-results" disabled={busy} onClick={() => editorGuard.requestLeave(returnToResults)}>← Back to results</button>}
                <FinanceFeedback busy={busy} pending={pendingMessage} error={error} message={message} onDismiss={() => { setError(""); setMessage(""); }} />
                <fieldset disabled={busy} className="unboxed">
                  {editing ? (
                    <POForm
                      key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
                      data={data}
                      po={editing === "new" ? undefined : editing}
                      run={run}
                      formRef={poForm}
                      dirty={editorGuard.dirty}
                      onDirty={editorGuard.setDirty}
                      onSaveFailed={editorGuard.saveFailed}
                      done={(id) => {
                        // Auth events can arrive before React has unmounted
                        // the old editor; ignore that account's late response.
                        if (generation.current !== editorGeneration) return;
                        const leave = editorGuard.saved();
                        setEditing(null);
                        if (leave) leave();
                        else setSelected(id);
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
            {editing && editorGuard.confirming && (
              <Dialog title={data && canChangePOs(data) ? "Save your purchase order?" : "Keep your unsaved work?"} busy={busy} onClose={editorGuard.keepEditing} closeLabel="Keep editing" className="po-leave-dialog">
                <p>{data && canChangePOs(data) ? "Your changes have not been saved. Save a draft to resume later, or discard only these unsaved edits." : "Your account is read-only. Keep this editor open to copy your unsaved text, or discard only these local edits. Nothing will be saved."}</p>
                {data && canChangePOs(data) && <p className="muted">Saving a draft does not submit it for approval. Required fields must be complete.</p>}
                <div className="toolbar po-leave-actions">
                  {data && canChangePOs(data) && <button className="primary" disabled={busy} onClick={() => {
                    // Close the confirmation before browser validation focuses
                    // a missing field in the still-mounted underlying form.
                    editorGuard.beginSaveAndLeave();
                    requestAnimationFrame(() => {
                      if (poForm.current?.reportValidity()) poForm.current.requestSubmit();
                      else editorGuard.saveFailed();
                    });
                  }}>Save draft</button>}
                  <button className="danger" disabled={busy} onClick={editorGuard.discard}>Discard changes</button>
                </div>
              </Dialog>
            )}
          </>
        )}
        <footer>
          4418 IMPULSE · Google Sheets remains the authoritative purchase order.
        </footer>
      </main></div>
    </>
  );
}
function Dialog({
  title,
  children,
  busy,
  onClose,
  closeLabel = "Close",
  className,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      // React clears the ref before passive unmount cleanup. Keep the element
      // and the original trigger so Close and Escape restore keyboard focus.
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="toolbar">
        <h2>{title}</h2>
        <button className="secondary" disabled={busy} onClick={onClose} autoFocus={closeLabel === "Keep editing"}>
          {closeLabel}
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
  const userId = d.context.profile.id;
  const validContext = (previous: POListContext) => {
    const area = d.context.areas.some(item => item.id === previous.area) ? previous.area : '';
    const vendor = d.orders.some(item => item.vendor === previous.vendor) ? previous.vendor : '';
    const requester = d.orders.some(item => item.requester_id === previous.requester) ? previous.requester : '';
    return area === previous.area && vendor === previous.vendor && requester === previous.requester
      ? previous : { ...previous, area, vendor, requester, scrollY: 0 };
  };
  const [listContext, setListContext] = useState(() => validContext(poListContextStore.read(userId)));
  const { search, status, area, vendor, requester, approval, moreFilters } = listContext;
  const contextRef = useRef(listContext);
  const renderedContext = useRef(listContext);
  if (renderedContext.current !== listContext) {
    contextRef.current = listContext;
    renderedContext.current = listContext;
  }
  const updateFilter = (key: keyof POListContext, value: string | boolean) =>
    setListContext(previous => ({ ...previous, [key]: value, scrollY: 0 }));
  const setSearch = (value: string) => updateFilter('search', value);
  const setStatus = (value: string) => updateFilter('status', value);
  const setArea = (value: string) => updateFilter('area', value);
  const setVendor = (value: string) => updateFilter('vendor', value);
  const setRequester = (value: string) => updateFilter('requester', value);
  const setApproval = (value: string) => updateFilter('approval', value);
  useEffect(() => { poListContextStore.save(userId, contextRef.current); }, [userId, listContext]);
  useEffect(() => {
    // Removed options must not strand the user behind an invisible filter.
    setListContext(previous => validContext(previous));
  }, [d]);
  useLayoutEffect(() => {
    const position = contextRef.current.scrollY;
    let frame = requestAnimationFrame(() => {
      window.scrollTo(0, position);
      frame = requestAnimationFrame(() => window.scrollTo(0, position));
    });
    const capture = () => {
      contextRef.current = { ...contextRef.current, scrollY: window.scrollY };
      poListContextStore.save(userId, contextRef.current);
    };
    window.addEventListener('scroll', capture, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', capture); };
  }, [userId]);
  const openResult = (id: string) => {
    poListContextStore.save(userId, { ...contextRef.current, scrollY: window.scrollY });
    onOpen(id);
  };
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
    ["Received", d.orders.filter((p) => p.status === "received").length, "received"],
  ];
  const activeFilterCount = [search, status, area, vendor, requester, approval].filter(Boolean).length;
  const secondaryFilterCount = [area, vendor, requester].filter(Boolean).length;
  const clearFilters = () => setListContext(emptyPOListContext());
  const filtered = d.orders
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
                  : approval === "received"
                    ? p.status === "received"
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
  const queue = filtered.filter(p => p.status !== "received");
  const received = filtered.filter(p => p.status === "received")
    .sort((a, b) => (b.received_at || "").localeCompare(a.received_at || "") || b.po_number - a.po_number);
  return (
    <>
      {privileged && (
        <div className="stats po-stats">
          {counts.map(([name, count, value]) => (
            <button
              key={name}
              className="panel stat"
              aria-pressed={approval === String(value)}
              onClick={() => {
                setApproval(String(value));
                setStatus("");
              }}
            >
              <span className="stat-heading"><span>{name}</span>{value === "mine" ? <ClipboardCheck size={19} aria-hidden="true" /> : value === "waiting" ? <Clock3 size={19} aria-hidden="true" /> : value === "ready" ? <Send size={19} aria-hidden="true" /> : <CheckCheck size={19} aria-hidden="true" />}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
      )}
      <div className="finance-queue-heading"><h2>
        {privileged
          ? "Approval queue"
          : d.context.profile.role === "lead"
            ? "My and area purchase orders"
            : "My purchase orders"}
      </h2><span className="finance-result-count">{queue.length} {queue.length === 1 ? "order" : "orders"}</span>{activeFilterCount > 0 && <button className="secondary clear-filters" onClick={clearFilters}>Clear filters</button>}</div>
      <div className="panel filters order-filters">
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
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {[
              "draft",
              "awaiting_approval",
              "changes_requested",
              "approved",
              "submitted_to_school",
              "received",
              "cancelled",
            ].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Approval state
          <select
            aria-label="Approval state"
            value={approval}
            onChange={(e) => setApproval(e.target.value)}
          >
            <option value="">All approvals</option>
            <option value="mine">Needs your approval</option>
            <option value="waiting">Waiting on other approval</option>
            <option value="ready">Ready for school</option>
            <option value="submitted">Submitted</option>
            <option value="received">Received</option>
            <option value="finance_approver">Finance Lead pending</option>
            <option value="po_approver">Lead Coach pending</option>
          </select>
        </label>
        <details className="secondary-filters" open={moreFilters} onToggle={event => { const open = event.currentTarget.open; setListContext(previous => previous.moreFilters === open ? previous : { ...previous, moreFilters: open, scrollY: contextRef.current.scrollY }); }}>
          <summary>More filters{secondaryFilterCount > 0 && <span className="filter-count">{secondaryFilterCount} applied</span>}</summary>
          <div className="secondary-filter-fields">
        <label>
          Area
          <select aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
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
          </div>
        </details>
      </div>
      {!queue.length ? (
        <div className="panel empty finance-empty">
          <FileText className="empty-icon" size={28} aria-hidden="true" />
          <h3>No purchase orders in this view.</h3>{" "}
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
              onClick={() => openResult(p.id)}
            >
              <div>
                <small>
                  PO {p.po_number}
                </small>
                <h3>{p.vendor}</h3>
                <p>{p.purpose}</p>
                <p className="po-next-step-inline">{poNextStep(d, p).title}</p>
                <small>
                  {who(p.requester_id)} ·{" "}
                  {d.context.areas.find((a) => a.id === p.area_id)?.name}
                </small>
              </div>
              <div className="po-row-summary"><div><strong>{money(p.amount)}</strong><Badge status={p.status} /></div><ChevronRight size={20} aria-hidden="true" /></div>
            </button>
          ))}
        </div>
      )}
      <section className="received-orders" aria-labelledby="received-orders-heading">
        <div className="finance-queue-heading">
          <h2 id="received-orders-heading">Received purchase orders</h2>
          <span className="finance-result-count">{received.length} {received.length === 1 ? "order" : "orders"}</span>
        </div>
        <p className="muted">Completed deliveries, separate from the approval queue. The filters above apply to both lists.</p>
        {received.length ? (
          <table className="finance-table received-po-table" role="table" aria-label="Received purchase orders">
            <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Purchase order</th><th role="columnheader" scope="col">Requester / area</th><th role="columnheader" scope="col">Amount</th><th role="columnheader" scope="col">School reference</th><th role="columnheader" scope="col">Received</th></tr></thead>
            <tbody role="rowgroup">{received.map(p => (
              <tr role="row" key={p.id}>
                <td role="cell" data-label="Purchase order"><button onClick={() => openResult(p.id)}>PO {p.po_number} · {p.vendor}</button><small>{p.purpose}</small></td>
                <td role="cell" data-label="Requester / area">{who(p.requester_id)}<small>{d.context.areas.find(a => a.id === p.area_id)?.name}</small></td>
                <td role="cell" data-label="Amount">{money(p.amount)}</td>
                <td role="cell" data-label="School reference">{p.school_reference || "Not provided"}</td>
                <td role="cell" data-label="Received">{when(p.received_at)}<small>{p.received_by ? who(p.received_by) : "Team member"}</small></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="panel empty">{activeFilterCount ? "No received purchase orders match these filters." : "No purchase orders have been marked received yet."}</div>}
      </section>
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
  formRef,
  dirty,
  onDirty,
  onSaveFailed,
}: {
  data: Data;
  po?: PO;
  run: Run;
  done: (id: string) => void;
  formRef: RefObject<HTMLFormElement | null>;
  dirty: boolean;
  onDirty: (dirty: boolean) => void;
  onSaveFailed: () => void;
}) {
  const initial = useRef("");
  const saving = useRef(false);
  const mounted = useRef(false);
  const [sheet, setSheet] = useState(po?.sheet_url || "");
  useEffect(() => {
    mounted.current = true;
    initial.current = poFormSnapshot(formRef.current!);
    return () => { mounted.current = false; };
  }, [formRef]);
  return (
    <form
      ref={formRef}
      className="form po-editor"
      onChange={() => {
        const form = formRef.current!;
        onDirty(poFormSnapshot(form) !== initial.current);
        setSheet((form.elements.namedItem('sheet_url') as HTMLInputElement).value);
      }}
      onSubmit={(e) => {
        const f = fields(e);
        if (saving.current || !canChangePOs(data)) return;
        saving.current = true;
        void run(async () => {
          try {
            if (!sheetURL(f.sheet_url.trim()))
              throw new Error(
                "Use an HTTPS docs.google.com spreadsheet/document link.",
              );
            const id = await mutate(po ? "edit" : "create", {
              ...f,
              ...(po ? { id: po.id, version: po.version } : {}),
            });
            if (mounted.current) done(id);
          } catch (error) {
            if (mounted.current) onSaveFailed();
            throw error;
          } finally {
            saving.current = false;
          }
        }, "Draft saved. Submit it when the Google Sheet is ready.");
      }}
    >
      {!canChangePOs(data) && <p role="status">Your account is now read-only. Your unsaved text is kept here; keep this window open to copy it, or discard it when ready. Saving is unavailable.</p>}
      {canChangePOs(data) && <p className="po-draft-help">Save a draft before leaving. Resume it from Purchase orders by opening the draft and choosing <strong>Resume draft</strong>. Nothing is submitted for approval automatically.</p>}
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
      {sheetURL(sheet.trim()) && <div className="po-sheet-shortcut"><a href={sheet.trim()} target="_blank" rel="noopener noreferrer">Open Google Sheet in a new tab ↗</a><small>Your Finance form stays open here.</small></div>}
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
        Saved as a draft. Submitting again requires both approvals.
      </p>
      <div className="po-draft-actions">
        <span role="status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <button className="primary" disabled={!canChangePOs(data)}>Save draft</button>
      </div>
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
  const writable = canChangePOs(d);
  const selfFact = coachSelfFact(d, p);
  const normalSelf = canSelfApproveCoach(d, p);
  const selfRecorded = hasCoachSelfApproval(d, p);
  const owner = writable && (p.requester_id === d.context.profile.id || d.context.is_admin);
  const locked = ["cancelled", "submitted_to_school", "received"].includes(p.status);
  const nextStep = poNextStep(d, p);
  const goToNextStep = () => {
    if (!nextStep.target) return;
    const section = document.getElementById(nextStep.target);
    section?.scrollIntoView({ behavior: 'auto', block: 'start' });
    section?.focus({ preventScroll: true });
  };
  return (
    <>
      <div className="detail-heading">
        <div>
          <h1>{p.vendor}</h1>
          <p>{p.purpose}</p>
          <small>
            {name(p.requester_id)} ·{" "}
            {d.context.areas.find((a) => a.id === p.area_id)?.name}
          </small>
        </div>
        <strong>{money(p.amount)}</strong>
      </div>
      <Badge status={p.status} />
      <section className="po-next-step" aria-labelledby="po-next-step-heading">
        <div><h2 id="po-next-step-heading">{nextStep.title}</h2><p>{nextStep.description}</p></div>
        {nextStep.target && nextStep.actionLabel && <button className="secondary" onClick={goToNextStep}>{nextStep.actionLabel}</button>}
      </section>
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
        Approvals cover the submitted spreadsheet.{owner && !locked && <> If you change it, edit and resubmit the PO for both approvals.</>}
      </p>
      {owner && !locked && (
        <div className="toolbar" id="owner-actions" tabIndex={-1}>
          <button className="secondary" onClick={edit}>
            {p.status === "draft" ? "Resume draft" : "Edit purchase order"}
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
            writable && p.status === "awaiting_approval" &&
            !(p.requester_id === d.context.profile.id && (selfFact || selfRecorded) && (slot === "finance_approver" || !normalSelf)) &&
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
            <section className="panel" key={slot} id={`approval-${slot}`} tabIndex={-1}>
              <h2>
                {slot === "finance_approver"
                  ? "Finance Lead Approval"
                  : "Lead Coach Approval"}
              </h2>
              <Badge status={latest?.action || (p.status === "draft" ? "not_submitted" : p.status === "cancelled" ? "not_required" : p.status === "changes_requested" ? "awaiting_resubmission" : "pending")} />
              {!latest && <p>{p.status === 'draft' ? (owner ? 'Submit this draft to request approval.' : 'This draft has not been submitted for approval.') : p.status === 'cancelled' ? 'This request is cancelled; no approval is needed.' : p.status === 'changes_requested' ? 'The requester must update and resubmit this PO.' : `Waiting for ${slot === "finance_approver" ? "Finance Lead" : "Lead Coach"}`}</p>}
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
              {p.status === "awaiting_approval" && p.requester_id === d.context.profile.id &&
                d.context.capabilities.includes(slot) && !canOverride && !approved(d,p,slot) && (
                <p>{selfApprovalGuidance}</p>
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
                          category_id:f.category_id, budget_reason:f.budget_reason,
                        }),
                      "Approval action recorded",
                    );
                  }}
                >
                  {slot==='finance_approver'&&<ApprovalCoding po={p}/>}
                  <label>
                    Explanation / requested changes
                    <textarea name="reason" maxLength={2000} />
                  </label>
                  {canOverride && !normalSelf && (
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
                        {slot === "finance_approver" ? "Approve & assign budget" : "Approve Lead Coach"}
                      </button>
                    )}
                    {!normalSelf && <button className="secondary" value="request_changes">
                      Request changes
                    </button>}
                  </div>
                </form>
              )}
            </section>
          );
        })}
      </div>
      <section className="panel" id="school-submission" tabIndex={-1}>
        <h2>School Submission</h2>
        {["submitted_to_school", "received"].includes(p.status) ? (
          <>
            <Badge status="submitted_to_school" />
            <p>
              {name(p.school_submitted_by)} · {when(p.school_submitted_at)}
            </p>
            <p>Reference: {p.school_reference || "Not provided"}</p>
            <p>{p.school_note}</p>
          </>
        ) : writable && p.status === "approved" &&
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
              : p.status === "cancelled" ? "This request is cancelled; it will not be submitted to school."
              : "Both approvals are required for this submission."}
          </p>
        )}
      </section>
      {["submitted_to_school", "received"].includes(p.status) && <section className="panel" id="receiving" tabIndex={-1}>
        <h2>Receiving</h2>
        {p.status === "received" ? <>
          <Badge status="received" />
          <p>{name(p.received_by)} · {when(p.received_at)}</p>
          {p.receipt_note && <p>{p.receipt_note}</p>}
        </> : d.closedSeasonPOIds.includes(p.id) ? <p>{closedSeasonGuidance}</p>
        : writable && (canOverride || d.context.capabilities.includes("school_submitter")) ? (
          <form className="form" onSubmit={e => {
            const f = fields(e);
            void run(() => mutate("receive", { id: p.id, version: p.version, note: f.note }), "Marked received");
          }}>
            <p>Confirm the entire order has arrived. This records receipt of the PO; it does not change Inventory stock or record another expense.</p>
            <label>Receipt note (optional)<textarea name="note" maxLength={2000} /></label>
            <button className="primary">Mark received</button>
          </form>
        ) : <p>Waiting for a designated school submitter or mentor/admin to confirm receipt.</p>}
      </section>}
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
        <summary>Previous submissions</summary>
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
                  Open submitted Google Sheet ↗
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
        Two different people must approve each submission. This page manages only
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

import "./design-system.css";
import "./finance-polish.css";

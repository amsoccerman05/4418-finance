# Truthful purchase-order actions

Two focused fixes preserve the existing authorization model:

- **Needs your approval** excludes someone who already approved either slot on the current revision, even if they have both capabilities or changed positions. Historical approvals do not hide a genuinely new submission. Two different approvers are still required by the server.
- A submitted order from a **closed budget season** is labeled read-only. Its detail explains why it cannot be marked received instead of offering a receipt form that the server will reject. Previously recorded receipts remain visible as completed orders. No season is reopened and no purchase is changed automatically.

## Narrow read-only database addition

Migration: `20261028033326_finance_po_actionability.sql` (created with Supabase CLI).

The existing PO result has no season link/status. The budget context intentionally returns no budget information to ordinary requesters and designated school submitters, so the closed-season fact cannot be reliably derived from their existing responses.

`public.finance_po_actionability` exposes only `id` and `season_closed` for the caller's already-visible POs. The view uses **security_invoker** to retain `finance_purchase_orders` RLS and **security_barrier**. Its private stable scalar helper checks `auth.uid()` and the existing PO visibility predicate before reading the budget link; an invisible or nonexistent PO returns `null`. The helper has an empty search path, fully qualified names, and no PUBLIC/anonymous execution grant. Authenticated callers can read the view, not write it. No underlying table grants, RLS policies, role assignments, mutation functions, budget data, or receiving rules change.

Finance waits for this read along with its other protected data. A failed read does not assume that receiving is allowed; it surfaces the normal load error and allows reloading. Receipt mutations still perform their original server-side checks, including season closure after the page was loaded.

## Verification and release

- `scripts/po-actionability.test.mjs`: actual queue/load code with synthetic services, revision/actor/slot boundaries, failed-read behavior.
- `scripts/po-next-step.test.mjs`: closed-season guidance for every existing role/capability, unchanged completed-receipt guidance.
- `tests/po-actionability-db.spec.ts`: disposable PostgreSQL; original catalog/data preservation, exact existing-PO visibility, anonymous/inactive/unrelated/revoked callers, direct private-helper denial, unchanged budget access and closed-season receipt rejection.
- `tests/finance-attention.spec.ts` and `tests/ui.spec.ts`: browser regressions at 390px and 1440px, approval queue/detail consistency, reload/new revision, closed-season receiving, and failed-read recovery. Tests use intercepted APIs and fictitious identities only.

After review and explicit release approval, apply only this additive migration before deploying this frontend. It has no historical data backfill. Verify PostgreSQL 15+ and the two view security options, compare existing grants/RLS/mutation functions, and run security advisors in the authorized deployment environment. Local PGlite tests are not a hosted Supabase advisor pass. Do not deploy before the view exists; do not use real PO mutations to validate the release.

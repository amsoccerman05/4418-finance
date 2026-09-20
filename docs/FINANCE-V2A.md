# Finance V2A — review before production

Implementation is local only. Base: deployed Finance a89a435, including v6 notifications and first-party Hub handoff. Production signatures, columns, position metadata and audit trigger were read on 2026-09-20; no production writes.

## Authoritative workflow and calculation contract (defined before implementation)

`finance_purchase_orders` holds current amount, requester_id, area_id, revision and status. `finance_po_revisions` holds immutable submitted snapshots; never sum revisions. `finance_po_approvals` is per revision and slot. Two distinct actors and no changes-requested action on the current revision are required by `finance_private.revision_approved`. History is `finance_private.history`, exposed through the existing filtered `finance_po_history` view. Its notification trigger remains untouched.

| Current PO status/action | Current budget bucket |
|---|---|
| draft / created / edited back to draft | None |
| awaiting_approval / submitted or resubmitted / one approval | Requested |
| changes_requested | None; resubmission is required |
| approved with authoritative current-revision approvals | Committed |
| submitted_to_school with authoritative current-revision approvals | Spent (operational school-submission basis, not bank settlement) |
| cancelled | None |

A PO contributes its current amount to exactly one bucket. Revisions, cancellations and approval resets change derived totals, never insert spending copies. Lead Coach capability comes from active lead_coach_1/2 positions; Finance approval from active finance_lead. School submission remains finance_assignments-based. Existing mentor/admin explicit override and distinct-person rules remain in the original mutation function.

## Funding definitions

All amounts are USD numeric(14,2). Expected income is planning only. Actual funding = starting funds + received income. Restricted received income automatically funds only its designated category; it is never in general Unallocated. Editable category allocation is the **unrestricted allocation**. Category funded allocation = unrestricted allocation + restricted received income. Total allocated sums these funded allocations. Unallocated = starting funds + unrestricted received income − unrestricted allocations. Expected restricted income is shown separately and does not fund a category yet.

Category available = allocation + restricted received income − Requested − Committed − gross Spent + credits. Gross Spent = school-submitted POs + manual expenses. Equivalently, category available = funded allocation − Requested − Committed − net Spent. The reporting field `spent` is already net of credits; do not add credits a second time when using that field. Net Spent = school-submitted POs + manual expenses − credits. Overall available funding uses the same impact subtraction from actual funding, including uncategorized associated POs. Expected funding and reserve are never silently added/subtracted. Negative availability warns rather than prohibiting legitimate purchases. Reserve is a warning only. Transfers move unrestricted allocations only; restricted funding cannot be transferred into the general pool. Negative unallocated during planning is visible; transfers from Unallocated require actual unallocated funds.

## Season boundaries and legacy POs

No backfill. On the next submit/approval/school-submit action, an unassociated PO is bound to the then-active season, if any. Binding never changes automatically. Before any Finance-slot approval on a bound/active-season PO, category selection is mandatory, including mentor overrides; Coach approval never requires coding. Without an active or previously bound season V1 remains operational. Authorized budget leaders can explicitly categorize legacy POs into an open season; once associated they cannot move seasons. Archived categories retain history but cannot receive new coding. Closed seasons reject financial mutations; close requires no unfinished bound POs (including draft/changes-requested), preventing active purchasing from becoming stranded. Only `cancelled` and `submitted_to_school` are resolved for closing; drafts, awaiting approval, changes requested and approved POs block closing. No exceptional close override is necessary: the existing workflow permits unresolved POs to be completed or canceled. No override or closed-season correction path is added; no automatic rollover.

## Authorization and audit

Active mentors/admins retain full budget authority. Active student/lead accounts require an unrevoked assignment to an active position explicitly classified in finance_private.budget_positions. Seeded classifications are the existing program/functional student leadership keys, not base-role lead or editable display labels. Mentors/admins can classify additional existing positions from Finance Settings with a reason. This changes only budget authority, never PO or other-app capabilities. Current database state is rechecked on every request.

All budget mutations serialize with a Finance budget advisory lock and use season-level optimistic versioning. PO workflow mutations take the same lock and increment the bound season version. All budget writes and audit records commit atomically. Existing Finance history is extended with nullable season/category references; no second audit store. Budget actions do not match notification actions and do not enqueue emails.

## Final model decisions (confirmed)

The final decisions are implemented without migration changes: school submission means Spent; changes-requested releases Requested; restricted receipts automatically augment their category; general allocations exclude restricted money; close requires an empty unfinished PO pipeline. Credits may exceed spending and produce negative net Spent (visible, never clamped).

## Files and local review

Local checkout: `/Users/aiden/Documents/GitHub/4418-finance-v2a`, branch `feature/finance-v2a`, based on deployed `a89a435`. Original Finance checkout has pre-existing unrelated edits and is untouched. Migration: `supabase/migrations/202609200001_finance_budget_core.sql`. Services/UI: `src/budget-service.ts`, `src/BudgetWorkspace.tsx`, `src/budget.css`, and narrow integration in `src/main.tsx`. No Suite Auth/header changes.

## Manual rollout, after model approval (not executed)

1. Review the migration against the confirmed financial contract above. No financial-model decision remains outstanding for the specified formulas or closing rules.
2. Run `docs/FINANCE-V2A-PREFLIGHT.sql` read-only on production. Compare current signatures and audit trigger with this inspection. Confirm the old public mutation is `(text,jsonb) returns uuid`, Team Positions exist, and no pre-existing `finance_private.mutate_v1` conflicts. The migration moves the installed function unchanged; it does not replace its workflow body with an older copy.
3. Take the standard database backup. Apply **only** `202609200001_finance_budget_core.sql` once in the SQL editor, as one transaction. No historical financial backfill, seed data, notifications, or other migrations.
4. Before the frontend, verify a manager can call `finance_budget_context()` and an ordinary student gets `can_manage:false`; inspect the grant/revoke results and active-position classifications. Do not send real approvals or notification emails as a smoke test. With no active season, legacy PO actions retain V1 behavior.
5. Build this Finance checkout with the existing public environment configuration and deploy only Finance after explicit approval. Preserve existing Suite Auth configuration and notification worker.
6. On desktop and an actual iPhone Safari, verify Hub handoff, Dashboard/PO navigation, `#po/{id}`, budget setup, income/expense forms and sign-out. Automated WebKit covers the frontend layouts, not a physical iPhone.
7. Create a draft season deliberately, review the activation summary, then activate with leadership confirmation. Categorize legacy relevant POs explicitly; no historical records are automatically assigned. After activation, Finance-slot approval requires the new category selector; do not roll back to a frontend without that selector while budgets are active.
8. Budget tables/history are never deleted for rollback. If needed, roll back frontend only before activation; otherwise coordinate a reviewed corrective migration. Do not restore the old public mutation in a way that bypasses budget requirements.

Income type is a free-text label, not a new configuration subsystem. Categories with history are archived, never deleted. Manual expenses and credits are append-only; correct an expense with an explicitly reasoned credit/adjusting record. Closed seasons are immutable with no exceptional correction UI in V2A. Full audit records remain in the existing Finance history.

## Local validation completed

- 87 focused tests passed: budget financial/security model, existing PO database behavior, v6 notification database/worker behavior, and PO/V2A browser flows.
- Six additional WebKit checks passed at 390px and 1440px: workspace navigation/forms, Finance approval/deep links, ordinary-student privacy, and empty setup.
- TypeScript and configured production build passed. Vite reports a 507 KB minified JS chunk (146 KB gzip); no architectural bundling changes were added in this phase.
- Browser checks use controlled fixtures. Database migrations execute only in local PGlite. Production access was read-only schema/view inspection. No production financial writes, real emails, migration application, frontend deployment, charts or Excel export.
- Physical iPhone Safari verification remains a manual rollout check; shared Suite Auth/header files are unchanged.

Changed files: `src/main.tsx`, `src/BudgetWorkspace.tsx`, `src/budget-service.ts`, `src/budget.css`; `supabase/migrations/202609200001_finance_budget_core.sql`; `tests/budget-db.spec.ts`, `tests/budget-ui.spec.ts`, `tests/database.spec.ts`, `tests/notification-db.spec.ts`, `tests/ui.spec.ts`; this document and `FINANCE-V2A-PREFLIGHT.sql`.

## Final-decision verification

Eight focused financial-model tests passed after confirming the final decisions. Assertions explicitly cover expected income exclusion, restricted receipts benefiting only their assigned category, and category credits counted exactly once. No migration or implementation changes were required; no migration was applied and nothing was deployed.

## Production backend rollout — 2026-09-20

Preflight matched the reviewed production assumptions immediately before application. Verified native pg_dump backup: `/Users/aiden/Documents/IMPULSE-backups/2026-09-20-finance-v2a-pre-migration/production.dump` (checksum and recovery notes alongside). Applied only `202609200001_finance_budget_core.sql` once, in its BEGIN/COMMIT transaction.

Post-migration read-only checks: all 5 active mentors and 2 active admins receive budget context; the ordinary student receives `can_manage:false`. All 11 intended student-leadership keys are classified. No student currently holds a designated leadership assignment in production; active/revoked/archived/inactive assignment behavior and Finance Lead capability independence are covered by focused database tests. Existing PO, revision, approval, assignment and history record fingerprints are unchanged; the installed V1 mutation body and every other pre-existing application function are unchanged, as is the Finance history notification trigger. Budget tables have RLS and the private V1 mutation is not callable by authenticated clients. Zero seasons exist. No financial smoke-test writes or emails were sent.

The earlier local-only/application-pending notes above describe the review stage; this entry records the completed backend rollout. Frontend deployment is tracked separately by its GitHub Pages workflow.

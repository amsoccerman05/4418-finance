# Received purchase orders

## Workflow

After a fully approved PO is marked **Submitted to school**, a designated school submitter or active mentor/admin can **Mark received**. This records completion of the whole PO, not a partial shipment, payment, or Inventory stock receipt. An optional note (up to 2,000 characters) is retained with the server-recorded actor and timestamp.

The existing approval order, two distinct current-revision approvers, requester visibility, school-submission facts, and locked post-submission metadata are unchanged. Students, position-based approvers, area leads, and `finance_admin` capability holders do not gain receiving authority unless they already hold school-submission authority. The new **Received purchase orders** table contains only rows visible under the existing Finance RLS rules.

Receipt is terminal: edits, cancellation, resubmission, further approval, repeated school submission, and repeated receipt are rejected. Stale versions fail with the normal refresh message. A failed action does not append history or change the PO. No existing orders are automatically marked received.

## Data and reporting

`finance_purchase_orders` adds `received_by`, `received_at`, and `receipt_note`. `finance_mutate('receive', {id, version, note})` accepts only `submitted_to_school` orders with the existing two approvals and submission facts; caller-supplied actor/time/status fields are ignored. The private audit receives one `receive` event with before/after snapshots and the note in `reason`, so the existing student-safe history projection can display it.

Received POs retain their single **spent** budget impact, school reference, and approval dates. Receiving is not another expense. The selected-season workbook RPC includes receipt facts. A season can close with submitted or received POs as before; the existing **closed-season mutation lock is retained**, so a submitted PO in an already-closed season cannot be newly marked received. No season is reopened automatically.

Existing notification functions and delivery authorization are unchanged. Receipt is an in-app audited event, not a new email event; it does not resend submission notifications. The migration preserves the installed approval/budget mutation implementation as a private, non-client-callable delegate.

## Review and release gates

Migration: `20261027204114_finance_po_received.sql`.

1. Compare the installed `finance_mutate`, `finance_private.mutate_v1`, `finance_budget_manage`, `finance_workbook_context`, `finance_private.po_impacts`, grants, and RLS with the reviewed repository. Confirm Team Positions, Finance V2C, student-access, and notification-authorization migrations are deployed. Existing shared Attendance notification functionality must remain untouched.
2. The migration has fail-closed source guards for the two replaced reporting/budget functions. If either differs from reviewed source (including formatting), stop and reconcile the deployed customization; do not delete or bypass the guard. The existing PO mutation function is retained verbatim rather than replaced.
3. After explicit approval, apply only this additive migration in a transaction. It extends allowed states and adds empty receipt fields; it performs no historical receipt backfill and no Inventory, credential, payment, or notification changes.
4. Only after migration verification, deploy the reviewed frontend through the existing explicit Finance workflow. A PR is not deployment permission. Do not deploy the new UI before its RPC migration.
5. Verify with synthetic records in an authorized non-production environment: normal approval → school submission → receipt, table/detail/history, restricted roles, stale/repeated clicks, mobile layout, and unchanged totals. Never alter real POs just to test the release.

## Automated verification

`tests/received-po-db.spec.ts` uses disposable PGlite PostgreSQL and fictitious identities. It covers trusted receipt facts, migration non-backfill and source-drift protection, role boundaries, revoked access, all earlier states, invalidated approvals, stale/repeated mutations, direct-write denial, RLS, audit redaction, notification non-duplication, workbook/financial continuity, and closed-season behavior. The existing core database and budget suites also apply this migration so their original workflow regressions exercise the new wrapper.

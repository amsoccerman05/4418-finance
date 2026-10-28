# Dashboard attention visibility

The dashboard previously removed its entire Needs attention panel when the
signed-in account had no actionable approvals or school submissions. This made
the intentional self-approval exclusion look like missing Finance access. Budget
managers also lost that panel when no budget season was selected.

The panel now remains visible independently of budget access or season selection.
An empty action queue is explicitly explained. A separate **Waiting for independent
review** section links to an already-visible, self-requested PO when the account's
assigned approval slot is still pending. That link opens existing status/details;
it is not an approval action and never submits or mutates a PO.

The explanation specifies a different mentor/admin who has not already approved
the current revision, an explicit override reason, and two different approvers.
Finance administration alone does not confer an override or school-submission
permission. No database, role, grant, RLS policy, approval predicate, or mutation
endpoint changes are included. All records still come from the existing RLS-filtered
Finance queries. No new production data is fetched by the panel.

Verification uses synthetic local fixtures only: self-requested pending approvals,
current/stale approval revisions, Finance-only administration, ordinary actionable
approvals, designated school submission, empty/no budget access, reload, return to
results, and mobile/desktop rendering. No real purchase orders are changed.

Release requires the normal explicit frontend merge/deploy approval; no migration
or additional production privilege is needed.

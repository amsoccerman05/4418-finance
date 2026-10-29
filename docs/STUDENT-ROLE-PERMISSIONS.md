# Student roles and independent Coach approval

Current proposed correction: apply Hub
`20261029190339_canonical_roles_mentor_administration.sql` before Finance
`20261029190421_finance_canonical_roles.sql`. These follow the already-deployed
October 28 role migrations; never reapply the old release.
The coordinator applies exact reviewed migrations; never bulk-push historical SQL.
Do not deploy this frontend until the shared schema is verified.

- Readonly retains existing PO/history/Google Sheet visibility, but cannot change
  even an old owned PO. Role changes are rechecked after blocking PO and budget
  locks. Denied editor writes preserve unsaved text and never retry automatically.
- Every active Student can create and submit their own request for approval,
  without Attendance registration, primary-area or position prerequisites.
- Admin Lead inherits Lead access and becomes a designated school submitter and
  receiver. This includes **all non-draft POs across areas**, not others' drafts.
  Role alone grants no approval, budget management, financial administration,
  override or other-owner editing. Existing explicit capabilities/positions retain
  their semantics; Readonly/inactive status overrides them.
- The supported account roles are Readonly, Student, Lead, Admin Lead and Mentor.
  There is no Owner Admin alias. The separately approved Hub migration owns the
  single existing Owner Admin account transition to Admin Lead; Finance changes
  no accounts or assignments. Unknown legacy roles fail closed.
- An active Mentor with a live Lead Coach1/2 assignment may
  normally approve **only their own Coach step**. A different assigned Finance
  Lead must supply Finance. Student/Lead/Admin Lead profiles cannot self-approve
  via an accidental Coach assignment. Normal own request-changes is not added.
- New authority proofs are server-derived and bound to approval ID, PO, revision,
  actor, slot and action. Both approval orders work atomically; submission and
  receipt recheck the proven quorum. One person cannot fill both steps.
- A legacy normal Finance vote can join this new flow only when non-override and
  its different actor is currently active assigned Finance Lead; otherwise the
  UI explains resubmission. Old approvals/history are never rewritten. Existing
  reasoned Mentor emergency overrides outside the new marked flow remain.
  Existing authorized Admin votes/history remain valid; that old account role no
  longer permits any new staff override or own-Coach approval.
- Budget totals remain whole-season amounts. PO detail and PO-specific history
  projections follow normal PO visibility, including embedded history payloads.

The correction replaces fifteen existing function bodies using exact live-source
drift guards; it adds no functions or privileges. Existing table ACLs,
RLS, function ownership/ACLs, records and assignments are preserved. No role or
assignment backfill occurs in Finance. The existing explicit-filtered `finance_po_history`
view is not converted or granted broader access.

## Verification and artifact isolation

`npm run build` creates production `dist`. `npm test` runs models then builds a
separate `.playwright-dist` using fake configuration. Browser fixtures serve exact
built asset bytes, reject unknown HTTP/WebSocket traffic, use literal role facts,
and never use real accounts. The exact known font stylesheet is locally empty
(fallback fonts). Production dist/config hashes are checked before and after.
Only `dist` is packaged for Pages.

The native CI gate owns a disposable loopback PostgreSQL cluster and unique
synthetic databases, rejects external DSNs/service config, observes real lock
waits, and verifies committed demotion rejects the write without business/audit/
notification changes. Native and browser tests must execute in hosted CI; local
socket restrictions are not worked around. All four repository checks and the
coordinator's shared schema/Edge clearance are required before merge/deployment.

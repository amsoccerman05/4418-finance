# Finance V1 schema review

## Shared contracts (read-only)

Finance reads `profiles(id, display_name, role, active, primary_area_id)`, `areas(id, name, active)`, and `team_attendance_members(student_id, member_status)`. The migration fails before creating Finance objects if these contracts are missing. Areas are the same shared taxonomy already referenced by profiles: no duplicate Finance area table, seed, renamed area, or Inventory item/stock/location dependency. Existing area names remain authoritative, including any inactive historical area referenced by a PO.

Registration currently lives in Attendance's separate member metadata. Active registered students may create; active leads and Finance administrators may also create. Prospective/inactive students do not gain creation permissions. A former registered but still active requester can still finish their own existing PO. Changing this policy later requires changing `finance_private.creator`, not the shared profile schema.

## Five tables

- `finance_purchase_orders`: stable UUID, human PO number, requester/area, current metadata, lifecycle state, revision/version, and school-submission facts. Amounts are positive finite USD values with two decimals. No totals are written into another app.
- `finance_po_revisions`: immutable submitted metadata snapshots keyed by `(po_id, revision)`.
- `finance_po_approvals`: append-only slot/action records with actor, timestamp, reason and explicit override reason. Approved slot uniqueness is scoped to PO/revision. Changes-requested actions remain in history.
- `finance_assignments`: current Finance-only capabilities, with every change recorded in history.
- `finance_po_history`: append-only RPC activity including before/after metadata, assignment changes and reasons. No client has insert/update/delete permission on audit or approval tables.

All five tables use RLS and authenticated SELECT-only privileges. Writes happen through fixed-search-path SECURITY DEFINER functions. No backend secret exists in the client. Public/anonymous execute is explicitly revoked. Database owners remain privileged and should use RPCs for normal workflow mutations.

## RPCs / invariants

`finance_context()` supplies trusted capabilities, shared areas and a minimum visible-name directory; only administrators get the full active assignment picker.

`finance_mutate(action, p)` implements `create`, `edit`, `submit`, `approve`, `request_changes`, `school_submit`, `cancel`, `assignment`. PO mutations lock the row and require the current version. Stale actions fail rather than overwrite.

- Draft starts at revision 0. Every submission/resubmission increments revision and snapshots metadata.
- **All saved edits**, including notes/date changes, conservatively return the PO to Draft. Old approvals are retained but cannot authorize school submission. The requester must explicitly resubmit.
- Either designated slot may approve first. Two distinct people must approve the current revision. Normal self-approval is denied. Active mentor/admin or `finance_admin` may act outside assignments or on their own request only with a nonempty audited override reason. Even overrides cannot let one person provide both approvals.
- A changes request requires an explanation and returns the PO to the requester. No other approval may complete until resubmission.
- Fully approved current-revision records are required for school submission, including for administrators. A designated school submitter or Finance administrator records actor/time/reference/note. This never actually sends the sheet.
- Submitted/cancelled POs are locked against normal edits/resubmission. Cancellation requires a reason and preserves history.
- Student visibility is own POs; a lead can additionally see non-draft POs in their profile's area. Assigned approvers/school submitters see submitted workflow records, not other students' drafts. Administrators see all. Revision/history access follows PO visibility.

## Limits to review

The external sheet is not snapshotted, scraped or monitored. Finance cannot detect changes made only inside Google Sheets. Students are instructed to resubmit after such edits even when the tracked metadata is unchanged. Old revision links may point to the same edited sheet; the metadata snapshot is immutable, not the external document.

Each slot can have multiple eligible assigned users for coverage, but only one approval is recorded for that slot/revision. An approval remains a historical authorization if that person's assignment later changes; new approvals always check the current active assignment. All explanations are plain text rendered by React.

## Future Finance V2

PO UUIDs and shared area UUIDs are stable. Future budgets/allocations can add nullable foreign keys to the PO or a separate allocation link without replacing revisions, approval actions, or history. No speculative budget table, unused budget foreign key, editable spending total, or Inventory stock linkage is included. Current amounts represent PO metadata, not actual expenses.

## Suite authentication and deployment

The existing Hub broker remains the only production session owner. Finance uses exact-origin/source-checked postMessage and in-memory access tokens, never cross-subdomain cookies or URL-token handoffs. Tests exercise real broker messaging, a single credential login, a second origin acquiring that session, logout propagation, and protected re-entry with mocked Auth responses.

The local Hub change is only the additional exact Finance origin. Review it alongside the migration. Do not deploy Finance or the broker allowlist before approving this release. No owner-level Supabase action has been performed.

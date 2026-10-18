# Finance delivery authorization

## What changes

Queued Finance email is reauthorized immediately before every provider call, after rendering and freezing the provider request. This also applies to retries of already-frozen messages. An active broad-role account alone is no longer sufficient.

The new server-only `finance_notification_delivery_allowed(notification_id, token)` RPC:

- Binds the check to an email notification's current sending lease, Finance PO, recipient, and authoritative `finance_private.history` event.
- Requires an active student, lead, mentor, or admin with current access to that PO.
- Rechecks the event audience using current Team Hub positions, current Finance capabilities, and authoritative requester/approval history. It supports both legacy `approval_remaining` and current `approval_recorded` notifications.
- Retains the current explicit school-submitter audience and the existing bounded Mentor/Admin fallback. Requester and historical-approver notification coverage remains, subject to current PO visibility.
- Does not use rendered/frozen payload fields, client-supplied recipient IDs, or changes to `auth.uid()` to authorize delivery.
- Revokes function execution from PUBLIC, anon, and authenticated; only service_role is granted execution. Its definer search path is empty.

An explicit false result skips the notification with `recipient_no_longer_eligible`. RPC failure, including an expired still-owned lease, sends nothing and uses the existing bounded retry/review handling. The provider request and idempotency key remain frozen. Unknown notification sources fail closed.

The recipient visibility predicate intentionally mirrors `finance_private.visible` without impersonating a JWT. If Finance's PO visibility rules change, update this predicate and its tests together. Approval capabilities use the shared Team Hub position model, not obsolete Finance approver assignments.

## Shared Team Hub compatibility

This is an additive migration. It does not replace `team_notification_claim`, `team_notification_prepare`, `team_notification_finish`, or the Team Hub announcement RPC. The worker still calls `team_announcement_delivery_allowed(notification_id)` for Hub email and now rechecks it after preparation as well.

The database tests load an exact fixture of the shared Hub claim replacement from Team Hub commit `6f8b7b92eb847a6e840efa2285fba0bb14db1437`. Tests verify that applying the new migration leaves that definition intact and preserves email-only claiming. They do not replay every Hub migration or establish production database state.

## Review and rollout

Prepared against Finance main commit `9ede1a8b87965ac3767a51341bc20cf8c275960d`. No live database queries, migration application, production email, or deployment were performed while preparing this fix.

1. Review the additive migration `20261018051306_finance_notification_delivery_authorization.sql`, the worker changes, and CI results. Before an authorized rollout, confirm the deployed shared schema has Finance V1, Team Management positions, and Finance notification coverage, and compare current visibility/claim definitions with the reviewed source.
2. Apply this new migration once through the approved manual database process. Do not reapply old Finance or Hub migrations. Verify the new RPC's signature, fixed search path, and service-role-only execution grants in the target database; run the appropriate database security advisors during that separately authorized rollout.
3. Deploy the updated `finance-notifications` Edge Function. The database change alone does not fix the old worker. Deploying the worker first fails closed when the RPC is unavailable, but may exhaust bounded retries, so migration-first ordering avoids that interruption.
4. Verify with synthetic accounts/POs and a controlled delivery destination: authorized delivery, position/capability revocation before delivery, revocation after preparation, frozen-request retry, and an unavailable eligibility RPC. Confirm Hub announcement delivery still works.
5. Inspect skipped/retry/review outcomes without exposing message content or credentials. No queue backfill is part of this change. Do not automatically replay skipped or review rows without separately reviewing current authorization and provider idempotency windows.

For a rollout failure, keep the patched worker failing closed or pause the dispatcher through an approved operational change. Do not restore the old worker while dispatch continues, since that restores the disclosure defect. The additive RPC can remain installed.

There is no atomic transaction spanning PostgreSQL authorization and an external email provider. The final check observes committed access at check time; revocation after that check cannot retract an email already handed to the provider or delivered. This fix removes the queued/retried stale-authorization path; it is not an email-recall guarantee.

## Verification

Run the normal repository suite with `npm test` and the build with `npm run build`. Focused tests:

```sh
npx playwright test tests/notification-db.spec.ts tests/notification-worker.spec.ts
```

Regressions cover revoked Finance Lead/Lead Coach positions even with retained PO visibility, school-submitter revocation, current fallback limits, inactive/readonly accounts and position catalog entries, lost PO visibility, unknown/mismatched events and spoofed payloads, service-only grants, lease validity, every supported event audience, shared claim preservation, revocation during prepare and frozen retry, and fail-closed/retry behavior on eligibility errors.

Database tests use real repository SQL and isolated synthetic PGlite data with fixture prerequisites; worker tests use mocked delivery. They do not inspect production Auth, RLS, deployed migration history, network/provider behavior, or production security-advisor findings.

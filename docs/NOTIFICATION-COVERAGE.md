# Finance email coverage

Authoritative `finance_private.history` actions are `created`, `edit`, `submit`, `approve`, `request_changes`, `cancel`, `school_submit`, and `assignment`. Only submit, approve, request_changes, cancel and school_submit enqueue workflow email. Resubmission is `submit` with revision > 1. Viewing, editing drafts and assignments send no email.

- Submit/resubmit: current active Lead Coaches and Finance Lead, excluding requester/actor.
- First approval: requester plus remaining eligible approvers; includes approval slot and actor.
- Final approval: one combined approval/ready-for-school message to requester and explicit school submitters; existing capped Mentor/Admin fallback remains.
- Changes requested: requester, with explanation.
- Cancel: requester and current/prior involved approvers for the current submitted revision; draft cancellation does not notify uninvolved approvers.
- School submission: requester and actual current-revision approvers.

Recipients are distinct, active, eligible accounts; the actor is excluded. Existing outbox uniqueness, frozen requests, leases, retries, provider idempotency and asynchronous delivery are unchanged. No historical backfill is executed. The branded renderer adds cancellation/approval wording. The existing worker’s error handling remains unchanged.

Apply only `202609190001_finance_notification_coverage.sql`, deploy `finance-notifications`, then frontend changes. `202609120004` and the worker baseline are now tracked for reproducible tests; they already exist in production and must not be reapplied.

Finance now handles `#po/{uuid}` links once authorized orders load; inaccessible IDs never open a detail view.

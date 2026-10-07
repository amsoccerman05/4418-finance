# Active student purchase requests

## Change

`20261007011342_allow_all_active_student_purchase_requests.sql` replaces only `finance_private.creator()`.

Previously, a student needed an active `profiles` record and an Attendance membership marked `registered`. After this migration, an active `student` profile is sufficient. Attendance registration may be missing, prospective, registered, or inactive; the profile itself must still be active. Existing lead, mentor, admin, and Finance-admin creation permissions are preserved.

The helper remains in the private schema, with a fixed empty search path and its existing execution privileges. `CREATE OR REPLACE` preserves the existing ACL; the migration adds no grants or public RPCs.

## Boundaries

- The database assigns requester and actor IDs from `auth.uid()`. Client-supplied identities cannot create a PO for someone else.
- Student visibility remains limited to their own POs and the existing filtered revision, approval, and history views. No budget access or broader financial-record access is added.
- Students use the existing save-draft, submit, changes-requested, edit, and resubmit workflow. No submitted-to-school or cancelled PO is unlocked.
- Finance Lead and Lead Coach remain separate approval slots requiring two distinct people. Normal requester self-approval is blocked, and no student gains an override.
- Only existing authorized users can record school submission, manage assignments, or manage budgets. The existing audited mentor/admin emergency policy is unchanged.
- No profile, attendance, approval position, purchase order, payment, invoice, or notification record is changed by the migration.

## Verification

- `tests/student-request-access.spec.ts` executes the actual SQL in a disposable PGlite database with fictitious identities. It checks newly eligible students, denial cases, ownership, RLS, approval boundaries, repeated submission, and reapplying the migration.
- `tests/database.spec.ts` includes the new migration in the existing approval and authorization regression suite.
- `tests/ui.spec.ts` checks desktop and mobile creation/submission/resubmission for a student with no registration metadata or leadership position, including disabled controls while save/submit is pending.
- Browser tests intercept every backend request and never send production records or emails.

## Release

1. Review the access expansion and confirm permission to apply it to the shared Supabase project.
2. Run the full automated test suite and build from the reviewed source.
3. Apply only this additive migration. Do not rerun initial schema migrations.
4. Verify the installed helper definition and ACL, evaluate `finance_context().can_create` for existing active student profiles using read-only checks, and compare security advisors with the pre-change baseline.
5. Existing Finance pages pick up eligibility on refresh or sign-in. No frontend or Team Hub deployment is required.

The migration is repeatable. It does not make create retries idempotent across a lost response; the existing UI disables duplicate in-flight actions, and the database's version/status checks reject repeated submissions without adding another revision.

## Unchanged role-transition behavior

An active requester whose profile is later changed to `readonly` cannot create another PO, but the existing mutation function still permits editing, submitting, or cancelling that requester's own unlocked POs. This pre-existing exception is unchanged by the creator-only migration; denying those continuation actions would require a separate policy change. Inactive profiles remain denied.

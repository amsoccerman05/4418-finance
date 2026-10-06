# Repair → existing purchase order bridge

Status: **staged local migration; not applied to production**. This slice attaches an existing Finance PO to a Pit repair. It does not create a PO, submit a sheet, purchase anything, change repair readiness, or send notifications.

## Dependencies and ownership

Apply only after review of the installed Pit Operations and Finance contracts in the same shared database. The migration checks the required Pit table and permission functions before creating objects. It changes no existing table, permission rule, function, trigger, authentication setting or publication.

- Migration: `supabase/migrations/20261005235435_finance_repair_po_links.sql`
- Private append-only storage: `finance_private.repair_po_links`
- Unique pair: `(issue_id, po_id)`; multiple POs per repair and multiple repairs per PO are supported.
- Audit: server-controlled `linked_by`, `linked_at`, observed `issue_updated_at`, and required reason. Duplicate pair requests retain the original audit row.
- RLS is enabled and direct table privileges are revoked from public, anonymous, authenticated and service roles. Only the three role-checked RPC projections are exposed to authenticated callers.
- No unlink, replacement or create-and-link endpoint exists in this slice.

The Pit migration copy in `tests/fixtures/pit_operations.sql` is **test-only**. Never apply it separately. It is byte-identical to `amsoccerman05/4418-pit-app` main `82195caaf89b57d6127faa5bc28174e34ac8fdbf`, path `supabase/migrations/202609090001_pit_operations.sql` (SHA-256 `8529d5f24b7ed59399878854481665140f95866782066e9b2f7253753fefd92b`).

## Exact RPC contract

All UUIDs are strings. Timestamps are server strings: forward `issue_updated_at` unchanged. Do not round through JavaScript `Date`, which can lose PostgreSQL microsecond precision.

### Load visible links

`finance_repair_context({ p_issue_id: issueId })`

```ts
{
  issue_id: string;
  issue_updated_at: string;
  can_attach: boolean;
  links: Array<{
    po_id: string;
    po_number: number;
    status: string;
    requester_name: string;
    linked_at: string;
  }>;
}
```

An active Pit reader can load context. `can_attach` expresses the existing repair-edit role gate only: active `lead`, `mentor` or `admin`. It does not promise permission to attach a particular PO.

Links include **only** POs permitted by `finance_private.visible(po_id)` for this caller. There is no total, hidden count, hidden placeholder, vendor, amount, Sheet URL, requester UUID, attachment reason or actor in the response. The display name falls back to `Team member` when blank. Status and requester are read live from Finance; they are not copied into link storage.

An empty list means “No purchase orders visible here,” not proof that no other links exist.

### Preview one pasted PO before confirmation

`finance_repair_po_candidate({ p_issue_id: issueId, p_po_id: poId })`

```ts
{
  issue_id: string;
  issue_updated_at: string;
  po_id: string;
  po_number: number;
  status: string;
  requester_name: string;
  can_attach: boolean;
}
```

This is a single-PO preview, not a search or directory. It requires active Pit read access, an existing repair, and existing Finance visibility for that PO. `can_attach` also requires the repair-edit role **and** either `po.requester_id = auth.uid()` or existing `finance_private.admin()` authority. Ordinary Finance approval authority or repair assignment alone does not confer attachment permission.

Show the number, status and requester, request an explicit reason, and require a separate “Link this PO” confirmation. If the input or selected repair changes, discard the previous preview and load the new candidate. Never use a previous candidate's success to authorize a different UUID.

### Attach the reviewed candidate

`finance_attach_repair_po({ p_issue_id, p_po_id, p_expected_issue_updated_at, p_reason })`

Returns the same context shape as `finance_repair_context`, including the newly visible PO link. Use the unmodified timestamp from the current candidate/context.

The server checks authority, locks the repair then PO, and rechecks current repair-edit authority, Finance visibility and PO ownership/admin authority after both locks. A role or capability revoked while the request waits cannot use the earlier check. It validates a trimmed reason of 1–2000 characters containing a non-whitespace character and requires the exact repair timestamp. A unique pair replay is a no-op only after these validations. The function inserts one private relationship/audit row and nothing else.

PO drafts, approved, school-submitted and cancelled records retain their existing Finance state and access rules. Linking does not revise them. `submitted_to_school` must never be relabeled purchased/received/installed. “PO requester” and “Repair owner” remain separate concepts.

## Failure and rollout handling

- `42501` + `Repair purchasing details unavailable`: use one generic unavailable message for hidden, missing and unauthorized records. Do not reveal which record exists.
- `22023`: invalid reason; preserve input and ask for a valid reason.
- `40001`: repair changed; refresh context and preview, then require another explicit confirmation. Do not retry automatically.
- `22P02`: malformed UUID input; reject it in the UI before invoking the RPC where possible.
- Missing function/schema cache (`PGRST202` for the expected bridge RPC, or `42883` from SQL): show “Repair purchasing links are not available yet,” keep existing repair tools working, and disable bridge writes. Do not fall back to broad tables, another RPC, a guessed schema, or a production migration.
- Treat permission/network/timeout failures as unavailable/error states, not empty links. On an uncertain attachment result, refresh the authorized context. A matching returned pair confirms the existing attachment; otherwise keep the outcome unconfirmed and do not auto-retry.
- Refresh when opening the repair or after explicit attachment. A failed refresh must not present cached status as current. Clear caller-specific state on sign-out/account change.

Open a returned PO only at the fixed Finance origin: `https://finance.frc4418.org/#po/{UUID}`. The Finance app performs its own visibility checks again. No tokens or financial details belong in URLs.

Deploying a client before the reviewed migration is safe only when the missing-bridge handling above is present. Applying this migration, changing auth/settings, or deploying either app is outside this local implementation.

## Tests

`tests/repair-po-links.spec.ts` uses local PGlite with the real Finance, shared-position, notification, budget and Pit migrations. It covers exact projection/signatures, role combinations, Finance visibility, inaccessible IDs, unique-pair replay, multiple links, stale writes, current role revocation, private audit access, live status, missing dependencies, and absent bridge behavior.

The side-effect test snapshots PO rows, approvals, revisions, budgets, Finance history, Pit repair/history and the notification outbox before/after an attachment and requires exact equality. Requests queued with `Promise.all` test replay uniqueness in PGlite; they are not evidence of independent database connections.

Run `npm test -- tests/repair-po-links.spec.ts` and the existing database/notification regression tests. No test sends real notifications or reads production data.

### Native PostgreSQL concurrency and authorization gate

`tests/native-postgres/repair_po_concurrency.py` complements PGlite with a disposable native PostgreSQL server and genuine concurrent libpq connections. It starts a fresh synthetic-only cluster on an ephemeral `127.0.0.1` TCP port, disables Unix sockets, ignores ambient PostgreSQL connection settings, and accepts no DSN or existing database. It needs Python 3 and an installed native PostgreSQL distribution (`postgres`, `initdb`, `pg_ctl`, and libpq); no Python or npm package is added. Run it as an unprivileged OS user:

```sh
PG_BIN_DIR=/path/to/postgresql/bin python3 tests/native-postgres/repair_po_concurrency.py
```

The runner loads the same Finance, shared-position, notification, budget and Pit fixtures as the PGlite bridge suite. Each test creates its own database; teardown stops the server and deletes its temporary synthetic cluster. It never applies a migration to an existing database or contacts Supabase.

The 13 native cases cover:

- Same-pair concurrent replay, retaining the first actor/reason/timestamp, and distinct PO links serialized on the same repair.
- An actual `pit_update_issue` committed while attachment waits, rejected with `40001` and no relationship row.
- An uncommitted attachment rolled back while another caller waits; only the surviving caller's audit is retained.
- Repair role revocation during either the repair-lock wait or the PO-lock wait, and revocation during replay.
- Active-account revocation, Finance-admin capability revocation, and loss of PO ownership/visibility while waiting.
- Native RLS/grants, editor-role boundaries, anonymous rejection, direct-table denial and caller-filtered projections.
- Exact before/after snapshots across 13 Finance/Pit/history/outbox tables, including populated approvals, revisions, budgets and notifications.

Ordering is enforced by observing `pg_blocking_pids` from a third connection before releasing the blocker, rather than relying on a timed sleep to create races. Calls run at PostgreSQL's default `READ COMMITTED` isolation. The attachment function remains `VOLATILE`, allowing its post-lock queries to use fresh snapshots. PostgreSQL documents the relevant [function snapshot semantics](https://www.postgresql.org/docs/16/xfunc-volatility.html) and [row-lock behavior](https://www.postgresql.org/docs/16/transaction-iso.html).

Verified locally on **PostgreSQL 16.15, Linux x86-64** on 2026-10-06: **13/13 native cases passed**, including repeated clean-cluster runs. The same final migration passed **98/98 existing SQL/pure regressions** (including all 22 PGlite bridge cases), and `npm run build` passed its TypeScript/build checks. The initial native run reproduced three role-revocation failures before the post-lock recheck was added; all three then passed. This closes the local native concurrency/auth gate. It does not verify a deployed Supabase API, installed production schema, or a different transaction isolation setting; those remain separate release checks requiring authorization.

For a reproducible source-only installation where PostgreSQL is absent, use an official distribution. The verification run built [PostgreSQL 16.15](https://www.postgresql.org/ftp/source/v16.15/) in a temporary directory from `postgresql-16.15.tar.bz2`, SHA-256 `c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`, checked against the official checksum file, then configured with `--prefix=<temporary-install> --without-readline --without-icu`, built with `make -j4`, and installed into that temporary prefix. No system service, credentials, database migration, push or deployment is part of this gate.

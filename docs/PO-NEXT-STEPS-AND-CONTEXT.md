# Clear next steps and return to purchase-order results

Frontend-only: no schema, permission, approval, receiving, budget, or PO data changes.

- Each PO state has a plain-English next step. The summary links to the existing
  action/status section, rather than submitting an action. It honors requester,
  assigned approver, mentor/admin override and distinct-person approval rules.
- **Back to results** closes a PO and restores its list position. Editors still
  require Keep editing, explicit Save draft, or Discard before leaving with edits.
- Search, status, approval, area/vendor/requester filters, expanded filters and
  list scroll position survive a PO visit, workspace navigation and reload in the
  current browser tab. Removed filter options are cleared rather than hidden.
- Navigation metadata is allowlisted and stored only in sessionStorage, scoped to
  the authenticated user. Sign-out and account changes synchronously clear it,
  and stale old-account callbacks cannot write it back. Blocked/corrupt storage
  falls back to normal navigation. No PO fields, Sheet URLs, notes, credentials,
  unsaved edits or approval/submission/receiving form values are stored.
- Hub's **Request a purchase** destination is exactly
  `https://finance.frc4418.org/?action=request-purchase`. It waits through sign-in
  and Finance capability loading, then opens a blank form only when allowed.
  Handling or cancelling the intent removes just that query parameter with
  replaceState, so Close, Back/Forward, reload or account switching cannot replay
  it. It never creates/submits a PO. Existing suite broker and callback handling
  preserve the query through sign-in; unrelated query parameters are preserved.

## Verification

- `npm run build`: TypeScript and production build.
- `node --test scripts/*.test.mjs`: guard, SSO, next-step states/role boundaries,
  storage validation, privacy, unavailable storage and account reset tests.
- `npx playwright test tests/database.spec.ts tests/student-request-access.spec.ts tests/received-po-db.spec.ts`:
  disposable PostgreSQL approval, requester and receiving permissions.
- `tests/next-steps-context.spec.ts`: 390px/1440px list context/scroll restoration,
  guarded return, one-shot signed-out shortcut, denied capability, account reset,
  pending-load account-switch interruption and every PO state's navigation target.
- `tests/sso.spec.ts`: real cross-origin broker protocol with mocked Auth, including
  the new request shortcut through sign-in, reload and shared sign-out.
- Existing browser suites, including unfinished forms, remain in the aggregate
  `npm test` gate. Browser tests use intercepted fixtures only, never real POs.

Local browser execution remains blocked by the established environment browser
restriction; release requires full CI browser success for the final commit.

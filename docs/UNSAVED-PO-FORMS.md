# Unfinished purchase-order protection

This frontend-only change is separate from the Received PO rollout. It does not
change SQL, RLS, roles, approvals, submission, receiving or real purchase orders.

## Behavior

- Closing an edited PO or pressing Escape asks **Keep editing**, **Save draft**
  or **Discard changes**. Keep editing is the default focus. Escape from this
  confirmation keeps the form; Discard discards only the unsaved edits, not the
  existing saved purchase order.
- **Save draft** remains visible in the editor's sticky action bar. A draft is
  saved only after an explicit click and a successful existing `create`/`edit`
  RPC. It never automatically submits for approval. Existing required fields,
  Google Sheet validation, version checks and approval-reset behavior remain.
- Missing fields or save errors leave entered values in place. Failed saves
  cancel any pending leave action so a later ordinary save does not unexpectedly
  navigate away. Pending saves disable repeated actions.
- Open a saved draft from Purchase orders and choose **Resume draft** to edit it.
- A valid Sheet link can be opened in a new tab directly from the editor; Finance
  remains open. Same-user refresh/refocus auth events do not unmount a dirty
  editor. Ordinary auth refreshes still reload Finance when no dirty form exists;
  sign-out, account changes and password recovery still clear the editor.
- Same-document Finance hash navigation and Back/Forward retain the open form,
  without adding or rewriting browser-history entries. Leaving the document or
  reloading while dirty requests the browser's native leave warning.

## Limits and privacy

There is **no automatic save and no form data in localStorage/sessionStorage**.
Drafts use the existing authenticated server workflow only. Incomplete required
fields cannot be persisted under the existing draft schema; choose Keep editing
and complete those fields before saving.

Native leave-warning wording/buttons are controlled by the browser. Warnings
cannot be guaranteed on mobile process termination, crashes or forced shutdown.
The visible guidance therefore asks users to save a draft before leaving.

## Verification

- `npm run build`: TypeScript and production build.
- `node --test scripts/*.test.mjs`: guard state transitions, failure/retry,
  one-shot continuations, account boundaries and existing suite-auth tests.
- `npx playwright test tests/database.spec.ts tests/student-request-access.spec.ts tests/received-po-db.spec.ts`:
  disposable local PostgreSQL permission, approval, requester and receiving tests.
- `npx playwright test tests/unsaved-po.spec.ts`: browser scenarios at 390px and
  1440px, unchanged/dirty forms, Close/Escape/focus, discard, save/resume, required
  fields, failure/retry, separate Sheet tab, Back/Forward, canceled reload and
  same-user versus changed-account auth events. All APIs are intercepted fixtures.

Browser tests must run in a browser-capable environment before publication.
The full aggregate suite was not completed locally: its default Playwright browser
executable is absent, and this workspace has a previously established Chromium
socket-sandbox restriction. No browser verification is claimed from unit or build
results.

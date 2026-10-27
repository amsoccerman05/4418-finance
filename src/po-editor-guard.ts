/** In-memory only: never store PO contents or submit an approval action. */
export function createPOEditorGuard(changed: () => void = () => {}) {
  let dirty = false;
  let pending: (() => void) | null = null;
  let afterSave: (() => void) | null = null;
  const reset = () => {
    dirty = false;
    pending = null;
    afterSave = null;
    changed();
  };
  return {
    get dirty() { return dirty; },
    get confirming() { return pending !== null; },
    setDirty(value: boolean) {
      if (dirty !== value) { dirty = value; changed(); }
    },
    requestLeave(action: () => void) {
      if (!dirty) { action(); return; }
      // Repeated Close/Escape must not execute or stack leave actions.
      pending ??= action;
      changed();
    },
    keepEditing() { pending = null; afterSave = null; changed(); },
    discard() {
      const action = pending;
      reset();
      action?.();
    },
    beginSaveAndLeave() {
      afterSave = pending;
      pending = null;
      changed();
    },
    saveFailed() { afterSave = null; changed(); },
    saved() {
      const action = afterSave;
      reset();
      return action;
    },
    reset,
    beforeUnload(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    },
  };
}

/** Refresh/refocus events are not an account switch. Real sign-out still clears data. */
export function preservesPOEditor(event: string, previousId: string | null, nextId: string | null) {
  return !!previousId && previousId === nextId &&
    ["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"].includes(event);
}

export function poFormSnapshot(form: HTMLFormElement) {
  return JSON.stringify(Array.from(new FormData(form).entries()));
}

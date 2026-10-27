/** Navigation only. Never pass editor fields, PO records, notes, or auth tokens. */
export type POListContext = {
  search: string; status: string; area: string; vendor: string;
  requester: string; approval: string; moreFilters: boolean; scrollY: number;
};
export const PO_LIST_CONTEXT_KEY = '4418-finance-po-list-v1';
export const emptyPOListContext = (): POListContext => ({
  search: '', status: '', area: '', vendor: '', requester: '', approval: '', moreFilters: false, scrollY: 0,
});
const statuses = ['', 'draft', 'awaiting_approval', 'changes_requested', 'approved', 'submitted_to_school', 'received', 'cancelled'];
const approvals = ['', 'mine', 'waiting', 'ready', 'submitted', 'received', 'finance_approver', 'po_approver'];
function normalize(value: unknown): POListContext {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const str = (key: string, max = 200) => typeof raw[key] === 'string' ? (raw[key] as string).slice(0, max) : '';
  return {
    search: str('search'), status: statuses.includes(str('status')) ? str('status') : '',
    area: str('area', 100), vendor: str('vendor'), requester: str('requester', 100),
    approval: approvals.includes(str('approval')) ? str('approval') : '', moreFilters: raw.moreFilters === true,
    scrollY: typeof raw.scrollY === 'number' && Number.isFinite(raw.scrollY) ? Math.max(0, Math.min(raw.scrollY, 10_000_000)) : 0,
  };
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function createPOListContextStore(storage: () => StorageLike | null) {
  let activeUser: string | null = null;
  const clear = () => { try { storage()?.removeItem(PO_LIST_CONTEXT_KEY); } catch { /* Private/blocked storage is optional. */ } };
  const stored = (): { userId?: unknown; context?: unknown } | null => {
    try { const value = JSON.parse(storage()?.getItem(PO_LIST_CONTEXT_KEY) || 'null'); return value && typeof value === 'object' ? value : null; }
    catch { clear(); return null; }
  };
  return {
    setUser(userId: string | null) {
      // Enforce account boundaries synchronously, including stale unmount/scroll callbacks.
      if (!userId || (activeUser && activeUser !== userId) || (stored() && stored()?.userId !== userId)) clear();
      activeUser = userId;
    },
    read(userId: string) {
      if (!userId || activeUser !== userId) return emptyPOListContext();
      const value = stored();
      return value?.userId === userId ? normalize(value.context) : emptyPOListContext();
    },
    save(userId: string, context: POListContext) {
      if (!userId || activeUser !== userId) return;
      try { storage()?.setItem(PO_LIST_CONTEXT_KEY, JSON.stringify({ userId, context: normalize(context) })); } catch { /* Navigation still works without storage. */ }
    },
    clear,
  };
}
export const poListContextStore = createPOListContextStore(() => window.sessionStorage);

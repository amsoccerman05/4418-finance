import { rpc } from "./service";
export type Season = {
  id: string;
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  starting_funds: number;
  reserve_target: number;
  status: "draft" | "active" | "closed";
  version: number;
};
export type Category = {
  id: string;
  name: string;
  description: string;
  display_order: number;
  active: boolean;
  allocation: number;
  forecast: number | null;
  restricted: number;
  expected: number;
  funded: number;
  requested: number;
  committed: number;
  spent: number;
  available: number;
};
export type Summary = {
  season: Season;
  starting_funds: number;
  received: number;
  expected: number;
  restricted: number;
  actual_funding: number;
  allocated: number;
  unallocated: number;
  requested: number;
  committed: number;
  spent: number;
  credits: number;
  available: number;
  categories: Category[];
};
export type Income = {
  id: string;
  source: string;
  income_type: string;
  amount: number;
  status: string;
  expected_on: string | null;
  received_on: string | null;
  category_id: string | null;
  reference: string;
  notes: string;
};
export type Expense = {
  id: string;
  kind: string;
  category_id: string;
  amount: number;
  payee: string;
  occurred_on: string;
  reason: string;
  reference: string;
};
export type Budget = {
  can_manage: boolean;
  can_classify?: boolean;
  seasons: Season[];
  summary: Summary | null;
  income: Income[];
  expenses: Expense[];
  history: {
    id: number;
    po_id?: string | null;
    revision?: number;
    action: string;
    actor_name: string;
    created_at: string;
    details: { reason: string; before: unknown; after: unknown };
  }[];
  po_links: {
    po_id: string;
    category_id: string | null;
    po_number: number;
    vendor: string;
    amount: number;
    status: string;
    bucket: string;
    revision?: number;
    area_id?: string;
  }[];
  uncategorized: {
    po_id: string;
    po_number: number;
    vendor: string;
    amount: number;
    status: string;
  }[];
  positions: { key: string; name: string; enabled: boolean }[];
};
export const loadBudget = (season?: string) =>
  rpc("finance_budget_context", { season: season || null }) as Promise<Budget>;
export const budgetMutate = (action: string, p: Record<string, unknown>) =>
  rpc("finance_budget_manage", { action, p });
export type ApprovalBudget = {
  required: boolean;
  season_id?: string;
  category_id?: string;
  categories: (Category & { projected_available: number })[];
};
export const approvalBudget = (po_id: string) =>
  rpc("finance_budget_approval", { po_id }) as Promise<ApprovalBudget>;

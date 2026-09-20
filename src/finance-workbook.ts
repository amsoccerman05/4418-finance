import type { Budget, Income, Expense } from "./budget-service";
import { object, spendingMonths } from "./finance-reporting";
import { label } from "./service";
import XlsxPopulate from "xlsx-populate/browser/xlsx-populate-no-encryption.min.js";

type Stamp = { created_by: string; created_at: string };
export type ExportPO = {
  id: string;
  po_number: number;
  vendor: string;
  purpose: string;
  requester: string;
  functional_area: string;
  category: string | null;
  amount: number;
  revision: number;
  status: string;
  bucket: string;
  submitted_at: string | null;
  approved_at: string | null;
  school_submitted_at: string | null;
  school_reference: string;
  updated_at: string;
  approvals: {
    slot: string;
    action: string;
    actor: string;
    acted_at: string;
  }[];
};
export type WorkbookData = {
  generated_at: string;
  budget: Omit<Budget, "income" | "expenses" | "history"> & {
    income: (Income & Stamp)[];
    expenses: (Expense &
      Stamp & { po_id: string | null; expense_id: string | null })[];
    history: (Budget["history"][number] & {
      season_id: string | null;
      category_id: string | null;
      details: Record<string, unknown>;
    })[];
  };
  purchase_orders: ExportPO[];
  people: Record<string, string>;
};
const currency = '"$"#,##0.00;[Red]("$"#,##0.00);"$"0.00';
const dateFormat = "yyyy-mm-dd",
  timestampFormat = "yyyy-mm-dd hh:mm:ss";
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
export function workbookFilename(name: string) {
  return `4418_Finance_${
    name
      .normalize("NFKC")
      .replace(/[–—]/g, "-")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "Season"
  }.xlsx`;
}
// Values are always written as literal cell values, never interpreted as formulas.
function date(value: string | null | undefined) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? (ms - Date.UTC(1899, 11, 30)) / 86400000
    : undefined;
}
function utc(value: string) {
  return new Date(value).toISOString();
}
function amount(value: unknown) {
  return typeof value === "number"
    ? value
    : typeof value === "string" &&
        value !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}
export async function buildFinanceWorkbook(
  data: WorkbookData,
  template: ArrayBuffer,
): Promise<Blob> {
  const b = data.budget,
    s = b.summary;
  if (!b.can_manage || !s)
    throw new Error("Select a season with budget access.");
  const season = s.season,
    w = await XlsxPopulate.fromDataAsync(template),
    summary = w.sheet(0);
  const cat = (id: unknown) =>
    s.categories.find((c) => c.id === id)?.name ||
    (id ? String(id) : "Unallocated");
  const po = (id: unknown) =>
    data.purchase_orders.find((p) => p.id === id)?.po_number;
  const title = `FRC Team 4418 · IMPULSE | ${season.name} · ${label(season.status)}`;
  // The exact snapshot timestamp is on the Summary; the template has no personal metadata.
  for (const sheet of w.sheets()) sheet.cell("A2").value(title);
  const table = async (
    index: number,
    rows: unknown[][],
    widths: number[],
    moneyCols: number[] = [],
    dateCols: number[] = [],
    timeCols: number[] = [],
    empty = "No records for this season",
  ) => {
    const sh = w.sheet(index),
      n = widths.length,
      last = Math.max(5, rows.length + 4);
    widths.forEach((width, i) => sh.column(i + 1).width(width));
    sh.range(5, 1, last, n).style({
      fill: "FFFFFF",
      fontFamily: "Calibri",
      fontSize: 11,
      verticalAlignment: "top",
      wrapText: true,
    });
    if (rows.length) {
      for (let start = 0; start < rows.length; start += 250) {
        sh.range(start + 5, 1, Math.min(start + 250, rows.length) + 4, n).value(
          rows
            .slice(start, start + 250)
            .map((row) => row.map((v) => (v == null ? undefined : v))),
        );
        await pause();
      }
    } else
      sh.cell("A5").value(empty).style({ italic: true, fontColor: "526277" });
    for (let row = 5; row <= last; row++)
      if (row % 2 === 0) sh.range(row, 1, row, n).style("fill", "F1F5F9");
    moneyCols.forEach((col) =>
      sh.range(5, col, last, col).style("numberFormat", currency),
    );
    dateCols.forEach((col) =>
      sh.range(5, col, last, col).style("numberFormat", dateFormat),
    );
    timeCols.forEach((col) =>
      sh.range(5, col, last, col).style("numberFormat", timestampFormat),
    );
    sh.autoFilter(sh.range(4, 1, last, n));
    sh.definedName("_xlnm.Print_Area", sh.range(1, 1, last + 2, n));
    return sh;
  };
  summary.range("A4:J20").style("fill", "FFFFFF");
  summary.range("A4:C4").merged(true).value("Season status");
  summary.range("D4:J4").merged(true).value(label(season.status));
  summary.range("A5:C5").merged(true).value("Generated (UTC)");
  summary.range("D5:J5").merged(true).value(utc(data.generated_at));
  const totals: [string, number][] = [
    ["Starting / rollover funds", s.starting_funds],
    ["Received income", s.received],
    ["Total actual funding", s.actual_funding],
    ["Allocated (including restricted)", s.allocated],
    ["Unallocated (unrestricted)", s.unallocated],
    ["Requested", s.requested],
    ["Committed", s.committed],
    ["Spent (net of credits)", s.spent],
    ["Available funding", s.available],
    ["Reserve target · planning", season.reserve_target],
    ["Expected income · not cash", s.expected],
  ];
  totals.forEach(([name, value], i) => {
    const row = i + 7;
    summary.range(row, 1, row, 6).merged(true).value(name);
    summary
      .range(row, 7, row, 10)
      .merged(true)
      .value(Number(value))
      .style("numberFormat", currency);
    summary
      .range(row, 1, row, 10)
      .style({
        fontSize: 12,
        fill: i === 10 ? "FFF2D3" : i % 2 ? "F1F5F9" : "FFFFFF",
        bold: [2, 8].includes(i),
      });
    summary.row(row).height(23);
  });
  const dates = spendingMonths(b as Budget, "", data.generated_at.slice(0, 10));
  summary
    .range("A19:J19")
    .merged(true)
    .value(
      "Expected income and reserve are planning only. Restricted receipts fund only their category.",
    )
    .style({ wrapText: true, fontSize: 10 });
  summary
    .range("A20:J20")
    .merged(true)
    .value(
      `Dated spending: ${dates.missing} missing date(s); ${dates.outside} future-dated record(s) excluded. Income update dates are unavailable and left blank.`,
    )
    .style({ wrapText: true, fontSize: 10 });
  summary.row(20).height(30);
  // Chart series bind to exact ranges through the template's names. Negative values
  // remain negative (including net credits/overspend); chart data is never clamped.
  const chartColumn = (
    name: string,
    col: number,
    values: (string | number)[],
  ) => {
    const v = values.length ? values : [""];
    summary.range(2, col, v.length + 1, col).value(v.map((x) => [x]));
    summary.definedName(
      "Export" + name,
      summary.range(2, col, v.length + 1, col),
    );
  };
  chartColumn(
    "Categories",
    16,
    s.categories.map((c) => c.name),
  );
  (["spent", "committed", "requested", "available"] as const).forEach(
    (key, i) =>
      chartColumn(
        ["Spent", "Committed", "Requested", "Remaining"][i],
        17 + i,
        s.categories.map((c) => Number(c[key])),
      ),
  );
  chartColumn(
    "Months",
    22,
    dates.months.map((m) => m.month),
  );
  chartColumn(
    "MonthlySpending",
    23,
    dates.months.map((m) => m.amount),
  );
  chartColumn("FundingLabels", 25, [
    "Starting funds",
    "Received income",
    "Expected · not cash",
  ]);
  chartColumn(
    "FundingValues",
    26,
    [s.starting_funds, s.received, s.expected].map(Number),
  );
  const credits = (id: string) =>
    b.expenses
      .filter((e) => e.category_id === id && e.kind === "credit")
      .reduce((n, e) => n + Math.round(Number(e.amount) * 100), 0) / 100;
  const categoryRows = s.categories.map((c) => [
    c.name,
    c.description,
    Number(c.allocation),
    Number(c.restricted),
    Number(c.funded),
    c.forecast == null ? undefined : Number(c.forecast),
    Number(c.requested),
    Number(c.committed),
    Number(c.spent) + credits(c.id),
    credits(c.id),
    Number(c.spent),
    Number(c.available),
    Number(c.funded) === 0
      ? undefined
      : (Number(c.requested) + Number(c.committed) + Number(c.spent)) /
        Number(c.funded),
    c.active ? "Active" : "Archived",
  ]);
  const budgetSheet = await table(
    1,
    categoryRows,
    [25, 36, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 14, 16],
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [],
    [],
    "No budget categories for this season",
  );
  budgetSheet
    .range(5, 13, Math.max(5, categoryRows.length + 4), 13)
    .style("numberFormat", "0.0%;[Red](0.0%)");
  if (categoryRows.length) {
    const row = categoryRows.length + 6;
    budgetSheet.cell(row, 1).value("Category totals");
    for (let col = 3; col <= 12; col++)
      budgetSheet
        .cell(row, col)
        .value(
          categoryRows.reduce(
            (n, r) =>
              n +
              (typeof r[col - 1] === "number"
                ? Math.round((r[col - 1] as number) * 100)
                : 0),
            0,
          ) / 100,
        )
        .style("numberFormat", currency);
    budgetSheet.range(row, 1, row, 14).style({ bold: true, fill: "D9E8E7" });
  }
  budgetSheet
    .range(categoryRows.length + 8, 1, categoryRows.length + 8, 14)
    .merged(true)
    .style({ fill: "FFFFFF", wrapText: true, fontSize: 10 })
    .value(
      "% used = (requested + committed + net spent) ÷ funded allocation. Blank when funded allocation is zero. Category totals exclude uncategorized POs.",
    );
  budgetSheet.row(categoryRows.length + 8).height(30);
  budgetSheet.definedName(
    "_xlnm.Print_Area",
    budgetSheet.range(1, 1, categoryRows.length + 8, 14),
  );
  const approval = (p: ExportPO, slot: string) =>
    p.approvals
      .filter((a) => a.slot === slot)
      .map(
        (a) =>
          `${label(a.action)} · ${a.actor || "Unknown actor"} · ${utc(a.acted_at)}${["draft", "cancelled", "changes_requested"].includes(p.status) ? " (historical; not current authorization)" : ""}`,
      )
      .join("\n") || "Not recorded";
  await table(
    2,
    data.purchase_orders.map((p) => [
      p.po_number,
      p.vendor,
      p.purpose,
      p.requester,
      p.functional_area,
      p.category || "Uncategorized",
      Number(p.amount),
      p.revision,
      label(p.status),
      label(p.bucket),
      approval(p, "po_approver"),
      approval(p, "finance_approver"),
      date(p.submitted_at),
      date(p.approved_at),
      date(p.school_submitted_at),
      p.school_reference,
      date(p.updated_at),
    ]),
    [12, 24, 42, 22, 22, 24, 18, 12, 24, 20, 42, 42, 23, 23, 23, 24, 23],
    [7],
    [],
    [13, 14, 15, 17],
    "No purchase orders associated with this season",
  );
  await table(
    3,
    b.income.map((i) => [
      i.source,
      i.income_type,
      label(i.status),
      Number(i.amount),
      date(i.expected_on),
      date(i.received_on),
      i.category_id ? cat(i.category_id) : "Unrestricted",
      i.reference,
      i.notes,
      data.people[i.created_by] || i.created_by,
      date(i.created_at),
      undefined,
    ]),
    [26, 22, 18, 18, 18, 18, 24, 24, 42, 22, 23, 23],
    [4],
    [5, 6],
    [11, 12],
    "No income recorded for this season",
  );
  await table(
    4,
    b.expenses.map((e) => [
      e.kind === "credit" ? "Credit / Refund" : "Manual Expense",
      date(e.occurred_on),
      cat(e.category_id),
      e.payee,
      Number(e.amount),
      e.po_id ? (po(e.po_id) ? `PO #${po(e.po_id)}` : e.po_id) : "",
      e.reference,
      e.reason +
        (e.expense_id ? `\nRelated manual expense: ${e.expense_id}` : ""),
      data.people[e.created_by] || e.created_by,
      date(e.created_at),
    ]),
    [22, 18, 24, 24, 18, 22, 24, 46, 22, 23],
    [5],
    [2],
    [10],
    "No manual expenses or credits for this season",
  );
  const readable = (value: unknown, path = ""): string => {
    if (value == null) return "";
    if (Array.isArray(value))
      return value.map((v, i) => readable(v, `${path}[${i + 1}]`)).join("\n");
    if (typeof value === "object")
      return Object.entries(object(value))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) =>
          readable(v, path ? `${path} › ${label(key)}` : label(key)),
        )
        .filter(Boolean)
        .join("\n");
    const text =
      typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    return `${path}: ${text}`;
  };
  const historyRows: unknown[][] = [];
  for (const h of b.history.filter((h) => h.action.startsWith("budget_"))) {
    const before = object(h.details.before),
      after = object(h.details.after);
    const rawBefore = readable(h.details.before),
      rawAfter = readable(h.details.after);
    const delta =
      amount(after.amount) !== undefined
        ? amount(after.amount)
        : amount(after.allocation) !== undefined
          ? Number(after.allocation) - Number(before.allocation || 0)
          : undefined;
    // Excel's cell text limit must never silently truncate an audit fact.
    for (
      let start = 0;
      start < Math.max(rawBefore.length, rawAfter.length, 1);
      start += 30000
    )
      historyRows.push([
        date(h.created_at),
        h.actor_name,
        label(h.action.replace(/^budget_/, "")) + (start ? " (continued)" : ""),
        season.name,
        h.category_id ? cat(h.category_id) : "",
        h.po_id ? (po(h.po_id) ? `PO #${po(h.po_id)}` : h.po_id) : "",
        rawBefore.slice(start, start + 30000),
        rawAfter.slice(start, start + 30000),
        start ? undefined : delta,
        h.details.reason || "",
      ]);
  }
  await table(
    5,
    historyRows,
    [23, 22, 26, 20, 24, 18, 60, 60, 18, 46],
    [9],
    [],
    [1],
    "No budget history for this season",
  );
  await table(
    6,
    b.history
      .filter((h) => h.po_id && !h.action.startsWith("budget_"))
      .map((h) => [
        date(h.created_at),
        po(h.po_id) ? `PO #${po(h.po_id)}` : h.po_id,
        h.actor_name,
        label(h.action),
        h.revision,
        [h.details.reason, h.details.override_reason]
          .filter(Boolean)
          .join("\n"),
      ]),
    [23, 18, 22, 26, 12, 60],
    [],
    [],
    [1],
    "No purchase order history for this season",
  );
  return w.outputAsync({ type: "blob" });
}

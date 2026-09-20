# Finance V2C — season workbook

Reports downloads the selected draft, active or closed season as `4418_Finance_<safe-season-name>.xlsx`. No financial records, calculations, PO actions, notification rules or Suite Auth behavior change.

## Read path and permissions

`finance_workbook_context(uuid)` is a stable, read-only security-definer RPC with an empty search path and authenticated-only execution. Every call checks the existing `finance_private.can_manage_budget()`. It reuses `finance_budget_context()` / `budget_summary()` and `po_impacts`, adding only selected-season PO metadata, current-revision approval records, and creator display names. It returns one statement-consistent snapshot and generation timestamp, with no Auth credentials or emails. Revoked, archived or inactive leadership is denied using the existing capability. This does not grant PO approval or other suite permissions.

The browser makes one reporting request, lazily loads the export library, and fills a data-free workbook template. No financial data is written to persistent browser storage or sent to another service. Duplicate clicks are blocked; generation yields between batches. Text is written as literal cell values (including formula-looking user text).

## Workbook

Seven stable sheets: Executive Summary, Budget, Purchase Orders, Income, Expenses & Credits, Budget History, PO History. All dates/times use UTC; missing dates remain blank. Income has no authoritative `updated_at`, so that column is blank and the Summary explains it. Current-revision fully approved POs use the latest authoritative approval timestamp; other POs do not receive an invented approval date.

Financial values come from the deployed summary. Budget gross spent is the reported net spent plus the separately recorded category credits; credits are positive records and are never added twice to availability. Category total rows sum displayed category values and explicitly exclude uncategorized POs. Percent used is `(requested + committed + net spent) / funded allocation`, blank for zero funding. Expected income remains planning-only; canceled income is never included in funding totals.

Three native Excel charts use worksheet-scoped named ranges: category net spent/committed/requested/remaining, dated net spending, and starting/received/expected funding. The existing V2B `spendingMonths` helper supplies dated data and missing/future-date counts. Negative net spending and availability remain negative. Empty sections retain headers and clear messages. Audit snapshots are labeled text, with continuation rows instead of truncation at Excel's cell limit.

The template uses restrained IMPULSE colors, filters, frozen headers, currency/date/percentage formats, conditional formatting and print setup. Excel resolves chart named ranges on opening; lightweight previewers that do not recalculate charts may show blank charts. All numeric tables remain immediately readable.

## Template maintenance

`public/finance-workbook.xlsx` contains no financial data. Rebuild with `python scripts/generate-workbook-template.py` after installing `XlsxWriter==3.2.9` in a temporary environment. Python is a development-only tool, not a browser, build or server dependency. Native chart/template creation uses [XlsxWriter](https://xlsxwriter.readthedocs.io/chart.html); browser filling/preservation uses [xlsx-populate](https://github.com/dtjohnson/xlsx-populate). Application code does not construct raw XLSX XML.

## Rollout and verification

Apply only `202609200002_finance_workbook.sql`, after confirming the deployed V2A helpers and required projection columns. This creates one read-only function and its grants; it creates no financial tables and changes no records. Deploy Finance frontend after RPC verification. Older frontends remain compatible.

Production preflight matched the installed financial helpers; the export projection planned against the existing schema. Focused database tests cover actual export calls as mentors/admins, Finance Lead and designated student leadership, and deny ordinary/revoked/archived/inactive users and anonymous execution. They also cover all season states, empty sections, current PO revisions/state, restricted/expected/canceled income and single-counted credits.

Browser checks download and reopen workbooks at desktop/phone widths, covering all seven sheets, key values, dates, native chart parts, styles, filters, frozen headers, literal formula-like text, errors and missing-season/access states. An independent OpenPyXL reader opens the result. Microsoft Excel 16.113 opens all seven sheets and resolves all three native chart series to the expected synthetic data. Physical iPhone downloads remain a manual device check; desktop/phone WebKit download checks are automated.

Production RPC verification (2026-09-20): all seven active mentor/admin profiles successfully called the export with authenticated permissions; the ordinary student was denied. Anonymous execution is revoked. All existing Finance row fingerprints, reviewed financial helper bodies and the history notification trigger are unchanged. No test financial records or emails were created. Local validation: eight focused database/Chromium tests plus five WebKit checks passed; TypeScript and the configured production build passed. The existing main bundle size warning remains; workbook code is a separate lazy-loaded chunk (~113 KB gzip).

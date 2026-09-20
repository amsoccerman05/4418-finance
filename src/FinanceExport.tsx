import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { rpc } from "./service";
import type { Season } from "./budget-service";
import type { WorkbookData } from "./finance-workbook";
export function FinanceExport({ season }: { season: Season }) {
  const lock = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function download() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const [data, lib, response] = await Promise.all([
        rpc("finance_workbook_context", {
          season: season.id,
        }) as Promise<WorkbookData>,
        import("./finance-workbook"),
        fetch(`${import.meta.env.BASE_URL}finance-workbook.xlsx`),
      ]);
      if (!response.ok)
        throw new Error("Workbook template unavailable. Please try again.");
      const blob = await lib.buildFinanceWorkbook(
        data,
        await response.arrayBuffer(),
      );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = lib.workbookFilename(data.budget.summary!.season.name);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(
        e &&
          typeof e === "object" &&
          "message" in e &&
          typeof e.message === "string"
          ? e.message
          : "Could not prepare the workbook. Please try again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="panel finance-export"
      aria-labelledby="finance-export-title"
    >
      <div>
        <span className="eyebrow">Exports</span>
        <h2 id="finance-export-title">Finance workbook</h2>
        <p>
          {season.name} · Complete season report with budget, POs, income,
          expenses, history and summary charts.
        </p>
      </div>
      <button type="button" onClick={download} disabled={busy}>
        <Download size={18} aria-hidden="true" />
        {busy ? "Preparing workbook…" : "Download Finance Workbook (.xlsx)"}
      </button>
      {busy && <span role="status">Preparing workbook…</span>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

import { ArrowLeft, ArrowRight, Download, Upload } from "lucide-react";
import { useState } from "react";
import { ExportPage } from "./ExportPage";
import { ImportPage } from "./ImportPage";
import { SimpleImportPage } from "./SimpleImportPage";

type TransferView = "overview" | "import" | "file-import" | "export";

const viewTitles: Record<Exclude<TransferView, "overview">, string> = {
  import: "Daten importieren",
  "file-import": "Aus Datei importieren",
  export: "Daten exportieren"
};

export function DataTransferPage() {
  const [view, setView] = useState<TransferView>("overview");

  return (
    <div className="page data-transfer-page">
      <header className="page-header data-transfer-header">
        <div>
          <h2>Importieren &amp; Exportieren</h2>
          <p>Daten einfach übernehmen oder als Datei sichern.</p>
        </div>
        {view !== "overview" && (
          <button className="data-transfer-back" type="button" onClick={() => setView(view === "file-import" ? "import" : "overview")}>
            <ArrowLeft size={19} aria-hidden="true" /> Übersicht
          </button>
        )}
      </header>

      {view === "overview" ? (
        <section className="data-transfer-choice-grid" aria-label="Datenübertragung auswählen">
          <button className="data-transfer-choice-card" type="button" onClick={() => setView("import")}>
            <span className="data-transfer-choice-icon"><Upload size={30} aria-hidden="true" /></span>
            <span className="data-transfer-choice-copy">
              <strong>Daten importieren</strong>
              <small>Kontakte und Kalender aus Programmen oder Dateien übernehmen.</small>
            </span>
            <ArrowRight size={22} aria-hidden="true" />
          </button>
          <button className="data-transfer-choice-card" type="button" onClick={() => setView("export")}>
            <span className="data-transfer-choice-icon"><Download size={30} aria-hidden="true" /></span>
            <span className="data-transfer-choice-copy">
              <strong>Daten exportieren</strong>
              <small>Kontakte oder Kalender übersichtlich als Datei speichern.</small>
            </span>
            <ArrowRight size={22} aria-hidden="true" />
          </button>
        </section>
      ) : (
        <section className="data-transfer-workspace" aria-labelledby="data-transfer-view-title">
          <div className="data-transfer-workspace-heading">
            <span>{view === "file-import" ? "Importieren" : "Import & Export"}</span>
            <strong id="data-transfer-view-title">{viewTitles[view]}</strong>
          </div>
          {view === "import" && <SimpleImportPage embedded onOpenFileImport={() => setView("file-import")} />}
          {view === "file-import" && <ImportPage embedded />}
          {view === "export" && <ExportPage embedded />}
        </section>
      )}
    </div>
  );
}

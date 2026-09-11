import { X } from "lucide-react";
import { SynchronizationsPage } from "../pages/SynchronizationsPage";

interface Microsoft365SyncDialogProps {
  context: "calendar" | "contacts";
  onClose: () => void;
}

export function Microsoft365SyncDialog({ context, onClose }: Microsoft365SyncDialogProps) {
  const areaLabel = context === "calendar" ? "Kalender" : "Kontakte";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="m365-sync-dialog-title">
      <section className="m365-sync-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="m365-sync-dialog-heading">
          <div>
            <p className="action-result-kicker">Microsoft 365 / Exchange</p>
            <h2 id="m365-sync-dialog-title">{areaLabel} synchronisieren</h2>
            <p>Konto, Anmeldung, Aktualisierung und Synchronisierung direkt hier verwalten.</p>
          </div>
          <button className="icon-only" type="button" aria-label="Fenster schließen" onClick={onClose}>
            <X size={22} />
          </button>
        </div>
        <SynchronizationsPage embedded onClose={onClose} />
      </section>
    </div>
  );
}

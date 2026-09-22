import { AlertTriangle, Save, Trash2, X } from "lucide-react";

interface UnsavedContactChangesDialogProps {
  open: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onContinueEditing: () => void;
}

export function UnsavedContactChangesDialog({
  open,
  busy,
  onSave,
  onDiscard,
  onContinueEditing
}: UnsavedContactChangesDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="unsaved-contact-title">
      <section className="form-panel modal-card unsaved-contact-dialog">
        <header className="panel-heading">
          <span className="unsaved-contact-icon" aria-hidden="true"><AlertTriangle size={24} /></span>
          <div>
            <h3 id="unsaved-contact-title">Nicht gespeicherte Änderungen</h3>
            <p>Dieser Kontakt wurde geändert. Was möchten Sie tun?</p>
          </div>
          <button className="icon-only" type="button" onClick={onContinueEditing} disabled={busy} aria-label="Weiter bearbeiten" title="Weiter bearbeiten">
            <X size={21} />
          </button>
        </header>
        <p className="unsaved-contact-explanation">
          Nach Ihrer Auswahl wird die gewünschte Seite oder der gewählte Kontakt geöffnet.
        </p>
        <div className="unsaved-contact-actions">
          <button type="button" onClick={onDiscard} disabled={busy}>
            <Trash2 size={18} aria-hidden="true" /> Änderungen verwerfen
          </button>
          <button className="primary" type="button" onClick={onSave} disabled={busy}>
            <Save size={18} aria-hidden="true" /> {busy ? "Wird gespeichert …" : "Speichern"}
          </button>
        </div>
      </section>
    </div>
  );
}

import { AlertTriangle, Save, Trash2, X } from "lucide-react";

interface UnsavedContactChangesDialogProps {
  open: boolean;
  busy: boolean;
  contactName: string;
  changes: UnsavedContactChange[];
  onSave: () => void;
  onDiscard: () => void;
  onContinueEditing: () => void;
}

export interface UnsavedContactChange {
  label: string;
  before: string;
  after: string;
}

export function UnsavedContactChangesDialog({
  open,
  busy,
  contactName,
  changes,
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
            <p>Sie haben „{contactName}“ geändert.</p>
          </div>
          <button className="icon-only" type="button" onClick={onContinueEditing} disabled={busy} aria-label="Weiter bearbeiten" title="Weiter bearbeiten">
            <X size={21} />
          </button>
        </header>
        <div className="unsaved-contact-summary" aria-describedby="unsaved-contact-question">
          <strong>Das haben Sie geändert:</strong>
          <div className="unsaved-contact-change-list">
            {changes.map((change) => (
              <div className="unsaved-contact-change" key={change.label}>
                <span className="unsaved-contact-change-label">{change.label}</span>
                <span className="unsaved-contact-change-values">
                  <del>{change.before}</del>
                  <span aria-hidden="true">→</span>
                  <ins>{change.after}</ins>
                </span>
              </div>
            ))}
          </div>
          <p id="unsaved-contact-question">Möchten Sie die Änderungen speichern oder verwerfen?</p>
        </div>
        <div className="unsaved-contact-actions">
          <button type="button" onClick={onDiscard} disabled={busy}>
            <Trash2 size={18} aria-hidden="true" /> Änderungen verwerfen
          </button>
          <button className="primary" type="button" onClick={onSave} disabled={busy}>
            <Save size={18} aria-hidden="true" /> {busy ? "Wird gespeichert …" : "Änderungen speichern"}
          </button>
        </div>
      </section>
    </div>
  );
}

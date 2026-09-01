import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, busy = false, busyLabel = "Wird verschoben …", onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <section className="form-panel modal-card confirm-dialog">
        <div className="confirm-dialog-icon"><AlertTriangle size={23} aria-hidden="true" /></div>
        <div className="confirm-dialog-content">
          <h3 id="confirm-dialog-title">{title}</h3>
          <p>{message}</p>
        </div>
        <div className="button-row confirm-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Abbrechen</button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

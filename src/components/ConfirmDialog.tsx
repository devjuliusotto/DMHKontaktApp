import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  notice?: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, notice, busy = false, busyLabel = "Wird verschoben …", onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <section className="form-panel modal-card confirm-dialog">
        <div className="confirm-dialog-icon"><AlertTriangle size={23} aria-hidden="true" /></div>
        <div className="confirm-dialog-content">
          <h3 id="confirm-dialog-title">{title}</h3>
          <p>{message}</p>
          {notice && <div className="confirm-dialog-notice"><CheckCircle2 size={18} aria-hidden="true" /> <span>{notice}</span></div>}
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

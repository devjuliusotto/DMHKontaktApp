import { Eye, EyeOff, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { useState, type FormEvent } from "react";

const edvPasswordSha256 = "923d72f89f878899e8324c05323c9d925ec895b57bf593f287e30f4a31b47c35";

interface EdvAccessDialogProps {
  onCancel: () => void;
  onUnlocked: () => void;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function EdvAccessDialog({ onCancel, onUnlocked }: EdvAccessDialogProps) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (await sha256(password) !== edvPasswordSha256) {
        setError("Das EDV-Kennwort ist nicht korrekt.");
        setPassword("");
        return;
      }
      onUnlocked();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop edv-access-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="modal-card edv-access-dialog" role="dialog" aria-modal="true" aria-labelledby="edv-access-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={unlock}>
        <header>
          <span className="edv-access-icon"><ShieldCheck size={30} aria-hidden="true" /></span>
          <div>
            <p>Geschützter Bereich</p>
            <h2 id="edv-access-title">EDV Tools</h2>
          </div>
          <button className="icon-only" type="button" onClick={onCancel} aria-label="Schließen"><X size={21} /></button>
        </header>
        <p className="edv-access-notice"><LockKeyhole size={20} /> Der Zugriff ist ausschließlich für die EDV bestimmt.</p>
        <label className="field">
          <span>EDV-Kennwort</span>
          <span className="password-input-wrap">
            <input autoFocus autoComplete="off" type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
            <button className="icon-only" type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Kennwort verbergen" : "Kennwort anzeigen"}>
              {visible ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </span>
        </label>
        {error && <p className="edv-access-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>Abbrechen</button>
          <button className="primary" type="submit" disabled={busy}><ShieldCheck size={19} /> EDV Tools öffnen</button>
        </div>
      </form>
    </div>
  );
}

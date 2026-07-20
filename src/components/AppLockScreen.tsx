import { Eye, EyeOff, KeyRound, LoaderCircle, Mail, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import {
  completeVaultRecovery,
  requestVaultRecovery,
  unlockVault
} from "../services/db";
import type { VaultRecoveryDelivery, VaultStatus } from "../types/vault";

interface AppLockScreenProps {
  status: VaultStatus;
  onUnlocked: (status: VaultStatus) => void;
}

export function AppLockScreen({ status, onUnlocked }: AppLockScreenProps) {
  const [mode, setMode] = useState<"login" | "request" | "code">("login");
  const [username, setUsername] = useState(status.username);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [delivery, setDelivery] = useState<VaultRecoveryDelivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onUnlocked(await unlockVault(username, password));
      setPassword("");
    } catch (unlockError) {
      setError(String(unlockError));
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await requestVaultRecovery(username);
      setDelivery(result);
      setMode("code");
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Die beiden neuen Kennwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    try {
      onUnlocked(await completeVaultRecovery(code, newPassword));
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (resetError) {
      setError(String(resetError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-lock-screen">
      <section className="app-lock-card" aria-labelledby="app-lock-title">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Kontakte und Kalender" />
        <div className="app-lock-icon" aria-hidden="true">
          {mode === "login" ? <ShieldCheck size={32} /> : <Mail size={32} />}
        </div>

        {mode === "login" && (
          <form onSubmit={login}>
            <h1 id="app-lock-title">App ist geschützt</h1>
            <p>Bitte melden Sie sich an, um Kontakte, Kalender und Passwörter zu öffnen.</p>
            <label className="field">
              <span>Benutzername</span>
              <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
            </label>
            <label className="field">
              <span>App-Kennwort</span>
              <span className="password-input-wrap">
                <input
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button className="icon-only" type="button" onClick={() => setShowPassword((shown) => !shown)} title="Kennwort anzeigen">
                  {showPassword ? <EyeOff size={21} /> : <Eye size={21} />}
                </button>
              </span>
            </label>
            {error && <p className="app-lock-error" role="alert">{error}</p>}
            <button className="primary large" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={22} /> : <KeyRound size={22} />}
              Entsperren
            </button>
            <button
              className="app-lock-link"
              type="button"
              disabled={!status.recoveryAvailable || busy}
              onClick={() => {
                setError("");
                setMode("request");
              }}
            >
              Kennwort vergessen?
            </button>
          </form>
        )}

        {mode === "request" && (
          <form onSubmit={requestCode}>
            <h1 id="app-lock-title">Kennwort wiederherstellen</h1>
            <p>Outlook Classic sendet einen Code an <strong>{status.recoveryEmailHint}</strong>.</p>
            <label className="field">
              <span>Benutzername bestätigen</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} required />
            </label>
            {error && <p className="app-lock-error" role="alert">{error}</p>}
            <button className="primary large" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={22} /> : <Mail size={22} />}
              Code per E-Mail senden
            </button>
            <button className="app-lock-link" type="button" disabled={busy} onClick={() => setMode("login")}>Zurück zur Anmeldung</button>
          </form>
        )}

        {mode === "code" && (
          <form onSubmit={resetPassword}>
            <h1 id="app-lock-title">Code eingeben</h1>
            <p>Der Code wurde an <strong>{delivery?.recoveryEmailHint}</strong> gesendet und ist {delivery?.expiresInMinutes} Minuten gültig.</p>
            <label className="field">
              <span>6-stelliger Code</span>
              <input className="recovery-code-input" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required />
            </label>
            <label className="field">
              <span>Neues App-Kennwort</span>
              <input autoComplete="new-password" minLength={8} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
            </label>
            <label className="field">
              <span>Neues Kennwort wiederholen</span>
              <input autoComplete="new-password" minLength={8} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
            </label>
            {error && <p className="app-lock-error" role="alert">{error}</p>}
            <button className="primary large" type="submit" disabled={busy || code.length !== 6}>
              {busy ? <LoaderCircle className="spin" size={22} /> : <ShieldCheck size={22} />}
              Neues Kennwort speichern
            </button>
            <button className="app-lock-link" type="button" disabled={busy} onClick={() => setMode("request")}>Neuen Code anfordern</button>
          </form>
        )}
      </section>
    </main>
  );
}

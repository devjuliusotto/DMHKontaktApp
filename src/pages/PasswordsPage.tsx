import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import {
  configureVaultProtection,
  deleteVaultEntry,
  disableVaultProtection,
  getVaultStatus,
  listVaultEntries,
  lockVault,
  saveVaultEntry
} from "../services/db";
import type { VaultEntry, VaultEntryInput, VaultStatus } from "../types/vault";

const emptyEntry: VaultEntryInput = {
  platform: "",
  username: "",
  password: "",
  url: "",
  description: ""
};

interface PasswordsPageProps {
  status: VaultStatus;
  onStatusChanged: (status: VaultStatus) => void;
}

export function PasswordsPage({ status, onStatusChanged }: PasswordsPageProps) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [detailPasswordVisible, setDetailPasswordVisible] = useState(false);
  const [entryPasswordVisible, setEntryPasswordVisible] = useState(false);
  const [entryForm, setEntryForm] = useState<VaultEntryInput | null>(null);
  const [protectionOpen, setProtectionOpen] = useState(false);
  const [protectionUsername, setProtectionUsername] = useState(status.username);
  const [protectionEmail, setProtectionEmail] = useState(status.recoveryEmail);
  const [protectionPassword, setProtectionPassword] = useState("");
  const [protectionPasswordAgain, setProtectionPasswordAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de");
    if (!query) return entries;
    return entries.filter((entry) =>
      [entry.platform, entry.username, entry.url, entry.description]
        .some((value) => value.toLocaleLowerCase("de").includes(query))
    );
  }, [entries, search]);

  const refresh = async () => {
    const result = await listVaultEntries();
    setEntries(result);
    setSelectedId((current) => current && result.some((entry) => entry.id === current) ? current : null);
  };

  useEffect(() => {
    refresh().catch((error) => {
      setMessageType("error");
      setMessage(`Passwörter konnten nicht geladen werden: ${error}`);
    });
  }, []);

  const openNewEntry = () => {
    setSelectedId(null);
    setEntryForm({ ...emptyEntry });
    setEntryPasswordVisible(false);
    setMessage("");
  };

  const openEditEntry = (entry: VaultEntry) => {
    setEntryPasswordVisible(false);
    setEntryForm({
      id: entry.id,
      platform: entry.platform,
      username: entry.username,
      password: entry.password,
      url: entry.url,
      description: entry.description
    });
  };

  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!entryForm) return;
    setBusy(true);
    setMessage("");
    try {
      const id = await saveVaultEntry(entryForm);
      await refresh();
      setEntryForm(null);
      setSelectedId(id);
      setMessageType("success");
      setMessage("Der Passwort-Eintrag wurde verschlüsselt gespeichert.");
    } catch (error) {
      setMessageType("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (entry: VaultEntry) => {
    if (!window.confirm(`„${entry.platform}“ wirklich löschen?`)) return;
    setBusy(true);
    try {
      await deleteVaultEntry(entry.id);
      setSelectedId(null);
      setEntryForm(null);
      await refresh();
      setMessageType("success");
      setMessage("Der Passwort-Eintrag wurde in den Papierkorb verschoben.");
    } catch (error) {
      setMessageType("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (value: string, label: string) => {
    await writeText(value);
    setMessageType("success");
    setMessage(`${label} wurde kopiert. Die Zwischenablage wird nach 30 Sekunden geleert.`);
    window.setTimeout(async () => {
      try {
        if (await readText() === value) await writeText("");
      } catch {
        // Die Zwischenablage wurde bereits geändert oder ist nicht mehr verfügbar.
      }
    }, 30_000);
  };

  const toggleRowPassword = (event: MouseEvent, id: number) => {
    event.stopPropagation();
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openProtection = () => {
    setProtectionUsername(status.username);
    setProtectionEmail(status.recoveryEmail);
    setProtectionPassword("");
    setProtectionPasswordAgain("");
    setProtectionOpen(true);
    setMessage("");
  };

  const saveProtection = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    if (protectionPassword !== protectionPasswordAgain) {
      setMessageType("error");
      setMessage("Die beiden App-Kennwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    try {
      const nextStatus = await configureVaultProtection(
        protectionUsername,
        protectionEmail,
        protectionPassword
      );
      onStatusChanged(nextStatus);
      setProtectionOpen(false);
      setProtectionPassword("");
      setProtectionPasswordAgain("");
      setMessageType("success");
      setMessage("Der App-Schutz ist eingerichtet. Beim nächsten Start ist eine Anmeldung erforderlich.");
    } catch (error) {
      setMessageType("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const disableProtection = async () => {
    if (!window.confirm("App-Schutz wirklich deaktivieren? Die Passwort-Einträge bleiben weiterhin lokal verschlüsselt.")) return;
    setBusy(true);
    try {
      const nextStatus = await disableVaultProtection();
      onStatusChanged(nextStatus);
      setMessageType("success");
      setMessage("Der App-Schutz wurde deaktiviert. Die Einträge bleiben verschlüsselt gespeichert.");
    } catch (error) {
      setMessageType("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const lockApplication = async () => {
    setRevealed(new Set());
    setDetailPasswordVisible(false);
    setEntries([]);
    onStatusChanged(await lockVault());
  };

  const closeSelectedEntry = () => {
    setSelectedId(null);
    setEntryForm(null);
    setDetailPasswordVisible(false);
    setEntryPasswordVisible(false);
  };

  return (
    <div className="page passwords-page">
      <header className="page-header">
        <div>
          <h2>Passwörter</h2>
          <p>Zugangsdaten lokal und verschlüsselt auf diesem Windows-PC speichern.</p>
        </div>
        <div className="passwords-header-actions">
          {status.protectionEnabled && (
            <button type="button" onClick={lockApplication}><Lock size={21} /> App sperren</button>
          )}
          <button className="primary" type="button" onClick={openNewEntry}><Plus size={22} /> Passwort hinzufügen</button>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className={status.protectionEnabled ? "vault-protection-card enabled" : "vault-protection-card"}>
        <span className="vault-protection-icon">
          {status.protectionEnabled ? <ShieldCheck size={27} /> : <ShieldOff size={27} />}
        </span>
        <div>
          <strong>{status.protectionEnabled ? "App-Schutz ist aktiv" : "App-Schutz ist noch nicht aktiviert"}</strong>
          <p>
            {status.protectionEnabled
              ? `Anmeldung als ${status.username} · Wiederherstellung: ${status.recoveryEmailHint}`
              : "Schützen Sie Kontakte, Kalender und Passwörter beim Öffnen der App mit Benutzername und Kennwort."}
          </p>
        </div>
        <button type="button" onClick={openProtection}>{status.protectionEnabled ? "Schutz ändern" : "Jetzt schützen"}</button>
        {status.protectionEnabled && <button className="danger-button" type="button" onClick={disableProtection}>Deaktivieren</button>}
      </section>

      <div className="toolbar passwords-toolbar">
        <label className="search-field">
          <Search size={21} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Plattform oder Benutzer suchen" />
        </label>
        <span>{visibleEntries.length} {visibleEntries.length === 1 ? "Eintrag" : "Einträge"}</span>
      </div>

      <section className="table-panel passwords-table-panel">
        <div className="table-wrap">
          <table className="passwords-table">
            <thead>
              <tr>
                <th>Plattform</th>
                <th>Benutzer</th>
                <th>Passwort</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => {
                const isRevealed = revealed.has(entry.id);
                return (
                  <tr className="password-row" key={entry.id} tabIndex={0} onClick={() => { setSelectedId(entry.id); setEntryForm(null); setDetailPasswordVisible(false); }} onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(entry.id);
                      setEntryForm(null);
                      setDetailPasswordVisible(false);
                    }
                  }}>
                    <td><strong>{entry.platform}</strong></td>
                    <td>{entry.username || <span className="muted-value">–</span>}</td>
                    <td>
                      <span className="password-table-value">
                        <code>{isRevealed ? entry.password : maskedPassword(entry.password)}</code>
                        <button className="icon-only compact" type="button" title={isRevealed ? "Passwort verbergen" : "Passwort anzeigen"} onClick={(event) => toggleRowPassword(event, entry.id)}>
                          {isRevealed ? <EyeOff size={19} /> : <Eye size={19} />}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {visibleEntries.length === 0 && (
                <tr><td className="passwords-empty" colSpan={3}><KeyRound size={34} /><strong>Noch keine Passwörter gespeichert</strong><span>Über „Passwort hinzufügen“ erstellen Sie den ersten Eintrag.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <div className="vault-drawer-backdrop" onMouseDown={closeSelectedEntry}>
          <aside className="vault-drawer" role="dialog" aria-modal="true" aria-labelledby="vault-detail-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>{entryForm?.id === selected.id ? "Zugangsdaten bearbeiten" : "Zugangsdaten"}</span>
                <h3 id="vault-detail-title">{entryForm?.id === selected.id ? "Passwort bearbeiten" : selected.platform}</h3>
              </div>
              <button className="icon-only" type="button" title="Schließen" onClick={closeSelectedEntry}><X size={22} /></button>
            </header>
            {entryForm?.id === selected.id ? (
              <form className="vault-drawer-edit-form" onSubmit={saveEntry}>
                <div className="form-grid vault-drawer-edit-fields">
                  <label className="field"><span>Plattform *</span><input autoFocus value={entryForm.platform} onChange={(event) => setEntryForm({ ...entryForm, platform: event.target.value })} required /></label>
                  <label className="field"><span>Benutzer</span><input value={entryForm.username} onChange={(event) => setEntryForm({ ...entryForm, username: event.target.value })} /></label>
                  <label className="field wide"><span>Passwort *</span><span className="password-input-wrap"><input autoComplete="new-password" type={entryPasswordVisible ? "text" : "password"} value={entryForm.password} onChange={(event) => setEntryForm({ ...entryForm, password: event.target.value })} required /><button className="icon-only" type="button" title={entryPasswordVisible ? "Passwort verbergen" : "Passwort anzeigen"} onClick={() => setEntryPasswordVisible((visible) => !visible)}>{entryPasswordVisible ? <EyeOff size={20} /> : <Eye size={20} />}</button></span></label>
                  <label className="field wide"><span>Link</span><input type="url" value={entryForm.url} onChange={(event) => setEntryForm({ ...entryForm, url: event.target.value })} placeholder="https://…" /></label>
                  <label className="field wide"><span>Beschreibung</span><textarea rows={5} value={entryForm.description} onChange={(event) => setEntryForm({ ...entryForm, description: event.target.value })} /></label>
                </div>
                <footer>
                  <button type="button" onClick={() => setEntryForm(null)}>Abbrechen</button>
                  <button className="primary" type="submit" disabled={busy}>Änderungen speichern</button>
                </footer>
              </form>
            ) : (
              <>
                <div className="vault-detail-list">
                  <DetailField label="Plattform" value={selected.platform} onCopy={() => copyValue(selected.platform, "Plattform")} />
                  <DetailField label="Benutzer" value={selected.username || "–"} onCopy={selected.username ? () => copyValue(selected.username, "Benutzername") : undefined} />
                  <div className="vault-detail-field">
                    <span>Passwort</span>
                    <div className="vault-secret-line">
                      <code>{detailPasswordVisible ? selected.password : maskedPassword(selected.password)}</code>
                      <button className="icon-only compact" type="button" title="Passwort anzeigen" onClick={() => setDetailPasswordVisible((visible) => !visible)}>{detailPasswordVisible ? <EyeOff size={19} /> : <Eye size={19} />}</button>
                      <button className="icon-only compact" type="button" title="Passwort kopieren" onClick={() => copyValue(selected.password, "Passwort")}><Copy size={19} /></button>
                    </div>
                  </div>
                  <div className="vault-detail-field">
                    <span>Link</span>
                    {selected.url ? (
                      <div className="vault-link-line"><span>{selected.url}</span><button className="icon-only compact" type="button" title="Link öffnen" onClick={() => openUrl(selected.url)}><ExternalLink size={19} /></button></div>
                    ) : <p>–</p>}
                  </div>
                  <div className="vault-detail-field description"><span>Beschreibung</span><p>{selected.description || "–"}</p></div>
                </div>
                <footer>
                  <button type="button" onClick={() => openEditEntry(selected)}><Edit3 size={20} /> Bearbeiten</button>
                  <button className="danger-button" type="button" onClick={() => removeEntry(selected)} disabled={busy}><Trash2 size={20} /> Löschen</button>
                </footer>
              </>
            )}
          </aside>
        </div>
      )}

      {entryForm && !entryForm.id && (
        <div className="modal-backdrop" role="presentation">
          <form className="form-panel modal-card vault-entry-dialog" onSubmit={saveEntry}>
            <div className="panel-heading">
              <h3>{entryForm.id ? "Passwort bearbeiten" : "Passwort hinzufügen"}</h3>
              <button className="icon-only" type="button" title="Schließen" onClick={() => setEntryForm(null)}><X size={22} /></button>
            </div>
            <div className="form-grid">
              <label className="field"><span>Plattform *</span><input autoFocus value={entryForm.platform} onChange={(event) => setEntryForm({ ...entryForm, platform: event.target.value })} placeholder="z. B. Microsoft 365" required /></label>
              <label className="field"><span>Benutzer</span><input value={entryForm.username} onChange={(event) => setEntryForm({ ...entryForm, username: event.target.value })} placeholder="Name oder E-Mail-Adresse" /></label>
              <label className="field wide"><span>Passwort *</span><span className="password-input-wrap"><input autoComplete="new-password" type={entryPasswordVisible ? "text" : "password"} value={entryForm.password} onChange={(event) => setEntryForm({ ...entryForm, password: event.target.value })} required /><button className="icon-only" type="button" title={entryPasswordVisible ? "Passwort verbergen" : "Passwort anzeigen"} onClick={() => setEntryPasswordVisible((visible) => !visible)}>{entryPasswordVisible ? <EyeOff size={20} /> : <Eye size={20} />}</button></span></label>
              <label className="field wide"><span>Link</span><input type="url" value={entryForm.url} onChange={(event) => setEntryForm({ ...entryForm, url: event.target.value })} placeholder="https://…" /></label>
              <label className="field wide"><span>Beschreibung</span><textarea rows={5} value={entryForm.description} onChange={(event) => setEntryForm({ ...entryForm, description: event.target.value })} placeholder="Zusätzliche Hinweise" /></label>
            </div>
            <div className="button-row vault-dialog-actions">
              <button type="button" onClick={() => setEntryForm(null)}>Abbrechen</button>
              <button className="primary" type="submit" disabled={busy}>{entryForm.id ? "Änderungen speichern" : "Verschlüsselt speichern"}</button>
            </div>
          </form>
        </div>
      )}

      {protectionOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="form-panel modal-card vault-protection-dialog" onSubmit={saveProtection}>
            <div className="panel-heading">
              <div><h3>App-Schutz einrichten</h3><p>Diese Anmeldung schützt die gesamte App auf diesem Windows-PC.</p></div>
              <button className="icon-only" type="button" title="Schließen" onClick={() => setProtectionOpen(false)}><X size={22} /></button>
            </div>
            <label className="field"><span>Benutzername *</span><input autoComplete="username" value={protectionUsername} onChange={(event) => setProtectionUsername(event.target.value)} minLength={3} required /></label>
            <label className="field"><span>E-Mail für Wiederherstellung *</span><input type="email" value={protectionEmail} onChange={(event) => setProtectionEmail(event.target.value)} required /></label>
            <label className="field"><span>{status.protectionEnabled ? "Neues App-Kennwort *" : "App-Kennwort *"}</span><input autoComplete="new-password" type="password" minLength={8} value={protectionPassword} onChange={(event) => setProtectionPassword(event.target.value)} required /></label>
            <label className="field"><span>Kennwort wiederholen *</span><input autoComplete="new-password" type="password" minLength={8} value={protectionPasswordAgain} onChange={(event) => setProtectionPasswordAgain(event.target.value)} required /></label>
            <p className="vault-security-note"><ShieldCheck size={20} /> Mindestens 8 Zeichen. Wiederherstellungscodes werden über Outlook Classic gesendet.</p>
            <div className="button-row vault-dialog-actions">
              <button type="button" onClick={() => setProtectionOpen(false)}>Abbrechen</button>
              <button className="primary" type="submit" disabled={busy}>App-Schutz speichern</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="vault-detail-field">
      <span>{label}</span>
      <div className="vault-copy-line"><p>{value}</p>{onCopy && <button className="icon-only compact" type="button" title={`${label} kopieren`} onClick={onCopy}><Copy size={19} /></button>}</div>
    </div>
  );
}

function maskedPassword(password: string) {
  return "•".repeat(Math.min(16, Math.max(8, password.length)));
}

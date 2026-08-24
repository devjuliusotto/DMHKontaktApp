import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Edit3, FileUp, KeyRound, Plus, QrCode, ScanLine, ShieldCheck, Smartphone, Trash2, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { deleteVaultEntry, listVaultEntries, saveVaultEntry } from "../services/db";
import type { VaultEntry, VaultEntryInput } from "../types/vault";
import { generateTotpCode, parseAuthenticatorImport, parseTotpInput, type TotpConfig } from "../utils/totp";

const emptyEntry: VaultEntryInput = {
  kind: "totp",
  platform: "",
  username: "",
  password: "",
  url: "",
  description: ""
};

interface LiveCode {
  value: string;
  remaining: number;
}

export function AuthenticatorPage() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [codes, setCodes] = useState<Record<number, LiveCode>>({});
  const [entryForm, setEntryForm] = useState<VaultEntryInput | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const refresh = async () => {
    const result = await listVaultEntries();
    setEntries(result.filter((entry) => entry.kind === "totp"));
  };

  useEffect(() => {
    refresh().catch((error) => showMessage(`2FA-Einträge konnten nicht geladen werden: ${error}`, "error"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const updateCodes = async () => {
      const timestamp = Date.now();
      const next = await Promise.all(entries.map(async (entry) => {
        try {
          const config = getConfig(entry);
          return [entry.id, { value: await generateTotpCode(config, timestamp), remaining: config.period - (Math.floor(timestamp / 1000) % config.period) }] as const;
        } catch {
          return [entry.id, { value: "------", remaining: 0 }] as const;
        }
      }));
      if (!cancelled) setCodes(Object.fromEntries(next));
    };
    void updateCodes();
    const timer = window.setInterval(() => void updateCodes(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [entries]);

  const openNewEntry = () => {
    setEntryForm({ ...emptyEntry });
    setMessage("");
  };

  const openEditEntry = (entry: VaultEntry) => {
    setEntryForm({
      id: entry.id,
      kind: "totp",
      totpAlgorithm: entry.totpAlgorithm,
      totpDigits: entry.totpDigits,
      totpPeriod: entry.totpPeriod,
      platform: entry.platform,
      username: entry.username,
      password: entry.password,
      url: entry.url,
      description: entry.description
    });
    setMessage("");
  };

  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!entryForm) return;
    setBusy(true);
    setMessage("");
    try {
      const parsed = parseTotpInput(entryForm.password);
      const normalizedEntry = {
        ...entryForm,
        kind: "totp" as const,
        totpAlgorithm: parsed.algorithm,
        totpDigits: parsed.digits,
        totpPeriod: parsed.period,
        platform: entryForm.platform.trim() || parsed.issuer || "2FA-Konto",
        username: entryForm.username.trim() || parsed.account || "",
        password: parsed.secret,
        description: entryForm.description.trim()
      };
      await saveVaultEntry(normalizedEntry);
      await refresh();
      setEntryForm(null);
      showMessage("Der 2FA-Schlüssel wurde verschlüsselt gespeichert.", "success");
    } catch (error) {
      showMessage(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const importEntries = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const imported = parseAuthenticatorImport(importText);
      const existingKeys = new Set(entries.map((entry) => `${entry.platform}|${entry.username}|${entry.password}`));
      let skipped = 0;
      for (const parsed of imported) {
        const platform = parsed.issuer || "Importierter 2FA-Dienst";
        const username = parsed.account || "";
        const key = `${platform}|${username}|${parsed.secret}`;
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        await saveVaultEntry({
          ...emptyEntry,
          platform,
          username,
          password: parsed.secret,
          totpAlgorithm: parsed.algorithm,
          totpDigits: parsed.digits,
          totpPeriod: parsed.period
        });
        existingKeys.add(key);
      }
      await refresh();
      setImportOpen(false);
      setImportText("");
      showMessage(`${imported.length - skipped} 2FA-Konten importiert${skipped ? `, ${skipped} bereits vorhanden` : ""}.`, "success");
    } catch (error) {
      showMessage(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const loadImportFile = async (file?: File) => {
    if (!file) return;
    if (file.type.startsWith("image/")) {
      const detectorConstructor = (window as Window & { BarcodeDetector?: new (options?: { formats: string[] }) => { detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
      if (!detectorConstructor) {
        showMessage("Dieser PC unterstützt keine QR-Bilderkennung. Fügen Sie die otpauth-migration://-Adresse als Text ein oder verwenden Sie später die mobile App.", "error");
        return;
      }
      const image = await createImageBitmap(file);
      try {
        const [result] = await new detectorConstructor({ formats: ["qr_code"] }).detect(image);
        if (!result?.rawValue) throw new Error("Im Bild wurde kein QR-Code gefunden.");
        setImportText(result.rawValue);
      } finally {
        image.close();
      }
      return;
    }
    setImportText(await file.text());
  };

  const removeEntry = async (entry: VaultEntry) => {
    if (!window.confirm(`„${entry.platform}“ wirklich löschen?`)) return;
    setBusy(true);
    try {
      await deleteVaultEntry(entry.id);
      await refresh();
      showMessage("Der 2FA-Eintrag wurde in den Papierkorb verschoben.", "success");
    } catch (error) {
      showMessage(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (code: string) => {
    await writeText(code);
    showMessage("Der aktuelle 2FA-Code wurde kopiert. Die Zwischenablage wird nach 30 Sekunden geleert.", "success");
    window.setTimeout(async () => {
      try {
        if (await readText() === code) await writeText("");
      } catch {
        // Die Zwischenablage wurde bereits geändert oder ist nicht verfügbar.
      }
    }, 30_000);
  };

  const countLabel = entries.length === 1 ? "1 Konto" : `${entries.length} Konten`;

  function showMessage(value: string, type: "success" | "error" | "info") {
    setMessageType(type);
    setMessage(value);
  }

  return (
    <div className="page authenticator-page">
      <header className="page-header">
        <div>
          <h2>2FA-Authenticator</h2>
          <p>Einmalcodes lokal und verschlüsselt speichern und erzeugen.</p>
        </div>
        <div className="authenticator-header-actions">
          <button type="button" onClick={() => setImportOpen(true)}><FileUp size={21} /> Importieren</button>
          <button className="primary" type="button" onClick={openNewEntry}><Plus size={22} /> 2FA-Code hinzufügen</button>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="authenticator-intro-card">
        <span className="authenticator-intro-icon"><ShieldCheck size={28} /></span>
        <div>
          <strong>Ihre Authentifizierungs-App im DMH-Kontakte-Programm</strong>
          <p>Fügen Sie den geheimen Schlüssel aus der 2FA-Einrichtung ein. Der aktuelle 6-stellige Code wird alle 30 Sekunden automatisch erneuert.</p>
        </div>
        <span className="authenticator-count">{countLabel}</span>
      </section>

      <section className="authenticator-scan-card">
        <QrCode size={24} />
        <div><strong>QR-Code mit dem Smartphone lesen</strong><p>Die Kamera-Funktion wird mit der zukünftigen mobilen App verfügbar und synchron mit dieser PC-Funktion sein.</p></div>
        <button type="button" disabled title="Wird in der mobilen App verfügbar sein"><Smartphone size={19} /> In mobiler App</button>
      </section>

      {entries.length === 0 ? (
        <section className="table-panel authenticator-empty">
          <ScanLine size={42} />
          <strong>Noch keine 2FA-Konten gespeichert</strong>
          <span>Über „2FA-Code hinzufügen“ können Sie einen Base32-Schlüssel oder eine otpauth://-Adresse einfügen.</span>
        </section>
      ) : (
        <section className="authenticator-grid" aria-label="Gespeicherte 2FA-Konten">
          {entries.map((entry) => {
            const liveCode = codes[entry.id];
            return (
              <article className="authenticator-card" key={entry.id}>
                <header>
                  <span className="authenticator-card-icon"><KeyRound size={20} /></span>
                  <div><strong>{entry.platform}</strong><small>{entry.username || "Kein Konto angegeben"}</small></div>
                  <span className="authenticator-remaining">{liveCode?.remaining ?? 30}s</span>
                </header>
                <div className="authenticator-code-line">
                  <code>{liveCode?.value ?? "------"}</code>
                  <button className="icon-only" type="button" title="Code kopieren" onClick={() => liveCode && copyCode(liveCode.value)} disabled={!liveCode || liveCode.value === "------"}><Copy size={20} /></button>
                </div>
                <footer>
                  <button type="button" onClick={() => openEditEntry(entry)}><Edit3 size={18} /> Bearbeiten</button>
                  <button className="danger-button" type="button" onClick={() => removeEntry(entry)} disabled={busy}><Trash2 size={18} /> Löschen</button>
                </footer>
              </article>
            );
          })}
        </section>
      )}

      {entryForm && (
        <div className="modal-backdrop" role="presentation">
          <form className="form-panel modal-card authenticator-dialog" onSubmit={saveEntry} role="dialog" aria-modal="true" aria-labelledby="authenticator-dialog-title">
            <div className="panel-heading">
              <div><h3 id="authenticator-dialog-title">{entryForm.id ? "2FA-Konto bearbeiten" : "2FA-Konto hinzufügen"}</h3><p>Nur der geheime Schlüssel wird zum Erzeugen der Einmalcodes benötigt.</p></div>
              <button className="icon-only" type="button" title="Schließen" onClick={() => setEntryForm(null)}><X size={22} /></button>
            </div>
            <label className="field"><span>Dienst / Anbieter</span><input autoFocus value={entryForm.platform} onChange={(event) => setEntryForm({ ...entryForm, platform: event.target.value })} placeholder="z. B. Microsoft 365" /></label>
            <label className="field"><span>Konto / E-Mail</span><input value={entryForm.username} onChange={(event) => setEntryForm({ ...entryForm, username: event.target.value })} placeholder="name@beispiel.de" /></label>
            <label className="field"><span>Geheimer Schlüssel oder QR-Code-Text *</span><input autoComplete="off" value={entryForm.password} onChange={(event) => setEntryForm({ ...entryForm, password: event.target.value })} placeholder="Base32-Schlüssel oder otpauth://…" required /></label>
            <p className="authenticator-help"><QrCode size={19} /> QR-Code-Scannen per Smartphone wird in der mobilen App ergänzt. Auf dem PC können Sie den Schlüssel aus der Einrichtung kopieren.</p>
            <label className="field"><span>Notiz</span><textarea rows={3} value={entryForm.description} onChange={(event) => setEntryForm({ ...entryForm, description: event.target.value })} placeholder="Optional" /></label>
            <div className="button-row vault-dialog-actions">
              <button type="button" onClick={() => setEntryForm(null)}>Abbrechen</button>
              <button className="primary" type="submit" disabled={busy}>{entryForm.id ? "Änderungen speichern" : "Verschlüsselt speichern"}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="form-panel modal-card authenticator-dialog" onSubmit={importEntries} role="dialog" aria-modal="true" aria-labelledby="authenticator-import-title">
            <div className="panel-heading">
              <div><h3 id="authenticator-import-title">2FA-Konten importieren</h3><p>Importieren Sie eine oder mehrere Exportadressen aus einer anderen Authenticator-App.</p></div>
              <button className="icon-only" type="button" title="Schließen" onClick={() => setImportOpen(false)}><X size={22} /></button>
            </div>
            <label className="field"><span>Exportdaten *</span><textarea autoFocus rows={8} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="otpauth://totp/... oder otpauth-migration://offline?..." required /></label>
            <label className="authenticator-file-input"><FileUp size={18} /><span>Exportdatei oder QR-Bild auswählen</span><input type="file" accept=".txt,.json,.csv,.uri,text/plain,application/json,image/*" onChange={(event) => void loadImportFile(event.target.files?.[0])} /></label>
            <p className="authenticator-help"><QrCode size={19} /> Google Authenticator: „Konten übertragen → Konten exportieren“ und den Migrationstext einfügen oder das QR-Bild auswählen. Das Microsoft-Authenticator-Backup kann nur im Microsoft Authenticator wiederhergestellt werden; eine direkte Synchronisierung mit dieser App ist nicht verfügbar.</p>
            <div className="button-row vault-dialog-actions">
              <button type="button" onClick={() => setImportOpen(false)}>Abbrechen</button>
              <button className="primary" type="submit" disabled={busy}>Importieren</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function getConfig(entry: VaultEntry): TotpConfig {
  const parsed = parseTotpInput(entry.password);
  return {
    ...parsed,
    algorithm: entry.totpAlgorithm ?? parsed.algorithm,
    digits: entry.totpDigits ?? parsed.digits,
    period: entry.totpPeriod ?? parsed.period
  };
}

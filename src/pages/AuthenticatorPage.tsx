import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Edit3, FileUp, KeyRound, Plus, QrCode, Search, Smartphone, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DragEvent, FormEvent, KeyboardEvent } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusMessage } from "../components/StatusMessage";
import { deleteVaultEntry, getAppSetting, listVaultEntries, saveVaultEntry, setAppSetting } from "../services/db";
import type { VaultEntry, VaultEntryInput } from "../types/vault";
import { deletionConfirmationSettingKey } from "../utils/settings";
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

const authenticatorCollator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
const authenticatorOrderSettingKey = "authenticator-entry-order-v1";

type DropPosition = "before" | "after";

function parseAuthenticatorOrder(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

function applyAuthenticatorOrder(entries: VaultEntry[], savedOrder: number[]): VaultEntry[] {
  const orderById = new Map(savedOrder.map((id, index) => [id, index]));
  return entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort((left, right) => {
      const leftPosition = orderById.get(left.entry.id);
      const rightPosition = orderById.get(right.entry.id);
      if (leftPosition !== undefined || rightPosition !== undefined) {
        if (leftPosition === undefined) return 1;
        if (rightPosition === undefined) return -1;
        return leftPosition - rightPosition;
      }
      return authenticatorCollator.compare(left.entry.platform, right.entry.platform)
        || authenticatorCollator.compare(left.entry.username, right.entry.username)
        || left.originalIndex - right.originalIndex;
    })
    .map(({ entry }) => entry);
}

function reorderAuthenticatorEntries(
  entries: VaultEntry[],
  sourceId: number,
  targetId: number,
  position: DropPosition
): VaultEntry[] {
  if (sourceId === targetId) return entries;
  const source = entries.find((entry) => entry.id === sourceId);
  if (!source || !entries.some((entry) => entry.id === targetId)) return entries;

  const reordered = entries.filter((entry) => entry.id !== sourceId);
  const targetIndex = reordered.findIndex((entry) => entry.id === targetId);
  reordered.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
  return reordered.every((entry, index) => entry.id === entries[index]?.id) ? entries : reordered;
}

export function AuthenticatorPage() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [codes, setCodes] = useState<Record<number, LiveCode>>({});
  const [entryForm, setEntryForm] = useState<VaultEntryInput | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [confirmDeletions, setConfirmDeletions] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<VaultEntry | null>(null);
  const [draggedEntryId, setDraggedEntryId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: number; position: DropPosition } | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderAnnouncement, setOrderAnnouncement] = useState("");

  const refresh = async () => {
    const [result, savedOrder] = await Promise.all([
      listVaultEntries(),
      getAppSetting(authenticatorOrderSettingKey).catch(() => null)
    ]);
    const authenticatorEntries = result.filter((entry) => entry.kind === "totp");
    setEntries(applyAuthenticatorOrder(authenticatorEntries, parseAuthenticatorOrder(savedOrder)));
  };

  useEffect(() => {
    refresh().catch((error) => showMessage(`2FA-Einträge konnten nicht geladen werden: ${error}`, "error"));
    getAppSetting(deletionConfirmationSettingKey)
      .then((value) => setConfirmDeletions(value !== "false"))
      .catch(() => setConfirmDeletions(true));
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

  const removeEntryNow = async (entry: VaultEntry) => {
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

  const removeEntry = (entry: VaultEntry) => {
    if (confirmDeletions) {
      setPendingDelete(entry);
      return;
    }
    void removeEntryNow(entry);
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

  const saveReorderedEntries = async (
    sourceId: number,
    targetId: number,
    position: DropPosition
  ) => {
    const reordered = reorderAuthenticatorEntries(entries, sourceId, targetId, position);
    if (reordered === entries) return;

    setEntries(reordered);
    setSavingOrder(true);
    try {
      await setAppSetting(authenticatorOrderSettingKey, JSON.stringify(reordered.map((entry) => entry.id)));
      const movedEntry = reordered.find((entry) => entry.id === sourceId);
      const newPosition = reordered.findIndex((entry) => entry.id === sourceId) + 1;
      setOrderAnnouncement(`${movedEntry?.platform ?? "2FA-Konto"} wurde an Position ${newPosition} verschoben.`);
    } catch (error) {
      await refresh().catch(() => undefined);
      showMessage(`Die Reihenfolge konnte nicht gespeichert werden: ${error}`, "error");
    } finally {
      setSavingOrder(false);
    }
  };

  const startRowDrag = (event: DragEvent<HTMLTableRowElement>, entryId: number) => {
    const target = event.target as HTMLElement;
    if (savingOrder || target.closest("button, input, textarea, select, a")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(entryId));
    setDraggedEntryId(entryId);
    setDropTarget(null);
  };

  const updateDropTarget = (event: DragEvent<HTMLTableRowElement>, entryId: number) => {
    if (draggedEntryId === null || draggedEntryId === entryId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: DropPosition = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropTarget((current) => current?.id === entryId && current.position === position
      ? current
      : { id: entryId, position });
  };

  const finishRowDrag = () => {
    setDraggedEntryId(null);
    setDropTarget(null);
  };

  const dropRow = (event: DragEvent<HTMLTableRowElement>, targetId: number) => {
    event.preventDefault();
    const sourceId = draggedEntryId ?? Number(event.dataTransfer.getData("text/plain"));
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: DropPosition = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    finishRowDrag();
    if (Number.isInteger(sourceId)) void saveReorderedEntries(sourceId, targetId, position);
  };

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de");
    return entries
      .filter((entry) => !query || [entry.platform, entry.username, entry.description]
        .some((value) => value.toLocaleLowerCase("de").includes(query)));
  }, [entries, search]);

  const moveRowWithKeyboard = (event: KeyboardEvent<HTMLTableRowElement>, entryId: number) => {
    if (!event.ctrlKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || savingOrder) return;
    const currentIndex = visibleEntries.findIndex((entry) => entry.id === entryId);
    const targetIndex = event.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
    const target = visibleEntries[targetIndex];
    if (!target) return;
    event.preventDefault();
    void saveReorderedEntries(entryId, target.id, event.key === "ArrowUp" ? "before" : "after");
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

      <section className="authenticator-mobile-scan-card" aria-label="QR-Code mit dem Smartphone lesen">
        <QrCode size={24} aria-hidden="true" />
        <div>
          <strong>QR-Code mit dem Smartphone lesen</strong>
          <p>Die Kamera-Funktion wird mit der zukünftigen mobilen App verfügbar und synchron mit dieser PC-Funktion sein.</p>
        </div>
        <button type="button" disabled title="Wird in der mobilen App verfügbar sein">
          <Smartphone size={19} /> In mobiler App
        </button>
      </section>

      <section className="table-panel authenticator-list-panel" aria-label="Gespeicherte 2FA-Konten">
        <p className="sr-only" id="authenticator-reorder-help">
          Zeilen mit der Maus nach oben oder unten ziehen. Mit Strg und Pfeil nach oben oder unten kann die markierte Zeile ebenfalls verschoben werden.
        </p>
        <p className="sr-only" aria-live="polite">{orderAnnouncement}</p>
        <div className="authenticator-list-toolbar">
          <label className="search-field authenticator-search">
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Dienst, Konto oder Notiz suchen"
              aria-label="2FA-Konten durchsuchen"
            />
          </label>
          <span className="authenticator-count">
            {search.trim() ? `${visibleEntries.length} von ${entries.length}` : countLabel}
          </span>
        </div>

        <div className="table-wrap">
          <table className="authenticator-table">
            <colgroup>
              <col className="authenticator-service-column" />
              <col className="authenticator-account-column" />
              <col className="authenticator-code-column" />
              <col className="authenticator-validity-column" />
              <col className="authenticator-actions-column" />
            </colgroup>
            <thead>
              <tr>
                <th>Dienst / Anbieter</th>
                <th>Konto / E-Mail</th>
                <th>Aktueller 2FA-Code</th>
                <th>Gültig</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry, visibleIndex) => {
                const liveCode = codes[entry.id];
                const code = liveCode?.value ?? "------";
                const rowClassName = [
                  draggedEntryId === entry.id ? "authenticator-row-dragging" : "",
                  dropTarget?.id === entry.id ? `authenticator-drop-${dropTarget.position}` : ""
                ].filter(Boolean).join(" ");
                return (
                  <tr
                    key={entry.id}
                    className={rowClassName}
                    data-authenticator-entry-id={entry.id}
                    draggable={!savingOrder}
                    tabIndex={0}
                    aria-describedby="authenticator-reorder-help"
                    aria-rowindex={visibleIndex + 2}
                    title="Zeile ziehen, um ihre Position zu ändern"
                    onDoubleClick={() => openEditEntry(entry)}
                    onDragStart={(event) => startRowDrag(event, entry.id)}
                    onDragOver={(event) => updateDropTarget(event, entry.id)}
                    onDrop={(event) => dropRow(event, entry.id)}
                    onDragEnd={finishRowDrag}
                    onKeyDown={(event) => moveRowWithKeyboard(event, entry.id)}
                  >
                    <td>
                      <div className="authenticator-service">
                        <span className="authenticator-service-icon"><KeyRound size={18} aria-hidden="true" /></span>
                        <span>
                          <strong>{entry.platform}</strong>
                          {entry.description && <small>{entry.description}</small>}
                        </span>
                      </div>
                    </td>
                    <td className="authenticator-account" title={entry.username}>{entry.username || "–"}</td>
                    <td>
                      <div className="authenticator-code-cell">
                        <code aria-label={`Aktueller Code ${code.split("").join(" ")}`}>{code}</code>
                        <button
                          className="icon-only"
                          type="button"
                          title={`Code für ${entry.platform} kopieren`}
                          aria-label={`Code für ${entry.platform} kopieren`}
                          onClick={() => liveCode && copyCode(liveCode.value)}
                          disabled={!liveCode || liveCode.value === "------"}
                        >
                          <Copy size={17} />
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className="authenticator-remaining" aria-label={`${liveCode?.remaining ?? 30} Sekunden verbleibend`}>
                        {liveCode?.remaining ?? 30}s
                      </span>
                    </td>
                    <td>
                      <div className="authenticator-row-actions">
                        <button type="button" onClick={() => openEditEntry(entry)} title={`${entry.platform} bearbeiten`}>
                          <Edit3 size={16} /> Bearbeiten
                        </button>
                        <button className="danger-button" type="button" onClick={() => removeEntry(entry)} disabled={busy} title={`${entry.platform} löschen`}>
                          <Trash2 size={16} /> Löschen
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visibleEntries.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    {entries.length === 0
                      ? "Noch keine 2FA-Konten gespeichert. Fügen Sie oben den ersten 2FA-Code hinzu."
                      : "Keine passenden 2FA-Konten gefunden."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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

      <ConfirmDialog
        open={pendingDelete !== null}
        title="2FA-Eintrag löschen"
        message={pendingDelete ? `Möchten Sie „${pendingDelete.platform}“ wirklich in den Papierkorb verschieben?` : "Möchten Sie diesen 2FA-Eintrag wirklich löschen?"}
        confirmLabel="In Papierkorb verschieben"
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          void removeEntryNow(pendingDelete).then(() => setPendingDelete(null));
        }}
      />
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

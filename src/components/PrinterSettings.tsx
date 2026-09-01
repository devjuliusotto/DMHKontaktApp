import { Building2, CheckCircle2, LoaderCircle, MapPin, Network, Printer, RefreshCw, Router, Share2, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { addNetworkPrinter, installDmhKopierraumPrinter, listPrinterDrivers, listPrinters } from "../services/db";
import type { PrinterDriver, PrinterInfo } from "../types/printer";
import { StatusMessage } from "./StatusMessage";

type PrinterMode = "shared" | "ip";
type PrinterArea = "aidlingen" | "villingen" | "advanced";

function printerStatusLabel(status: string) {
  const normalized = status.trim().toLocaleLowerCase("de-DE");
  if (!normalized || normalized === "normal") return "Bereit";
  if (normalized.includes("offline")) return "Offline";
  if (normalized.includes("error")) return "Fehler";
  return status;
}

export function PrinterSettings() {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [drivers, setDrivers] = useState<PrinterDriver[]>([]);
  const [mode, setMode] = useState<PrinterMode>("shared");
  const [area, setArea] = useState<PrinterArea>("aidlingen");
  const [connectionName, setConnectionName] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [printerName, setPrinterName] = useState("");
  const [driverName, setDriverName] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [installingKopierraum, setInstallingKopierraum] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const refresh = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [installedPrinters, installedDrivers] = await Promise.all([
        listPrinters(),
        listPrinterDrivers()
      ]);
      setPrinters(installedPrinters);
      setDrivers(installedDrivers);
      setDriverName((current) => current || installedDrivers[0]?.name || "");
    } catch (error) {
      setMessageType("error");
      setMessage(`Drucker konnten nicht geladen werden: ${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kopierraumInstalled = printers.some((printer) => printer.name === "Kopierraum SH2 UG");

  const installKopierraum = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessageType("info");
      setMessage("Drucker können nur in der installierten Windows-App hinzugefügt werden.");
      return;
    }
    setInstallingKopierraum(true);
    setMessage("");
    try {
      const result = await installDmhKopierraumPrinter();
      await refresh();
      setMessageType("success");
      setMessage(result === "alreadyInstalled" ? "Der Drucker ist bereits installiert." : "Kopierraum SH2 UG wurde hinzugefügt.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Drucker konnte nicht hinzugefügt werden: ${error}`);
    } finally {
      setInstallingKopierraum(false);
    }
  };

  const addPrinter = async (event: FormEvent) => {
    event.preventDefault();
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessageType("info");
      setMessage("Drucker können nur in der installierten Windows-App hinzugefügt werden.");
      return;
    }
    setAdding(true);
    setMessage("");
    try {
      await addNetworkPrinter({
        mode,
        connectionName: connectionName.trim(),
        ipAddress: ipAddress.trim(),
        printerName: printerName.trim(),
        driverName
      });
      await refresh();
      setMessageType("success");
      setMessage("Drucker wurde hinzugefügt.");
      if (mode === "shared") setConnectionName("");
      else {
        setIpAddress("");
        setPrinterName("");
      }
    } catch (error) {
      setMessageType("error");
      setMessage(`Drucker konnte nicht hinzugefügt werden: ${error}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="settings-detail-view printer-settings">
      <StatusMessage message={message} type={messageType} />

      <nav className="printer-area-tabs" role="tablist" aria-label="Druckerstandort">
        <button className={area === "aidlingen" ? "active" : ""} type="button" role="tab" aria-selected={area === "aidlingen"} onClick={() => setArea("aidlingen")}>
          <MapPin size={22} /> Aidlingen
        </button>
        <button className={area === "villingen" ? "active" : ""} type="button" role="tab" aria-selected={area === "villingen"} onClick={() => setArea("villingen")}>
          <Building2 size={22} /> Villingen
        </button>
        <button className={area === "advanced" ? "active" : ""} type="button" role="tab" aria-selected={area === "advanced"} onClick={() => setArea("advanced")}>
          <SlidersHorizontal size={22} /> Erweiterte Funktionen
        </button>
      </nav>

      {area === "aidlingen" && (
        <section className="form-panel printer-preset-panel" role="tabpanel">
          <div className="printer-preset-copy">
            <span className="printer-preset-icon"><Printer size={28} aria-hidden="true" /></span>
            <div>
              <span className="printer-preset-label">Aidlingen</span>
              <h3>Kopierraum SH2 UG</h3>
              <p>172.16.40.53 · Treiber enthalten</p>
            </div>
          </div>
          <div className="printer-preset-action">
            <button
              className="primary large"
              type="button"
              onClick={() => void installKopierraum()}
              disabled={loading || adding || installingKopierraum || kopierraumInstalled}
            >
              {installingKopierraum ? <LoaderCircle className="spin" size={21} /> : <ShieldCheck size={21} />}
              {installingKopierraum ? "Wird hinzugefügt …" : kopierraumInstalled ? "Bereits installiert" : "Jetzt hinzufügen"}
            </button>
            {!kopierraumInstalled && <small>Windows fragt einmal nach Administratorrechten.</small>}
          </div>
        </section>
      )}

      {area === "villingen" && (
        <section className="form-panel printer-location-empty" role="tabpanel">
          <Building2 size={28} aria-hidden="true" />
          <h3>Villingen</h3>
          <p>Keine Drucker hinterlegt.</p>
        </section>
      )}

      {area === "advanced" && <div className="printer-advanced-content" role="tabpanel"><section className="form-panel printer-installed-panel">
        <div className="printer-panel-heading">
          <div className="settings-task-heading">
            <Printer size={25} aria-hidden="true" />
            <div><h3>Installierte Drucker</h3><p>{printers.length} auf diesem PC</p></div>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading || adding || installingKopierraum}>
            {loading ? <LoaderCircle className="spin" size={19} /> : <RefreshCw size={19} />} Aktualisieren
          </button>
        </div>

        <div className="printer-list">
          {printers.map((printer) => (
            <article className="printer-list-item" key={`${printer.name}-${printer.portName}`}>
              <span className="printer-list-icon"><Printer size={23} aria-hidden="true" /></span>
              <div>
                <strong>{printer.name}</strong>
                <span>{printer.portName}{printer.driverName ? ` · ${printer.driverName}` : ""}</span>
              </div>
              <div className="printer-list-badges">
                {printer.isDefault && <em>Standard</em>}
                <span className={printerStatusLabel(printer.printerStatus) === "Bereit" ? "ready" : ""}>{printerStatusLabel(printer.printerStatus)}</span>
              </div>
            </article>
          ))}
          {!loading && printers.length === 0 && <p className="printer-empty">Keine Drucker installiert.</p>}
        </div>
      </section>

      <section className="form-panel printer-add-panel">
        <div className="settings-task-heading">
          <Network size={25} aria-hidden="true" />
          <div><h3>Netzwerkdrucker hinzufügen</h3></div>
        </div>

        <div className="printer-mode-switch" role="group" aria-label="Verbindungsart">
          <button className={mode === "shared" ? "active" : ""} type="button" onClick={() => setMode("shared")} disabled={adding || installingKopierraum}>
            <Share2 size={20} /> Freigabe
          </button>
          <button className={mode === "ip" ? "active" : ""} type="button" onClick={() => setMode("ip")} disabled={adding || installingKopierraum}>
            <Router size={20} /> IP-Adresse
          </button>
        </div>

        <form className="printer-add-form" onSubmit={(event) => void addPrinter(event)}>
          {mode === "shared" ? (
            <label className="field wide">
              <span>Freigabepfad</span>
              <input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="\\server\drucker" required />
            </label>
          ) : (
            <div className="printer-ip-grid">
              <label className="field">
                <span>IP-Adresse oder Hostname</span>
                <input value={ipAddress} onChange={(event) => setIpAddress(event.target.value)} placeholder="192.168.1.50" required />
              </label>
              <label className="field">
                <span>Name in Windows</span>
                <input value={printerName} onChange={(event) => setPrinterName(event.target.value)} placeholder="Drucker Büro" required />
              </label>
              <label className="field wide">
                <span>Druckertreiber</span>
                <select value={driverName} onChange={(event) => setDriverName(event.target.value)} required>
                  <option value="" disabled>Treiber auswählen</option>
                  {drivers.map((driver) => <option key={driver.name} value={driver.name}>{driver.name}{driver.manufacturer ? ` · ${driver.manufacturer}` : ""}</option>)}
                </select>
              </label>
            </div>
          )}

          <button className="primary large printer-add-button" type="submit" disabled={adding || installingKopierraum || loading || (mode === "ip" && drivers.length === 0)}>
            {adding ? <LoaderCircle className="spin" size={21} /> : <CheckCircle2 size={21} />}
            {adding ? "Drucker wird hinzugefügt …" : "Drucker hinzufügen"}
          </button>
        </form>
      </section></div>}
    </div>
  );
}

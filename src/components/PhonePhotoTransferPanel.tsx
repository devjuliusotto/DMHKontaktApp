import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Clock3, Copy, FolderOpen, LoaderCircle, QrCode, RefreshCw, Smartphone, Square, Wifi } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { getPhonePhotoTransferStatus, startPhonePhotoTransfer, stopPhonePhotoTransfer } from "../services/db";
import type { PhonePhotoReceived, PhoneTransferStatus } from "../types/phoneTransfer";

const isDesktopApp = "__TAURI_INTERNALS__" in window;

export function PhonePhotoTransferPanel() {
  const [status, setStatus] = useState<PhoneTransferStatus | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [message, setMessage] = useState("");
  const [receivedNames, setReceivedNames] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!isDesktopApp) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.all([
      getPhonePhotoTransferStatus(),
      listen<PhonePhotoReceived>("phone-photo-received", (event) => {
        if (disposed) return;
        setReceivedNames((current) => [event.payload.name, ...current].slice(0, 8));
        setStatus((current) => current ? { ...current, receivedFiles: event.payload.receivedFiles } : current);
      })
    ]).then(([currentStatus, dispose]) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      if (currentStatus?.active) setStatus(currentStatus);
    }).catch((error) => {
      if (!disposed) setMessage(`Übertragungsstatus konnte nicht geladen werden: ${error}`);
    });
    return () => {
      disposed = true;
      unlisten?.();
      void stopPhonePhotoTransfer();
    };
  }, []);

  useEffect(() => {
    if (!status?.active) {
      setQrCode("");
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(status.url, {
      color: { dark: "#202124", light: "#ffffff" },
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280
    }).then((value) => {
      if (!cancelled) setQrCode(value);
    }).catch(() => {
      if (!cancelled) setMessage("Der QR-Code konnte nicht erstellt werden.");
    });
    return () => { cancelled = true; };
  }, [status?.active, status?.url]);

  useEffect(() => {
    if (!status?.active || !isDesktopApp) return;
    const interval = window.setInterval(() => {
      void getPhonePhotoTransferStatus().then((next) => {
        setStatus(next?.active ? next : null);
        if (next && !next.active) setMessage("Die Übertragungssitzung ist abgelaufen. Starten Sie bei Bedarf eine neue Sitzung.");
      }).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [status?.active]);

  const start = async (replaceCurrentSession = false) => {
    if (!isDesktopApp) {
      setMessage("Die Handy-Übertragung kann nur in der installierten Desktop-App gestartet werden.");
      return;
    }
    setStarting(true);
    setMessage("");
    setReceivedNames([]);
    try {
      if (replaceCurrentSession) {
        await stopPhonePhotoTransfer();
      }
      setStatus(await startPhonePhotoTransfer());
    } catch (error) {
      setMessage(`Übertragung konnte nicht gestartet werden: ${error}`);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    await stopPhonePhotoTransfer().catch(() => undefined);
    setStatus(null);
    setQrCode("");
    setMessage("Die Übertragung wurde beendet.");
  };

  const copyLink = async () => {
    if (!status) return;
    try {
      await writeText(status.url);
      setMessage("Der Link wurde kopiert.");
    } catch (error) {
      setMessage(`Der Link konnte nicht kopiert werden: ${error}`);
    }
  };

  if (!status?.active) {
    return (
      <section className="dienstleistung-panel phone-transfer-start">
        <span className="phone-transfer-start-icon"><Smartphone size={34} aria-hidden="true" /></span>
        <div>
          <h3>Fotos ohne Kabel übertragen</h3>
          <p>Ein QR-Code verbindet das Handy direkt mit diesem PC. Es ist keine Anmeldung und keine Cloud erforderlich.</p>
        </div>
        <ol className="phone-transfer-steps">
          <li><span>1</span><div><strong>Sitzung starten</strong><small>Der QR-Code ist 15 Minuten gültig.</small></div></li>
          <li><span>2</span><div><strong>QR-Code scannen</strong><small>Handy und PC müssen im selben WLAN sein.</small></div></li>
          <li><span>3</span><div><strong>Fotos auswählen</strong><small>Die Bilder landen automatisch im Bilder-Ordner.</small></div></li>
        </ol>
        {message ? <p className="phone-transfer-message" role="status">{message}</p> : null}
        <button className="primary large" type="button" disabled={starting} onClick={() => void start()}>
          {starting ? <LoaderCircle className="spin" size={21} /> : <QrCode size={21} />}
          {starting ? "Wird vorbereitet …" : "Übertragung starten"}
        </button>
      </section>
    );
  }

  return (
    <section className="dienstleistung-panel phone-transfer-session">
      <div className="phone-transfer-qr-card">
        <div className="phone-transfer-qr">
          {qrCode ? <img src={qrCode} alt="QR-Code zum Öffnen der Fotoübertragung auf dem Handy" /> : <LoaderCircle className="spin" size={30} />}
        </div>
        <strong>Mit der Handykamera scannen</strong>
        <p><Wifi size={17} /> Gleiches WLAN verwenden</p>
      </div>

      <div className="phone-transfer-details">
        <header>
          <div><span className="phone-transfer-live" aria-hidden="true" /><div><h3>Bereit für Fotos</h3><p>Die Verbindung ist nur vorübergehend geöffnet.</p></div></div>
          <span className="phone-transfer-count"><CheckCircle2 size={17} /> {status.receivedFiles} empfangen</span>
        </header>
        <div className="phone-transfer-info">
          <span><Clock3 size={18} /><span><small>Gültig bis</small><strong>{formatTime(status.expiresAt)} Uhr</strong></span></span>
          <span><FolderOpen size={18} /><span><small>Speicherort</small><strong>DMH Handy-Übertragung</strong></span></span>
        </div>
        {receivedNames.length ? (
          <div className="phone-transfer-received" aria-live="polite">
            <strong>Zuletzt empfangen</strong>
            {receivedNames.map((name) => <span key={name}><CheckCircle2 size={16} /> {name}</span>)}
          </div>
        ) : <p className="phone-transfer-waiting"><Smartphone size={19} /> Warten auf die Auswahl am Handy …</p>}
        {message ? <p className="phone-transfer-message" role="status">{message}</p> : null}
        <div className="button-row phone-transfer-actions">
          <button type="button" onClick={() => void openPath(status.destination)}><FolderOpen size={18} /> Zielordner öffnen</button>
          <button type="button" onClick={() => void copyLink()}><Copy size={18} /> Link kopieren</button>
          <button type="button" disabled={starting} onClick={() => void start(true)}><RefreshCw size={18} /> Neuer QR-Code</button>
          <button className="danger-button" type="button" onClick={() => void stop()}><Square size={17} /> Beenden</button>
        </div>
        <small className="phone-transfer-security">Der zufällige Zugangscode läuft automatisch ab. Nur Geräte mit diesem QR-Code können Fotos senden.</small>
      </div>
    </section>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

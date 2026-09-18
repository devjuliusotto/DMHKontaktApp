import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { recordActivity } from "../utils/activityLog";

interface StatusMessageProps {
  message: string;
  type?: "success" | "error" | "info";
  /** Set to null for a message that must stay until the next action. */
  autoDismissMs?: number | null;
  recordInActivity?: boolean;
}

function inferTone(message: string): "success" | "error" | "info" {
  if (/fehlgeschlagen|fehler|konnte nicht|nicht möglich|nicht erreichbar|quotaexceeded|ungültig/i.test(message)) return "error";
  if (/erfolgreich|gespeichert|erstellt|kopiert|gelöscht|entfernt|verschoben|importiert|exportiert|übertragen|wiederhergestellt|verbunden|aktuell/i.test(message)) return "success";
  return "info";
}

function isProgressMessage(message: string): boolean {
  return /(?:wird|werden|läuft|liest|lädt|vorbereitet|geprüft|synchronisiert).*(?:…|\.\.\.)/i.test(message);
}

export function StatusMessage({ message, type, autoDismissMs, recordInActivity = true }: StatusMessageProps) {
  const [visible, setVisible] = useState(Boolean(message));
  const tone = useMemo(() => type ?? inferTone(message), [message, type]);

  useEffect(() => {
    setVisible(Boolean(message));
    if (!message || !recordInActivity || isProgressMessage(message)) return;
    recordActivity({
      title: tone === "error" ? "Aktion fehlgeschlagen" : tone === "success" ? "Erledigt" : "Hinweis",
      summary: message,
      tone
    });
  }, [message, recordInActivity, tone]);

  useEffect(() => {
    if (!message || !visible || tone === "error" || isProgressMessage(message) || autoDismissMs === null) return;
    const delay = autoDismissMs ?? (tone === "success" ? 8_000 : 12_000);
    const timer = window.setTimeout(() => setVisible(false), delay);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, message, tone, visible]);

  if (!message || !visible) return null;
  const Icon = tone === "success" ? CheckCircle2 : tone === "error" ? AlertCircle : Info;
  return (
    <div className={`status ${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"}>
      <Icon className="status-icon" size={21} aria-hidden="true" />
      <span>{message}</span>
      <button className="status-close" type="button" onClick={() => setVisible(false)} aria-label="Hinweis schließen">
        <X size={18} />
      </button>
    </div>
  );
}

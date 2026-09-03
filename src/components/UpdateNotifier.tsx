import { CheckCircle2, CircleAlert, DownloadCloud, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { restartApp } from "../services/db";

type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type UpdateStatus = "available" | "downloading" | "installing" | "installed" | "error";

const dismissedUpdateKey = "agendakontakte.dismissedUpdateVersion";

export function UpdateNotifier() {
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("available");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      check()
        .then((nextUpdate) => {
          if (!nextUpdate || cancelled) {
            return;
          }
          if (localStorage.getItem(dismissedUpdateKey) === nextUpdate.version) {
            return;
          }
          setAvailableUpdate(nextUpdate);
          setStatus("available");
        })
        .catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!availableUpdate) {
    return null;
  }

  const dismiss = () => {
    localStorage.setItem(dismissedUpdateKey, availableUpdate.version);
    setAvailableUpdate(null);
  };

  const installUpdate = async () => {
    try {
      let downloaded = 0;
      let contentLength = 0;
      setStatus("downloading");
      setMessage("Das Update wird heruntergeladen …");
      setProgress(0);

      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgress(0);
          return;
        }

        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            const percentage = Math.min(100, Math.round((downloaded / contentLength) * 100));
            setProgress(percentage);
            setMessage(`Das Update wird heruntergeladen … ${percentage} %`);
          }
          return;
        }

        if (event.event === "Finished") {
          setProgress(100);
          setStatus("installing");
          setMessage("Download abgeschlossen. Das Update wird installiert …");
        }
      });
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? `Update konnte nicht installiert werden: ${error.message}`
          : "Update konnte nicht installiert werden.",
      );
      return;
    }

    setStatus("installed");
    setProgress(100);
    setMessage("Update abgeschlossen. DMH Backup wird neu gestartet …");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
    try {
      await restartApp();
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? `Update wurde installiert, aber DMH Backup konnte nicht neu gestartet werden: ${error.message}`
          : "Update wurde installiert. Bitte starten Sie DMH Backup erneut.",
      );
    }
  };

  const isWorking = status === "downloading" || status === "installing";
  const showProgress = progress !== null && (isWorking || status === "installed");
  const StatusIcon = status === "available"
    ? DownloadCloud
    : status === "error"
      ? CircleAlert
      : status === "installed"
        ? CheckCircle2
        : LoaderCircle;

  return (
    <section className={`update-notifier ${isWorking ? "working" : status}`} role="dialog" aria-live="polite" aria-label="Update">
      <StatusIcon className={isWorking ? "spin update-notifier-icon" : "update-notifier-icon"} size={26} aria-hidden="true" />
      <div className="update-notifier-copy">
        <strong>
          {status === "installed"
            ? "Update abgeschlossen"
            : status === "error"
              ? "Update fehlgeschlagen"
              : status === "installing"
                ? "Update wird installiert"
                : status === "downloading"
                  ? "Update läuft"
                  : "Neue Version verfügbar"}
        </strong>
        <p>
          {message ||
            `Version ${availableUpdate.version} kann jetzt installiert werden.`}
        </p>
      </div>

      {showProgress && (
        <div
          className={status === "installing" ? "update-progress installing" : "update-progress"}
          role="progressbar"
          aria-label={status === "installing" ? "Installationsfortschritt" : "Download-Fortschritt"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <span style={{ width: `${progress ?? 0}%` }} />
        </div>
      )}

      <div className="update-notifier-actions">
        {status === "available" && (
          <>
            <button className="primary" type="button" onClick={installUpdate}>
              Jetzt aktualisieren
            </button>
            <button type="button" onClick={dismiss}>
              Spaeter
            </button>
          </>
        )}
        {isWorking && (
          <button type="button" disabled>
            {status === "installing" ? "Wird installiert …" : "Wird aktualisiert …"}
          </button>
        )}
        {status === "error" && (
          <button type="button" onClick={() => setAvailableUpdate(null)}>
            Schließen
          </button>
        )}
      </div>
    </section>
  );
}

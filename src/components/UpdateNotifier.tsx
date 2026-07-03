import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";

type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type UpdateStatus = "available" | "downloading" | "installed" | "error";

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
      setMessage("Update wird im Hintergrund heruntergeladen.");
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
            setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
          return;
        }

        if (event.event === "Finished") {
          setProgress(100);
        }
      });

      setStatus("installed");
      setMessage(
        "Update wurde installiert. Es wird nach dem Schliessen und erneuten Oeffnen der App angewendet.",
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? `Update konnte nicht installiert werden: ${error.message}`
          : "Update konnte nicht installiert werden.",
      );
    }
  };

  const isDownloading = status === "downloading";
  const showProgress = progress !== null && (isDownloading || status === "installed");

  return (
    <section className="update-notifier" role="dialog" aria-live="polite" aria-label="Update">
      <div>
        <strong>
          {status === "installed"
            ? "Update bereit"
            : status === "error"
              ? "Update fehlgeschlagen"
              : "Neue Version verfuegbar"}
        </strong>
        <p>
          {message ||
            `Version ${availableUpdate.version} kann jetzt installiert werden.`}
        </p>
      </div>

      {showProgress && (
        <div className="update-progress" aria-label="Download-Fortschritt">
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
        {isDownloading && (
          <button type="button" disabled>
            Wird aktualisiert...
          </button>
        )}
        {(status === "installed" || status === "error") && (
          <button type="button" onClick={() => setAvailableUpdate(null)}>
            Schliessen
          </button>
        )}
      </div>
    </section>
  );
}

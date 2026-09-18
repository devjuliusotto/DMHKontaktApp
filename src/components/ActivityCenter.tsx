import { AlertCircle, Bell, CheckCircle2, ChevronDown, Info, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  activityChangedEventName,
  clearActivities,
  markAllActivitiesRead,
  readActivities,
  type ActivityEntry
} from "../utils/activityLog";

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

function activityIcon(entry: ActivityEntry) {
  if (entry.tone === "success") return <CheckCircle2 size={20} aria-hidden="true" />;
  if (entry.tone === "error") return <AlertCircle size={20} aria-hidden="true" />;
  return <Info size={20} aria-hidden="true" />;
}

export function ActivityCenter() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[]>(readActivities);

  useEffect(() => {
    const refresh = () => setEntries(readActivities());
    window.addEventListener(activityChangedEventName, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(activityChangedEventName, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const unreadCount = useMemo(() => entries.filter((entry) => !entry.read).length, [entries]);

  const show = () => {
    setOpen(true);
    if (unreadCount > 0) markAllActivitiesRead();
  };

  return (
    <>
      <button
        className="activity-center-trigger"
        type="button"
        onClick={show}
        aria-label={unreadCount > 0 ? `${unreadCount} neue Aktivitäten anzeigen` : "Aktivitäten anzeigen"}
        title="Aktivitäten"
      >
        <Bell size={23} aria-hidden="true" />
        <span>Aktivitäten</span>
        {unreadCount > 0 && <strong>{unreadCount > 99 ? "99+" : unreadCount}</strong>}
      </button>

      {open && (
        <div className="activity-center-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside
            className="activity-center-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-center-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="activity-center-kicker">Verlauf</span>
                <h2 id="activity-center-title">Letzte Aktivitäten</h2>
              </div>
              <button className="icon-only" type="button" onClick={() => setOpen(false)} aria-label="Schließen" autoFocus>
                <X size={22} />
              </button>
            </header>

            {entries.length === 0 ? (
              <div className="activity-center-empty">
                <Bell size={34} aria-hidden="true" />
                <strong>Noch keine Aktivitäten</strong>
                <p>Wichtige Ergebnisse von Importen, Exporten, Löschungen und Synchronisierungen erscheinen hier.</p>
              </div>
            ) : (
              <div className="activity-center-list">
                {entries.map((entry) => (
                  <article className={`activity-entry ${entry.tone}`} key={entry.id}>
                    <span className="activity-entry-icon">{activityIcon(entry)}</span>
                    <div>
                      <div className="activity-entry-heading">
                        <strong>{entry.title}</strong>
                        <time dateTime={entry.createdAt}>{dateFormatter.format(new Date(entry.createdAt))}</time>
                      </div>
                      <p>{entry.summary}</p>
                      {((entry.details?.length ?? 0) > 0 || (entry.items?.length ?? 0) > 0) && (
                        <details>
                          <summary><ChevronDown size={16} aria-hidden="true" /> Details anzeigen</summary>
                          {entry.details && entry.details.length > 0 && <ul>{entry.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}</ul>}
                          {entry.items && entry.items.length > 0 && (
                            <ul>{entry.items.map((item, index) => <li key={`${item.label}-${index}`}><strong>{item.label}</strong>{item.detail && <span>{item.detail}</span>}</li>)}</ul>
                          )}
                        </details>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}

            {entries.length > 0 && (
              <footer>
                <button type="button" onClick={clearActivities}><Trash2 size={18} /> Verlauf leeren</button>
              </footer>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

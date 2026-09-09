import { ArrowRight, CalendarDays, Check, LoaderCircle, MailCheck, MailOpen, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import type { Page } from "../components/Sidebar";
import { getMigrationCaptureStatus, listContacts } from "../services/db";
import type { MigrationCaptureResult, MigrationCaptureStatus } from "../types/mail";
import { calendarStorageKey } from "../utils/calendar";

interface WelcomePageProps {
  onNavigate: (page: Page) => void;
}

export function WelcomePage({ onNavigate }: WelcomePageProps) {
  const [migrationStatus, setMigrationStatus] = useState<MigrationCaptureStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [migrationDialogOpen, setMigrationDialogOpen] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const [contactCount, setContactCount] = useState(0);
  const [calendarCount, setCalendarCount] = useState(0);

  useEffect(() => {
    const loadStatus = async () => {
      const [mailStatus, contacts] = await Promise.allSettled([
        getMigrationCaptureStatus(),
        listContacts()
      ]);
      if (mailStatus.status === "fulfilled") setMigrationStatus(mailStatus.value);
      if (contacts.status === "fulfilled") setContactCount(contacts.value.length);
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]");
        setCalendarCount(Array.isArray(stored) ? stored.length : 0);
      } catch {
        setCalendarCount(0);
      }
      setStatusLoading(false);
    };
    void loadStatus();
  }, []);

  const migrationCompleted = migrationStatus?.completed === true;
  const contactsCompleted = contactCount > 0;
  const calendarCompleted = calendarCount > 0;
  const everythingCompleted = migrationCompleted && contactsCompleted && calendarCompleted;
  const completedSteps = [migrationCompleted, contactsCompleted, calendarCompleted].filter(Boolean).length;

  const migrationSent = (result: MigrationCaptureResult) => {
    setMigrationStatus({ configured: true, completed: true, completedAt: result.completedAt });
    setMigrationError("");
  };

  const steps: Array<{
    completed: boolean;
    description: string;
    icon: typeof UsersRound;
    label: string;
    onClick: () => void;
    title: string;
    unavailable?: boolean;
  }> = [
    {
      title: "E-Mail-Daten an die EDV senden",
      description: "Pflicht: Ohne diesen Schritt kann Ihr E-Mail-Konto nicht übertragen werden.",
      label: migrationCompleted ? "Bereits gesendet" : "Sicher an die EDV senden",
      onClick: () => setMigrationDialogOpen(true),
      icon: MailCheck,
      completed: migrationCompleted,
      unavailable: statusLoading || migrationStatus?.configured === false
    },
    {
      title: "Kontakte importieren und ordnen",
      description: contactsCompleted ? `${contactCount} Kontakte sind vorbereitet.` : "Kontakte aus Outlook Classic oder Thunderbird übernehmen.",
      label: contactsCompleted ? "Kontakte prüfen" : "Kontakte importieren",
      onClick: () => onNavigate("contacts"),
      icon: UsersRound,
      completed: contactsCompleted
    },
    {
      title: "Kalender importieren",
      description: calendarCompleted ? `${calendarCount} Termine sind vorbereitet.` : "Termine aus Outlook Classic oder Thunderbird übernehmen.",
      label: calendarCompleted ? "Kalender prüfen" : "Kalender importieren",
      onClick: () => onNavigate("calendar"),
      icon: CalendarDays,
      completed: calendarCompleted
    }
  ];

  return (
    <div className="page migration-welcome-page">
      <section className={everythingCompleted ? "migration-email completed" : "migration-email"} aria-labelledby="migration-email-subject">
        <header className="migration-email-toolbar">
          <span className="migration-email-symbol"><MailOpen size={25} aria-hidden="true" /></span>
          <strong>Kurzanleitung</strong>
          <span className={everythingCompleted ? "migration-email-progress completed" : "migration-email-progress"}>
            {everythingCompleted ? <Check size={18} aria-hidden="true" /> : null}
            {completedSteps} von 3 erledigt
          </span>
        </header>

        <article className="migration-email-body">
          <p className="migration-email-salutation">Liebe Schwester, lieber Bruder,<br />liebe Mitarbeiterin, lieber Mitarbeiter,</p>
          <h2 id="migration-email-subject">
            {everythingCompleted ? "Sie haben alles erledigt" : "Wir benötigen kurz Ihre Hilfe"}
          </h2>
          {everythingCompleted ? (
            <p className="migration-email-intro success">Alle notwendigen Schritte für die Migration haben Sie bereits abgeschlossen. Vielen Dank für Ihre Hilfe.</p>
          ) : (
            <p className="migration-email-intro">Für die Windows-Migration und den Umzug auf unseren neuen Exchange-Server erledigen Sie bitte die folgenden drei Schritte.</p>
          )}

          <ol className="migration-welcome-steps">
            {steps.map(({ completed, description, icon: Icon, label, onClick, title, unavailable }, index) => (
              <li className={completed ? "completed" : ""} key={title}>
                <span className="migration-welcome-number" aria-hidden="true">
                  {completed ? <Check size={21} strokeWidth={3} /> : index + 1}
                </span>
                <span className="migration-welcome-icon"><Icon size={29} aria-hidden="true" /></span>
                <div className="migration-welcome-copy">
                  <h3>{title}</h3>
                  <p>{description}</p>
                </div>
                <button className={completed ? "large migration-welcome-review-button" : "primary large"} type="button" onClick={onClick} disabled={unavailable || (index === 0 && completed)}>
                  {statusLoading && index === 0 ? <LoaderCircle className="spin" size={20} aria-hidden="true" /> : completed && index === 0 ? <Check size={20} aria-hidden="true" /> : null}
                  <span>{statusLoading && index === 0 ? "Status wird geprüft …" : label}</span>
                  {!(statusLoading && index === 0) && !(completed && index === 0) && <ArrowRight size={20} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ol>

          {migrationError && <p className="migration-welcome-error" role="alert">Übertragung fehlgeschlagen: {migrationError}</p>}

          <footer className="migration-email-signature">
            <span>Vielen Dank für Ihre Unterstützung.</span>
            <strong>Ihre EDV</strong>
          </footer>
        </article>
      </section>

      <MigrationCaptureDialog
        open={migrationDialogOpen}
        onClose={() => setMigrationDialogOpen(false)}
        onCompleted={migrationSent}
        onFailed={setMigrationError}
      />
    </div>
  );
}

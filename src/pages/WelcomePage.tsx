import type { Page } from "../components/Sidebar";

interface WelcomePageProps {
  onNavigate: (page: Page) => void;
}

export function WelcomePage({ onNavigate }: WelcomePageProps) {
  return (
    <div className="page">
      <article className="readme-page">
        <h1>AgendaKontakte</h1>
        <p className="readme-lead">
          AgendaKontakte ist eine lokale Windows-App für Kontakte, Gruppen, Outlook-Importe und einfache Kalenderübernahme.
          Alle Kontaktdaten bleiben auf diesem PC. Eine zeitlich begrenzte Übertragung von E-Mail-Zugangsdaten für die Exchange-Migration erfolgt nur nach einem ausdrücklichen Hinweis und Ihrer Zustimmung.
        </p>

        <h2>Erste Schritte</h2>
        <ol>
          <li>Öffnen Sie <strong>Kontakte</strong>, um Kontakte anzulegen, zu bearbeiten oder zu suchen.</li>
          <li>Erstellen Sie links in der Kontaktansicht Gruppen und ziehen Sie Kontakte mit der Maus in eine Gruppe.</li>
          <li>Nutzen Sie <strong>Importieren</strong>, um CSV, Excel, PST oder OST zu übernehmen.</li>
          <li>Nutzen Sie <strong>Exportieren</strong>, um eine CSV-Datei für Outlook oder Tabellenprogramme zu erstellen.</li>
        </ol>

        <h2>Kontakte</h2>
        <p>
          Die Kontaktliste zeigt Name, E-Mail, Telefon, Stadt, Gruppen und Änderungsdatum. Die Spaltenbreiten können direkt in der Tabellenüberschrift angepasst werden.
          Über die Aktionsbuttons bearbeiten Sie Kontakte, schreiben eine neue E-Mail in Outlook Classic oder verschieben Kontakte in den Papierkorb.
        </p>
        <div className="readme-actions">
          <button type="button" onClick={() => onNavigate("contacts")}>Kontakte öffnen</button>
          <button type="button" onClick={() => onNavigate("trash")}>Papierkorb öffnen</button>
        </div>

        <h2>Importieren</h2>
        <p>
          CSV- und Excel-Dateien werden automatisch geprüft. Kontakte mit und ohne E-Mail werden getrennt angezeigt. Vor dem Import kann eine Gruppe ausgewählt oder neu erstellt werden.
          PST- und OST-Dateien werden über Outlook Classic gelesen.
        </p>
        <div className="readme-actions">
          <button type="button" onClick={() => onNavigate("import")}>Import starten</button>
        </div>

        <h2>Kalender</h2>
        <p>
          Kalendertermine können aus ICS-, EML-, PST- und OST-Dateien importiert werden. Für PST/OST muss Outlook Classic auf dem Windows-PC verfügbar sein.
        </p>
        <div className="readme-actions">
          <button type="button" onClick={() => onNavigate("calendar")}>Kalender öffnen</button>
        </div>
      </article>
    </div>
  );
}

import { sqliteSchema } from "../db/schema";

export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Einstellungen</h2>
          <p>AgendaKontakte speichert alle Daten lokal auf diesem PC.</p>
        </div>
      </header>
      <section className="form-panel">
        <h3>Sprache</h3>
        <p>Deutsch ist aktuell als Standardsprache aktiv. Die Struktur ist für spätere Übersetzungen vorbereitet.</p>
      </section>
      <section className="form-panel">
        <h3>Datenbank</h3>
        <pre className="schema">{sqliteSchema}</pre>
      </section>
    </div>
  );
}

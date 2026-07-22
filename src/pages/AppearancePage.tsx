import { AppearanceSettings } from "../components/AppearanceSettings";

export function AppearancePage() {
  return (
    <div className="page appearance-page">
      <header className="page-header">
        <div>
          <h2>Erscheinungsbild</h2>
          <p>Darstellung und Akzentfarbe der App anpassen.</p>
        </div>
      </header>

      <AppearanceSettings />
    </div>
  );
}

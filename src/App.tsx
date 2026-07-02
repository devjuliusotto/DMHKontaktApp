import { useState } from "react";
import { Sidebar, type Page } from "./components/Sidebar";
import { ContactsPage } from "./pages/ContactsPage";
import { ExportPage } from "./pages/ExportPage";
import { ImportPage } from "./pages/ImportPage";
import { CalendarPage } from "./pages/CalendarPage";
import { TrashPage } from "./pages/TrashPage";

export default function App() {
  const [page, setPage] = useState<Page>("contacts");

  return (
    <div className="app-shell">
      <Sidebar activePage={page} onNavigate={setPage} />
      <main className="content">
        {page === "contacts" && <ContactsPage onNavigate={setPage} />}
        {page === "calendar" && <CalendarPage />}
        {page === "import" && <ImportPage />}
        {page === "export" && <ExportPage />}
        {page === "trash" && <TrashPage />}
      </main>
    </div>
  );
}

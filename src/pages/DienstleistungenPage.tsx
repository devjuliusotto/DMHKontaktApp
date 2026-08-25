import {
  Armchair,
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Car,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileText,
  Monitor,
  Paperclip,
  PackageOpen,
  Search,
  Send,
  Table2,
  Tent,
  Ticket,
  Utensils,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { OutdoorBookingsPanel } from "../components/OutdoorBookingsPanel";

type ServiceSection = "bookings" | "tickets" | "meals";
type BookingMode = "standard" | "outdoor";
type MealMode = "menu" | "reservation";
type BookingResource = "Raum" | "Auto" | "Projektor" | "Zelt" | "Stühle" | "Tische";
type CheckinView = "day" | "week" | "month";

interface Booking {
  id: string;
  resource: BookingResource;
  details: string;
  date: string;
  from: string;
  to: string;
  requester: string;
  note: string;
  createdAt: string;
  status?: "Offen" | "Bestätigt" | "Abgelehnt" | "Abgeschlossen";
}

interface TicketAttachment {
  name: string;
  dataUrl: string;
}

interface ServiceTicket {
  id: string;
  category: "IT" | "Hauswirtschaft" | "Haustechnik";
  title: string;
  message: string;
  assignee: string;
  attachments: TicketAttachment[];
  createdAt: string;
  status: "Offen" | "In Bearbeitung" | "Erledigt";
}

interface MealCheckin {
  id: string;
  date: string;
  people: number;
  note: string;
  createdAt: string;
}

interface OutdoorBookingOverview {
  id: string;
  eventName: string;
  date: string;
  from: string;
  to: string;
  location: string;
  responsible: string;
  people: number;
  status: "Offen" | "Bestätigt" | "Abgelehnt" | "Abgeschlossen";
  createdAt: string;
}

interface ServiceOverviewRecord {
  key: string;
  id: string;
  kind: ServiceSection;
  title: string;
  subtitle: string;
  scheduled: string;
  status: string;
  createdAt: string;
  searchText: string;
  details: Array<{ label: string; value: string }>;
}

type ServiceOverviewFilter = "all" | ServiceSection;

const bookingsKey = "dmh-dienstleistungen-bookings-v1";
const ticketsKey = "dmh-dienstleistungen-tickets-v1";
const checkinsKey = "dmh-dienstleistungen-checkins-v1";
const outdoorBookingsKey = "dmh-dienstleistungen-outdoor-bookings-v1";

const resourceOptions: Array<{ value: BookingResource; label: string; icon: typeof Building2 }> = [
  { value: "Raum", label: "Räume", icon: Building2 },
  { value: "Auto", label: "Dienstfahrzeuge", icon: Car },
  { value: "Projektor", label: "Projektoren", icon: Monitor },
  { value: "Zelt", label: "Zelte / Pavillons", icon: Tent },
  { value: "Stühle", label: "Stühle", icon: Armchair },
  { value: "Tische", label: "Tische", icon: Table2 }
];

const overviewFilterOptions: Array<{ value: ServiceOverviewFilter; label: string }> = [
  { value: "all", label: "Alle" },
  { value: "tickets", label: "Tickets" },
  { value: "bookings", label: "Buchungen" },
  { value: "meals", label: "Mahlzeiten" }
];

const today = new Date().toISOString().slice(0, 10);

export function DienstleistungenPage() {
  const [section, setSection] = useState<ServiceSection | null>(null);
  const [bookingMode, setBookingMode] = useState<BookingMode | null>(null);
  const [mealMode, setMealMode] = useState<MealMode | null>(null);
  const [bookings, setBookings] = useState<Booking[]>(() => readStored(bookingsKey, []));
  const [tickets, setTickets] = useState<ServiceTicket[]>(() => readStored(ticketsKey, []));
  const [checkins, setCheckins] = useState<MealCheckin[]>(() => readStored(checkinsKey, []));
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [bookingForm, setBookingForm] = useState({ resource: "Raum" as BookingResource, details: "", date: today, from: "09:00", to: "12:00", requester: "", note: "" });
  const [ticketForm, setTicketForm] = useState({ category: "IT" as ServiceTicket["category"], title: "", message: "", assignee: "" });
  const [ticketAttachments, setTicketAttachments] = useState<TicketAttachment[]>([]);
  const [checkinForm, setCheckinForm] = useState({ date: today, people: "1", note: "" });
  const [checkinView, setCheckinView] = useState<CheckinView>("week");

  const visibleCheckins = useMemo(() => {
    const reference = new Date(`${checkinForm.date}T12:00:00`);
    return checkins.filter((checkin) => {
      const date = new Date(`${checkin.date}T12:00:00`);
      if (checkinView === "day") return checkin.date === checkinForm.date;
      if (checkinView === "month") return date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth();
      const referenceDay = (reference.getDay() + 6) % 7;
      const start = new Date(reference);
      start.setDate(reference.getDate() - referenceDay);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return date >= start && date < end;
    }).sort((left, right) => left.date.localeCompare(right.date));
  }, [checkins, checkinForm.date, checkinView]);

  const selectSection = (next: ServiceSection) => {
    setSection(next);
    setBookingMode(null);
    setMealMode(null);
    setMessage("");
  };

  const closeSection = () => {
    setSection(null);
    setBookingMode(null);
    setMealMode(null);
    setMessage("");
  };

  const openBooking = (resource: BookingResource) => {
    setBookingForm((current) => ({ ...current, resource }));
    setBookingMode("standard");
    setMessage("");
  };

  const saveBooking = (event: FormEvent) => {
    event.preventDefault();
    const booking: Booking = { ...bookingForm, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "Offen" };
    const next = [booking, ...bookings];
    setBookings(next);
    writeStored(bookingsKey, next);
    setMessage("Die Buchungsanfrage wurde gespeichert und kann nun bearbeitet werden.");
    setMessageType("success");
    setBookingForm({ ...bookingForm, details: "", note: "" });
  };

  const handleTicketFiles = async (files: FileList | null) => {
    if (!files) return;
    const selected = Array.from(files).slice(0, 5);
    const attachments = await Promise.all(selected.map(async (file) => ({ name: file.name, dataUrl: await readFileAsDataUrl(file) })));
    setTicketAttachments(attachments);
  };

  const saveTicket = (event: FormEvent) => {
    event.preventDefault();
    const ticket: ServiceTicket = { ...ticketForm, id: `T-${Date.now()}`, attachments: ticketAttachments, createdAt: new Date().toISOString(), status: "Offen" };
    const next = [ticket, ...tickets];
    setTickets(next);
    writeStored(ticketsKey, next);
    setMessage(`Ticket ${ticket.id} wurde geöffnet.`);
    setMessageType("success");
    setTicketForm({ category: ticketForm.category, title: "", message: "", assignee: "" });
    setTicketAttachments([]);
  };

  const saveCheckin = (event: FormEvent) => {
    event.preventDefault();
    const checkin: MealCheckin = { id: crypto.randomUUID(), date: checkinForm.date, people: Math.max(1, Number(checkinForm.people) || 1), note: checkinForm.note, createdAt: new Date().toISOString() };
    const next = [checkin, ...checkins];
    setCheckins(next);
    writeStored(checkinsKey, next);
    setMessage("Die Mahlzeit wurde reserviert.");
    setMessageType("success");
    setCheckinForm({ ...checkinForm, note: "" });
  };

  return (
    <div className="page dienstleistungen-page">
      <header className="page-header">
        <div>
          <h2>Dienstleistungen</h2>
          <p>Buchungen, Serviceanfragen und Mahlzeiten zentral organisieren.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      {!section && (
        <>
          <section className="dienstleistungen-actions" aria-label="Dienstleistungsbereiche">
            <ServiceAction variant="booking" icon={<CalendarDays size={27} />} title="Buchungen" description="Räume, Fahrzeuge, Technik, Ausstattung und Outdoor-Material reservieren." onClick={() => selectSection("bookings")} />
            <ServiceAction variant="ticket" icon={<Ticket size={27} />} title="Service anfordern" description="Tickets an IT, Hauswirtschaft oder Haustechnik senden." onClick={() => selectSection("tickets")} />
            <ServiceAction variant="meal" icon={<Utensils size={27} />} title="Mahlzeiten" description="Speiseplan ansehen und Mahlzeiten für eine oder mehrere Personen reservieren." onClick={() => selectSection("meals")} />
          </section>
          <ServicesOverview bookings={bookings} tickets={tickets} checkins={checkins} onOpen={selectSection} />
        </>
      )}

      {section === "bookings" && (
        <div className="dienstleistung-workspace">
          <WorkspaceHeading icon={<CalendarDays size={24} />} title="Buchungen" description="Wählen Sie zuerst, was Sie reservieren möchten." onBack={closeSection} />
          {!bookingMode && <section className="dienstleistung-choice-grid" aria-label="Buchungsarten">
            <ServiceChoice icon={<Building2 size={25} />} title="Räume" description="Besprechungs-, Gruppen- und Veranstaltungsräume reservieren." onClick={() => openBooking("Raum")} />
            <ServiceChoice icon={<Car size={25} />} title="Fahrzeuge" description="Dienstfahrzeuge für einen Zeitraum anfragen." onClick={() => openBooking("Auto")} />
            <ServiceChoice icon={<Monitor size={25} />} title="Technik" description="Projektoren und technische Ausstattung reservieren." onClick={() => openBooking("Projektor")} />
            <ServiceChoice icon={<Armchair size={25} />} title="Ausstattung" description="Zelte, Stühle, Tische und weitere Ausstattung buchen." onClick={() => openBooking("Zelt")} />
            <ServiceChoice icon={<PackageOpen size={25} />} title="Outdoor/Geräte" description="Outdoor-Veranstaltungen und Material mit vollständiger Checkliste planen." accent="outdoor" onClick={() => setBookingMode("outdoor")} />
          </section>}
          {bookingMode === "standard" && <section className="dienstleistung-panel">
            <PanelHeading icon={<CalendarDays size={22} />} title={`${bookingForm.resource} buchen`} description="Reservierungszeitraum und benötigten Gegenstand angeben." onClose={() => setBookingMode(null)} />
            <form className="dienstleistung-form" onSubmit={saveBooking}>
              <label className="field"><span>Was möchten Sie buchen? *</span><select value={bookingForm.resource} onChange={(event) => setBookingForm({ ...bookingForm, resource: event.target.value as BookingResource })}>{resourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="field"><span>Raum / Gegenstand / Nummer</span><input value={bookingForm.details} onChange={(event) => setBookingForm({ ...bookingForm, details: event.target.value })} placeholder="z. B. Gruppenraum 2 oder Fahrzeug 3" /></label>
              <label className="field"><span>Datum *</span><input type="date" value={bookingForm.date} onChange={(event) => setBookingForm({ ...bookingForm, date: event.target.value })} required /></label>
              <label className="field"><span>Von *</span><input type="time" value={bookingForm.from} onChange={(event) => setBookingForm({ ...bookingForm, from: event.target.value })} required /></label>
              <label className="field"><span>Bis *</span><input type="time" value={bookingForm.to} onChange={(event) => setBookingForm({ ...bookingForm, to: event.target.value })} required /></label>
              <label className="field"><span>Anfragende Person *</span><input value={bookingForm.requester} onChange={(event) => setBookingForm({ ...bookingForm, requester: event.target.value })} required placeholder="Name" /></label>
              <label className="field wide"><span>Hinweise</span><textarea rows={3} value={bookingForm.note} onChange={(event) => setBookingForm({ ...bookingForm, note: event.target.value })} placeholder="Anlass, Anzahl Personen oder besondere Anforderungen" /></label>
              <div className="button-row"><button className="primary" type="submit"><Send size={19} /> Buchungsanfrage senden</button></div>
            </form>
            <BookingList bookings={bookings} />
          </section>}
          {bookingMode === "outdoor" && <section className="dienstleistung-panel outdoor-panel">
            <PanelHeading icon={<PackageOpen size={22} />} title="Outdoor/Geräte Buchungen" description="Outdoor-Veranstaltung planen, Material reservieren und Zuständigkeiten festhalten." onClose={() => setBookingMode(null)} />
            <OutdoorBookingsPanel />
          </section>}
        </div>
      )}

      {section === "tickets" && (
        <section className="dienstleistung-panel">
          <PanelHeading icon={<Ticket size={22} />} title="Service anfordern" description="Ein Ticket mit Beschreibung, Zuständigkeit und Fotos eröffnen." onClose={closeSection} />
          <form className="dienstleistung-form" onSubmit={saveTicket}>
            <label className="field"><span>Bereich *</span><select value={ticketForm.category} onChange={(event) => setTicketForm({ ...ticketForm, category: event.target.value as ServiceTicket["category"] })}><option>IT</option><option>Hauswirtschaft</option><option>Haustechnik</option></select></label>
            <label className="field"><span>Zuständig an</span><input value={ticketForm.assignee} onChange={(event) => setTicketForm({ ...ticketForm, assignee: event.target.value })} placeholder="Name oder Team" /></label>
            <label className="field wide"><span>Titel *</span><input value={ticketForm.title} onChange={(event) => setTicketForm({ ...ticketForm, title: event.target.value })} required placeholder="Kurze Beschreibung des Anliegens" /></label>
            <label className="field wide"><span>Nachricht *</span><textarea rows={6} value={ticketForm.message} onChange={(event) => setTicketForm({ ...ticketForm, message: event.target.value })} required placeholder="Was ist passiert, wo und wann?" /></label>
            <label className="service-attachment-input"><Paperclip size={19} /><span>Fotos anhängen (max. 5)</span><input type="file" accept="image/*" multiple onChange={(event) => void handleTicketFiles(event.target.files)} /></label>
            {ticketAttachments.length > 0 && <div className="service-attachments">{ticketAttachments.map((file) => <span key={file.name}><FileText size={16} /> {file.name}</span>)}</div>}
            <div className="button-row"><button className="primary" type="submit"><Send size={19} /> Ticket öffnen</button></div>
          </form>
          <TicketList tickets={tickets} />
        </section>
      )}

      {section === "meals" && (
        <div className="dienstleistung-workspace">
          <WorkspaceHeading icon={<Utensils size={24} />} title="Mahlzeiten" description="Speiseplan ansehen oder eine Mahlzeit reservieren." onBack={closeSection} />
          {!mealMode && <section className="dienstleistung-choice-grid meal-choice-grid" aria-label="Mahlzeiten">
            <ServiceChoice icon={<Utensils size={25} />} title="Speiseplan der Woche" description="Das Menü von Montag bis Freitag ansehen." onClick={() => setMealMode("menu")} />
            <ServiceChoice icon={<CheckCircle2 size={25} />} title="Mahlzeit reservieren" description="Essen für eine oder mehrere Personen verbindlich anmelden." onClick={() => setMealMode("reservation")} />
          </section>}
          {mealMode === "menu" && <section className="dienstleistung-panel">
            <PanelHeading icon={<Utensils size={22} />} title="Speiseplan der Woche" description="Woche über das Referenzdatum auswählen." onClose={() => setMealMode(null)} />
            <label className="field meal-reference-date"><span>Woche mit diesem Datum</span><input type="date" value={checkinForm.date} onChange={(event) => setCheckinForm({ ...checkinForm, date: event.target.value })} /></label>
            <WeeklyMenu referenceDate={checkinForm.date} />
          </section>}
          {mealMode === "reservation" && <section className="dienstleistung-panel">
            <PanelHeading icon={<CheckCircle2 size={22} />} title="Mahlzeit reservieren" description="Reservierungen für den gewünschten Zeitraum verwalten." onClose={() => setMealMode(null)} />
            <div className="checkin-toolbar"><div className="checkin-view-buttons">{(["day", "week", "month"] as CheckinView[]).map((view) => <button key={view} className={checkinView === view ? "active" : ""} type="button" onClick={() => setCheckinView(view)}>{view === "day" ? "Tag" : view === "week" ? "Woche" : "Monat"}</button>)}</div></div>
            <form className="dienstleistung-form checkin-form" onSubmit={saveCheckin}>
              <label className="field"><span>Datum *</span><input type="date" value={checkinForm.date} onChange={(event) => setCheckinForm({ ...checkinForm, date: event.target.value })} required /></label>
              <label className="field"><span>Personen *</span><input type="number" min="1" max="500" value={checkinForm.people} onChange={(event) => setCheckinForm({ ...checkinForm, people: event.target.value })} required /></label>
              <label className="field wide"><span>Hinweis / Ernährungswunsch</span><input value={checkinForm.note} onChange={(event) => setCheckinForm({ ...checkinForm, note: event.target.value })} placeholder="Optional" /></label>
              <div className="button-row"><button className="primary" type="submit"><CheckCircle2 size={19} /> Mahlzeit reservieren</button></div>
            </form>
            <div className="checkin-list-heading"><h3>Reservierungen</h3><span>{visibleCheckins.length} im gewählten Zeitraum</span></div>
            {visibleCheckins.length === 0 ? <p className="dienstleistung-empty">Noch keine Mahlzeiten für diesen Zeitraum reserviert.</p> : <div className="checkin-list">{visibleCheckins.map((checkin) => <article key={checkin.id}><span><strong>{formatDate(checkin.date)}</strong><small>{checkin.people} {checkin.people === 1 ? "Person" : "Personen"}</small></span><span>{checkin.note || "Kein Hinweis"}</span></article>)}</div>}
          </section>}
        </div>
      )}
    </div>
  );
}

function ServicesOverview({ bookings, tickets, checkins, onOpen }: {
  bookings: Booking[];
  tickets: ServiceTicket[];
  checkins: MealCheckin[];
  onOpen: (section: ServiceSection) => void;
}) {
  const [filter, setFilter] = useState<ServiceOverviewFilter>("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const outdoorBookings = useMemo(() => readStored<OutdoorBookingOverview[]>(outdoorBookingsKey, []), []);

  const records = useMemo<ServiceOverviewRecord[]>(() => {
    const bookingRecords = bookings.map((booking) => ({
      key: `booking:${booking.id}`,
      id: booking.id,
      kind: "bookings" as const,
      title: booking.details || booking.resource,
      subtitle: `${booking.resource}${booking.requester ? ` · ${booking.requester}` : ""}`,
      scheduled: `${formatDate(booking.date)} · ${booking.from}–${booking.to}`,
      status: booking.status || "Offen",
      createdAt: booking.createdAt,
      searchText: [booking.resource, booking.details, booking.requester, booking.note, booking.status || "Offen"].join(" "),
      details: [
        { label: "Buchungsnummer", value: booking.id },
        { label: "Ressource", value: booking.resource },
        { label: "Raum / Gegenstand", value: booking.details || "Noch nicht konkretisiert" },
        { label: "Termin", value: `${formatDate(booking.date)}, ${booking.from}–${booking.to}` },
        { label: "Anfragende Person", value: booking.requester || "Nicht angegeben" },
        { label: "Hinweise", value: booking.note || "Keine Hinweise" }
      ]
    }));
    const outdoorRecords = outdoorBookings.map((booking) => ({
      key: `outdoor:${booking.id}`,
      id: booking.id,
      kind: "bookings" as const,
      title: booking.eventName || "Outdoor-/Geräteanfrage",
      subtitle: `Outdoor/Geräte${booking.location ? ` · ${booking.location}` : ""}`,
      scheduled: `${formatDate(booking.date)} · ${booking.from}–${booking.to}`,
      status: booking.status || "Offen",
      createdAt: booking.createdAt,
      searchText: [booking.eventName, booking.location, booking.responsible, booking.status].join(" "),
      details: [
        { label: "Anfragenummer", value: booking.id },
        { label: "Bereich", value: "Outdoor/Geräte" },
        { label: "Termin", value: `${formatDate(booking.date)}, ${booking.from}–${booking.to}` },
        { label: "Ort", value: booking.location || "Nicht angegeben" },
        { label: "Verantwortlich", value: booking.responsible || "Nicht angegeben" },
        { label: "Personenzahl", value: String(booking.people || 1) }
      ]
    }));
    const ticketRecords = tickets.map((ticket) => ({
      key: `ticket:${ticket.id}`,
      id: ticket.id,
      kind: "tickets" as const,
      title: ticket.title,
      subtitle: `${ticket.category}${ticket.assignee ? ` · ${ticket.assignee}` : ""}`,
      scheduled: formatDateTime(ticket.createdAt),
      status: ticket.status,
      createdAt: ticket.createdAt,
      searchText: [ticket.id, ticket.title, ticket.category, ticket.assignee, ticket.message, ticket.status].join(" "),
      details: [
        { label: "Ticketnummer", value: ticket.id },
        { label: "Bereich", value: ticket.category },
        { label: "Zuständig", value: ticket.assignee || "Noch nicht zugewiesen" },
        { label: "Nachricht", value: ticket.message },
        { label: "Anhänge", value: ticket.attachments.length ? `${ticket.attachments.length} Datei(en)` : "Keine Anhänge" },
        { label: "Erstellt", value: formatDateTime(ticket.createdAt) }
      ]
    }));
    const mealRecords = checkins.map((checkin) => ({
      key: `meal:${checkin.id}`,
      id: checkin.id,
      kind: "meals" as const,
      title: `Mittagessen für ${checkin.people} ${checkin.people === 1 ? "Person" : "Personen"}`,
      subtitle: checkin.note || "Ohne besonderen Ernährungswunsch",
      scheduled: formatDate(checkin.date),
      status: checkin.date < today ? "Abgeschlossen" : "Reserviert",
      createdAt: checkin.createdAt,
      searchText: [checkin.note, checkin.people, checkin.date].join(" "),
      details: [
        { label: "Reservierungsnummer", value: checkin.id },
        { label: "Datum", value: formatDate(checkin.date) },
        { label: "Personen", value: String(checkin.people) },
        { label: "Ernährungswunsch / Hinweis", value: checkin.note || "Kein Hinweis" },
        { label: "Reserviert am", value: formatDateTime(checkin.createdAt) }
      ]
    }));

    return [...ticketRecords, ...bookingRecords, ...outdoorRecords, ...mealRecords]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [bookings, checkins, outdoorBookings, tickets]);

  const counts = useMemo(() => records.reduce<Record<ServiceOverviewFilter, number>>((result, record) => {
    result.all += 1;
    result[record.kind] += 1;
    return result;
  }, { all: 0, bookings: 0, tickets: 0, meals: 0 }), [records]);
  const statuses = useMemo(() => Array.from(new Set(records.map((record) => record.status))).sort((left, right) => left.localeCompare(right, "de")), [records]);
  const visibleRecords = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de-DE");
    return records.filter((record) => {
      if (filter !== "all" && record.kind !== filter) return false;
      if (statusFilter !== "all" && record.status !== statusFilter) return false;
      return !query || `${record.title} ${record.subtitle} ${record.id} ${record.searchText}`.toLocaleLowerCase("de-DE").includes(query);
    });
  }, [filter, records, search, statusFilter]);
  const selectedRecord = records.find((record) => record.key === selectedKey) ?? null;
  const activeCount = records.filter((record) => !["Abgeschlossen", "Abgelehnt", "Erledigt"].includes(record.status)).length;

  useEffect(() => {
    if (!selectedKey) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedKey]);

  return <section className="dienstleistungen-overview" aria-labelledby="services-overview-title">
    <header className="dienstleistungen-overview-heading">
      <div className="dienstleistungen-overview-title">
        <span><ClipboardList size={24} /></span>
        <div><h3 id="services-overview-title">Meine Vorgänge</h3><p>Eigene Tickets, Buchungen und Mahlzeiten mit aktuellem Status.</p></div>
      </div>
      <div className="dienstleistungen-overview-totals"><span><strong>{records.length}</strong> insgesamt</span><span><strong>{activeCount}</strong> aktiv</span></div>
    </header>

    <div className="dienstleistungen-overview-toolbar">
      <label className="dienstleistungen-overview-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Vorgänge suchen</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Vorgänge suchen …" /></label>
      <div className="dienstleistungen-overview-filters" role="group" aria-label="Vorgangstyp filtern">
        {overviewFilterOptions.map((option) => <button className={filter === option.value ? "active" : ""} type="button" key={option.value} onClick={() => setFilter(option.value)}>{option.label}<span>{counts[option.value]}</span></button>)}
      </div>
      <label className="dienstleistungen-status-filter"><span className="sr-only">Status filtern</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Alle Status</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
    </div>

    <div className="dienstleistungen-overview-table-wrap">
      <table className="dienstleistungen-overview-table">
        <thead><tr><th>Vorgang</th><th>Art</th><th>Termin / Eingang</th><th>Status</th><th>Erstellt</th><th><span className="sr-only">Details</span></th></tr></thead>
        <tbody>
          {visibleRecords.map((record) => <tr className={selectedKey === record.key ? "selected" : ""} key={record.key} tabIndex={0} onClick={() => setSelectedKey(record.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(record.key); } }}>
            <td><div className={`dienstleistungen-record-primary ${record.kind}`}><span><ServiceRecordIcon kind={record.kind} /></span><span><strong>{record.title}</strong><small>{record.subtitle}</small></span></div></td>
            <td>{serviceKindLabel(record.kind)}</td>
            <td>{record.scheduled}</td>
            <td><span className={`dienstleistungen-status ${serviceStatusTone(record.status)}`}>{record.status}</span></td>
            <td>{formatDateTime(record.createdAt)}</td>
            <td><button className="icon-only" type="button" title="Details anzeigen" aria-label={`Details zu ${record.title} anzeigen`} onClick={() => setSelectedKey(record.key)}><ArrowRight size={18} /></button></td>
          </tr>)}
          {visibleRecords.length === 0 ? <tr><td className="dienstleistungen-overview-empty" colSpan={6}>{records.length === 0 ? "Noch keine eigenen Vorgänge vorhanden. Über die Schaltflächen oben können Sie die erste Anfrage erstellen." : "Keine Vorgänge entsprechen den gewählten Filtern."}</td></tr> : null}
        </tbody>
      </table>
    </div>

    {selectedRecord ? <div className="modal-backdrop dienstleistungen-record-modal" role="dialog" aria-modal="true" aria-labelledby="dienstleistungen-record-modal-title" onMouseDown={() => setSelectedKey(null)}>
      <article className="modal-card dienstleistungen-record-details" onMouseDown={(event) => event.stopPropagation()}>
        <header><div className="dienstleistungen-overview-title"><span><ServiceRecordIcon kind={selectedRecord.kind} /></span><div><small>{serviceKindLabel(selectedRecord.kind)} · {selectedRecord.id}</small><h4 id="dienstleistungen-record-modal-title">{selectedRecord.title}</h4></div></div><button className="icon-only" type="button" title="Details schließen" aria-label="Details schließen" autoFocus onClick={() => setSelectedKey(null)}><X size={19} /></button></header>
        <div className="dienstleistungen-record-detail-grid">{selectedRecord.details.map((detail) => <div key={detail.label}><span>{detail.label}</span><strong>{detail.value}</strong></div>)}</div>
        <footer><span className={`dienstleistungen-status ${serviceStatusTone(selectedRecord.status)}`}>{selectedRecord.status}</span><button type="button" onClick={() => { setSelectedKey(null); onOpen(selectedRecord.kind); }}>{serviceKindLabel(selectedRecord.kind)} öffnen <ArrowRight size={18} /></button></footer>
      </article>
    </div> : null}
  </section>;
}

function ServiceRecordIcon({ kind }: { kind: ServiceSection }) {
  if (kind === "tickets") return <Ticket size={19} />;
  if (kind === "meals") return <Utensils size={19} />;
  return <CalendarDays size={19} />;
}

function serviceKindLabel(kind: ServiceSection) {
  if (kind === "tickets") return "Service-Ticket";
  if (kind === "meals") return "Mahlzeit";
  return "Buchung";
}

function serviceStatusTone(status: string) {
  if (["Abgelehnt"].includes(status)) return "danger";
  if (["Abgeschlossen", "Erledigt"].includes(status)) return "neutral";
  if (["Bestätigt", "Reserviert"].includes(status)) return "success";
  if (status === "In Bearbeitung") return "progress";
  return "open";
}

function ServiceAction({ variant, icon, title, description, onClick }: { variant: "booking" | "ticket" | "meal"; icon: React.ReactNode; title: string; description: string; onClick: () => void }) {
  return <button className={`dienstleistung-action dienstleistung-action-${variant}`} type="button" onClick={onClick}><span className="dienstleistung-action-icon">{icon}</span><strong>{title}</strong><small>{description}</small><span className="dienstleistung-action-cta">Öffnen <ArrowRight size={18} /></span></button>;
}

function WorkspaceHeading({ icon, title, description, onBack }: { icon: React.ReactNode; title: string; description: string; onBack: () => void }) {
  return <header className="dienstleistung-workspace-heading"><button type="button" onClick={onBack}><ArrowLeft size={19} /> Übersicht</button><div><span>{icon}</span><div><h3>{title}</h3><p>{description}</p></div></div></header>;
}

function ServiceChoice({ icon, title, description, onClick, accent = "default" }: { icon: React.ReactNode; title: string; description: string; onClick: () => void; accent?: "default" | "outdoor" }) {
  return <button className={`dienstleistung-choice dienstleistung-choice-${accent}`} type="button" onClick={onClick}><span>{icon}</span><div><strong>{title}</strong><small>{description}</small></div><ArrowRight size={20} /></button>;
}

function PanelHeading({ icon, title, description, onClose }: { icon: React.ReactNode; title: string; description: string; onClose: () => void }) {
  return <header className="dienstleistung-panel-heading"><div className="dienstleistung-panel-title"><span>{icon}</span><div><h3>{title}</h3><p>{description}</p></div></div><button className="icon-only" type="button" title="Schließen" onClick={onClose}><X size={21} /></button></header>;
}

function BookingList({ bookings }: { bookings: Booking[] }) {
  if (bookings.length === 0) return <p className="dienstleistung-empty">Noch keine Buchungsanfragen gespeichert.</p>;
  return <div className="dienstleistung-record-list">{bookings.slice(0, 8).map((booking) => <article key={booking.id}><span><strong>{booking.resource}</strong><small>{booking.details || "Kein konkreter Gegenstand"}</small></span><span><CalendarDays size={16} /> {formatDate(booking.date)} · {booking.from}–{booking.to}</span><em>{booking.status || "Offen"}</em></article>)}</div>;
}

function TicketList({ tickets }: { tickets: ServiceTicket[] }) {
  if (tickets.length === 0) return <p className="dienstleistung-empty">Noch keine Tickets geöffnet.</p>;
  return <div className="dienstleistung-record-list">{tickets.slice(0, 8).map((ticket) => <article key={ticket.id}><span><strong>{ticket.title}</strong><small>{ticket.category}{ticket.assignee ? ` · ${ticket.assignee}` : ""}</small></span><span><Clock3 size={16} /> {formatDateTime(ticket.createdAt)}</span><em>{ticket.status}</em></article>)}</div>;
}

function WeeklyMenu({ referenceDate }: { referenceDate: string }) {
  const date = new Date(`${referenceDate}T12:00:00`);
  const mondayOffset = (date.getDay() + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - mondayOffset);
  return <section className="weekly-menu"><div className="weekly-menu-heading"><div><h3>Speiseplan der Woche</h3><p>{formatDate(monday.toISOString().slice(0, 10))} – {formatDate(new Date(monday.getTime() + 4 * 86400000).toISOString().slice(0, 10))}</p></div><Utensils size={22} /></div><div className="weekly-menu-grid">{["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"].map((day) => <article key={day}><strong>{day}</strong><span>Noch kein Menü hinterlegt</span></article>)}</div></section>;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* local storage may be unavailable */ }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 2_000_000) {
      reject(new Error(`${file.name} ist größer als 2 MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name} konnte nicht gelesen werden.`));
    reader.readAsDataURL(file);
  });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

import {
  Armchair,
  ArrowRight,
  Building2,
  CalendarDays,
  Car,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileText,
  MapPin,
  Monitor,
  Paperclip,
  Plus,
  Send,
  Table2,
  Tent,
  Ticket,
  Utensils,
  Wrench,
  X
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";

type ServiceSection = "bookings" | "tickets" | "checkin";
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

const bookingsKey = "dmh-dienstleistungen-bookings-v1";
const ticketsKey = "dmh-dienstleistungen-tickets-v1";
const checkinsKey = "dmh-dienstleistungen-checkins-v1";

const resourceOptions: Array<{ value: BookingResource; label: string; icon: typeof Building2 }> = [
  { value: "Raum", label: "Räume", icon: Building2 },
  { value: "Auto", label: "Dienstfahrzeuge", icon: Car },
  { value: "Projektor", label: "Projektoren", icon: Monitor },
  { value: "Zelt", label: "Zelte / Pavillons", icon: Tent },
  { value: "Stühle", label: "Stühle", icon: Armchair },
  { value: "Tische", label: "Tische", icon: Table2 }
];

const today = new Date().toISOString().slice(0, 10);

export function DienstleistungenPage() {
  const [section, setSection] = useState<ServiceSection | null>(null);
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
  const [showMenu, setShowMenu] = useState(false);

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
    setMessage("");
  };

  const saveBooking = (event: FormEvent) => {
    event.preventDefault();
    const booking: Booking = { ...bookingForm, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
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
    setMessage("Der Mittagessen-Check-in wurde gespeichert.");
    setMessageType("success");
    setCheckinForm({ ...checkinForm, note: "" });
  };

  return (
    <div className="page dienstleistungen-page">
      <header className="page-header">
        <div>
          <h2>Dienstleistungen</h2>
          <p>Buchungen, Serviceanfragen und Mittagessen zentral organisieren.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="dienstleistungen-actions" aria-label="Dienstleistungsbereiche">
        <ServiceAction variant="booking" icon={<CalendarDays size={27} />} title="Buchungen" description="Räume, Autos, Projektoren, Zelte, Stühle und Tische reservieren." active={section === "bookings"} onClick={() => selectSection("bookings")} />
        <ServiceAction variant="ticket" icon={<Ticket size={27} />} title="Service anfordern" description="Tickets an IT, Hauswirtschaft oder Haustechnik senden." active={section === "tickets"} onClick={() => selectSection("tickets")} />
        <ServiceAction variant="meal" icon={<Utensils size={27} />} title="Check-in Mittagessen" description="Mittagessen für Tag, Woche oder Monat anmelden und Speiseplan ansehen." active={section === "checkin"} onClick={() => selectSection("checkin")} />
      </section>

      {!section && (
        <section className="dienstleistungen-welcome">
          <ClipboardList size={42} />
          <h3>Womit möchten Sie beginnen?</h3>
          <p>Wählen Sie oben eine Dienstleistung aus.</p>
        </section>
      )}

      {section === "bookings" && (
        <section className="dienstleistung-panel">
          <PanelHeading icon={<CalendarDays size={22} />} title="Buchungen" description="Eine Reservierungsanfrage für benötigte Ausstattung erstellen." onClose={() => setSection(null)} />
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
        </section>
      )}

      {section === "tickets" && (
        <section className="dienstleistung-panel">
          <PanelHeading icon={<Ticket size={22} />} title="Service anfordern" description="Ein Ticket mit Beschreibung, Zuständigkeit und Fotos eröffnen." onClose={() => setSection(null)} />
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

      {section === "checkin" && (
        <section className="dienstleistung-panel">
          <PanelHeading icon={<Utensils size={22} />} title="Check-in Mittagessen" description="Anmeldungen für den gewünschten Zeitraum verwalten." onClose={() => setSection(null)} />
          <div className="checkin-toolbar"><div className="checkin-view-buttons">{(["day", "week", "month"] as CheckinView[]).map((view) => <button key={view} className={checkinView === view ? "active" : ""} type="button" onClick={() => setCheckinView(view)}>{view === "day" ? "Tag" : view === "week" ? "Woche" : "Monat"}</button>)}</div><button type="button" onClick={() => setShowMenu((visible) => !visible)}><Utensils size={18} /> {showMenu ? "Speiseplan ausblenden" : "Speiseplan der Woche"}</button></div>
          <form className="dienstleistung-form checkin-form" onSubmit={saveCheckin}>
            <label className="field"><span>Datum *</span><input type="date" value={checkinForm.date} onChange={(event) => setCheckinForm({ ...checkinForm, date: event.target.value })} required /></label>
            <label className="field"><span>Personen *</span><input type="number" min="1" max="500" value={checkinForm.people} onChange={(event) => setCheckinForm({ ...checkinForm, people: event.target.value })} required /></label>
            <label className="field wide"><span>Hinweis / Ernährungswunsch</span><input value={checkinForm.note} onChange={(event) => setCheckinForm({ ...checkinForm, note: event.target.value })} placeholder="Optional" /></label>
            <div className="button-row"><button className="primary" type="submit"><CheckCircle2 size={19} /> Zum Mittagessen einchecken</button></div>
          </form>
          {showMenu && <WeeklyMenu referenceDate={checkinForm.date} />}
          <div className="checkin-list-heading"><h3>Anmeldungen</h3><span>{visibleCheckins.length} im gewählten Zeitraum</span></div>
          {visibleCheckins.length === 0 ? <p className="dienstleistung-empty">Noch keine Check-ins für diesen Zeitraum.</p> : <div className="checkin-list">{visibleCheckins.map((checkin) => <article key={checkin.id}><span><strong>{formatDate(checkin.date)}</strong><small>{checkin.people} {checkin.people === 1 ? "Person" : "Personen"}</small></span><span>{checkin.note || "Kein Hinweis"}</span></article>)}</div>}
        </section>
      )}
    </div>
  );
}

function ServiceAction({ variant, icon, title, description, active, onClick }: { variant: "booking" | "ticket" | "meal"; icon: React.ReactNode; title: string; description: string; active: boolean; onClick: () => void }) {
  return <button aria-pressed={active} className={active ? `dienstleistung-action dienstleistung-action-${variant} active` : `dienstleistung-action dienstleistung-action-${variant}`} type="button" onClick={onClick}><span className="dienstleistung-action-icon">{icon}</span><strong>{title}</strong><small>{description}</small><span className="dienstleistung-action-cta">Öffnen <ArrowRight size={18} /></span></button>;
}

function PanelHeading({ icon, title, description, onClose }: { icon: React.ReactNode; title: string; description: string; onClose: () => void }) {
  return <header className="dienstleistung-panel-heading"><div className="dienstleistung-panel-title"><span>{icon}</span><div><h3>{title}</h3><p>{description}</p></div></div><button className="icon-only" type="button" title="Schließen" onClick={onClose}><X size={21} /></button></header>;
}

function BookingList({ bookings }: { bookings: Booking[] }) {
  if (bookings.length === 0) return <p className="dienstleistung-empty">Noch keine Buchungsanfragen gespeichert.</p>;
  return <div className="dienstleistung-record-list">{bookings.slice(0, 8).map((booking) => <article key={booking.id}><span><strong>{booking.resource}</strong><small>{booking.details || "Kein konkreter Gegenstand"}</small></span><span><CalendarDays size={16} /> {formatDate(booking.date)} · {booking.from}–{booking.to}</span><em>Offen</em></article>)}</div>;
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

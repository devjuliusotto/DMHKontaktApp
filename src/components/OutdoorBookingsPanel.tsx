import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  MapPin,
  PackageOpen,
  Printer,
  Send,
  Users
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { StatusMessage } from "./StatusMessage";

type OutdoorBookingStatus = "Offen" | "Bestätigt" | "Abgelehnt" | "Abgeschlossen";
type RequirementSource = "motherhouse" | "brought" | "self";

interface RequirementSelection {
  selected: boolean;
  quantity: string;
  details: string;
  responsible: string;
  source: RequirementSource;
}

interface OutdoorBookingForm {
  eventName: string;
  people: string;
  responsible: string;
  contact: string;
  date: string;
  from: string;
  to: string;
  setupAt: string;
  dismantlingAt: string;
  location: string;
  internalContact: string;
  note: string;
  requirements: Record<RequirementId, RequirementSelection>;
}

interface OutdoorBooking extends Omit<OutdoorBookingForm, "people"> {
  id: string;
  people: number;
  status: OutdoorBookingStatus;
  createdAt: string;
}

const outdoorBookingsKey = "dmh-dienstleistungen-outdoor-bookings-v1";
const today = new Date().toISOString().slice(0, 10);

const requirementCatalog = [
  { id: "toilets", label: "Toiletten", hint: "Anzahl und Standort angeben", quantityLabel: "Anzahl" },
  { id: "electricity", label: "Strom", hint: "z. B. Kaffeemaschine, Wasserkocher, Waffeleisen oder Verstärkeranlage", quantityLabel: "Anschlüsse" },
  { id: "gas-grill", label: "Gasgrill", hint: "Gas und Zubehör in den Hinweisen ergänzen", quantityLabel: "Anzahl" },
  { id: "charcoal-grill", label: "Holzkohlegrill", hint: "Holzkohle und Zubehör ergänzen", quantityLabel: "Anzahl" },
  { id: "fire-bowl", label: "Feuerschale", hint: "Brandschutz und Brennmaterial klären", quantityLabel: "Anzahl" },
  { id: "bread-sticks", label: "Stockbrotstecken", hint: "Benötigte Stückzahl angeben", quantityLabel: "Stück" },
  { id: "tripod-grill", label: "Dreifuß-Ständer mit Pendelgitter", hint: "Aufbau und Zuständigkeit klären", quantityLabel: "Anzahl" },
  { id: "beer-benches", label: "Bierbänke", hint: "Benötigte Stückzahl angeben", quantityLabel: "Stück" },
  { id: "beer-tables", label: "Biertische", hint: "Benötigte Stückzahl angeben", quantityLabel: "Stück" },
  { id: "waste", label: "Müll", hint: "Eimer, Säcke und Entsorgung", quantityLabel: "Sets" },
  { id: "barrier-parking", label: "Absperrung / Parkplatz", hint: "Bereich und Beschilderung beschreiben", quantityLabel: "Anzahl" },
  { id: "catering-indoor", label: "Verpflegung indoor", hint: "Selbst organisiert oder vom Mutterhaus", quantityLabel: "Personen" },
  { id: "catering-outdoor", label: "Verpflegung outdoor", hint: "Selbst organisiert oder vom Mutterhaus", quantityLabel: "Personen" }
] as const;

type RequirementId = typeof requirementCatalog[number]["id"];

function createRequirements(): Record<RequirementId, RequirementSelection> {
  return Object.fromEntries(requirementCatalog.map((item) => [item.id, {
    selected: false,
    quantity: "",
    details: "",
    responsible: "",
    source: "motherhouse" as RequirementSource
  }])) as Record<RequirementId, RequirementSelection>;
}

function createForm(): OutdoorBookingForm {
  return {
    eventName: "",
    people: "",
    responsible: "",
    contact: "",
    date: today,
    from: "09:00",
    to: "17:00",
    setupAt: "",
    dismantlingAt: "",
    location: "",
    internalContact: "",
    note: "",
    requirements: createRequirements()
  };
}

export function OutdoorBookingsPanel() {
  const [bookings, setBookings] = useState<OutdoorBooking[]>(() => readStoredBookings());
  const [form, setForm] = useState<OutdoorBookingForm>(() => createForm());
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const selectedRequirements = useMemo(
    () => requirementCatalog.filter((item) => form.requirements[item.id].selected),
    [form.requirements]
  );

  const conflicts = useMemo(() => findConflicts(form, bookings), [form, bookings]);
  const upcomingCount = useMemo(
    () => bookings.filter((booking) => booking.date >= today && booking.status !== "Abgelehnt" && booking.status !== "Abgeschlossen").length,
    [bookings]
  );

  const updateRequirement = (id: RequirementId, patch: Partial<RequirementSelection>) => {
    setForm((current) => ({
      ...current,
      requirements: {
        ...current.requirements,
        [id]: { ...current.requirements[id], ...patch }
      }
    }));
  };

  const saveBooking = (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    if (form.to <= form.from) {
      setMessageType("error");
      setMessage("Die Endzeit muss nach der Startzeit liegen.");
      return;
    }
    if (selectedRequirements.length === 0) {
      setMessageType("error");
      setMessage("Wählen Sie mindestens einen Bedarf oder ein Gerät aus.");
      return;
    }
    if (conflicts.length > 0 && !window.confirm(`${conflicts.length} parallele Anfrage(n) verwenden mindestens dasselbe Material. Trotzdem als offene Anfrage speichern?`)) {
      return;
    }
    const booking: OutdoorBooking = {
      ...form,
      id: `OUT-${Date.now()}`,
      people: Math.max(1, Number(form.people) || 1),
      status: "Offen",
      createdAt: new Date().toISOString()
    };
    const next = [booking, ...bookings];
    persistBookings(next);
    setBookings(next);
    setForm(createForm());
    setMessageType("success");
    setMessage(`Anfrage ${booking.id} wurde gespeichert.`);
  };

  const updateStatus = (id: string, status: OutdoorBookingStatus) => {
    const next = bookings.map((booking) => booking.id === id ? { ...booking, status } : booking);
    persistBookings(next);
    setBookings(next);
    setMessageType("success");
    setMessage(`Status von ${id} wurde auf „${status}“ gesetzt.`);
  };

  return (
    <div className="outdoor-bookings">
      <StatusMessage message={message} type={messageType} />

      <div className="outdoor-overview" aria-label="Übersicht Outdoor-Buchungen">
        <article><CalendarDays size={21} /><span><strong>{upcomingCount}</strong><small>bevorstehende Anfragen</small></span></article>
        <article><PackageOpen size={21} /><span><strong>{selectedRequirements.length}</strong><small>Bedarfe ausgewählt</small></span></article>
        <article className={conflicts.length > 0 ? "warning" : ""}><AlertTriangle size={21} /><span><strong>{conflicts.length}</strong><small>mögliche Überschneidungen</small></span></article>
      </div>

      <form className="outdoor-booking-form" onSubmit={saveBooking}>
        <fieldset>
          <legend>1. Veranstaltung</legend>
          <div className="dienstleistung-form outdoor-event-fields">
            <label className="field wide"><span>Veranstaltung *</span><input value={form.eventName} onChange={(event) => setForm({ ...form, eventName: event.target.value })} required placeholder="Name der Veranstaltung" /></label>
            <label className="field"><span>Personenzahl *</span><input type="number" min="1" max="5000" value={form.people} onChange={(event) => setForm({ ...form, people: event.target.value })} required /></label>
            <label className="field"><span>Verantwortliche Person *</span><input value={form.responsible} onChange={(event) => setForm({ ...form, responsible: event.target.value })} required placeholder="Name" /></label>
            <label className="field"><span>Kontaktdaten *</span><input value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} required placeholder="Telefon oder E-Mail" /></label>
            <label className="field"><span>Ort auf dem Gelände *</span><input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} required placeholder="z. B. Innenhof" /></label>
            <label className="field"><span>Ansprechperson im MH</span><input value={form.internalContact} onChange={(event) => setForm({ ...form, internalContact: event.target.value })} placeholder="Name oder Team" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>2. Termin und Übergabe</legend>
          <div className="dienstleistung-form outdoor-time-fields">
            <label className="field"><span>Termin *</span><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></label>
            <label className="field"><span>Uhrzeit von *</span><input type="time" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} required /></label>
            <label className="field"><span>Bis *</span><input type="time" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} required /></label>
            <label className="field"><span>Aufbau</span><input type="datetime-local" value={form.setupAt} onChange={(event) => setForm({ ...form, setupAt: event.target.value })} /></label>
            <label className="field"><span>Abbau</span><input type="datetime-local" value={form.dismantlingAt} onChange={(event) => setForm({ ...form, dismantlingAt: event.target.value })} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>3. Bedarf vom Mutterhaus</legend>
          <p className="outdoor-section-hint">Zuerst auswählen, danach Menge, Herkunft und Zuständigkeit ergänzen.</p>
          <div className="outdoor-requirement-grid">
            {requirementCatalog.map((item) => {
              const selection = form.requirements[item.id];
              return (
                <article className={selection.selected ? "selected" : ""} key={item.id}>
                  <label className="outdoor-requirement-toggle">
                    <input type="checkbox" checked={selection.selected} onChange={(event) => updateRequirement(item.id, { selected: event.target.checked })} />
                    <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                  </label>
                  {selection.selected ? <div className="outdoor-requirement-details">
                    <label><span>{item.quantityLabel}</span><input type="number" min="0" value={selection.quantity} onChange={(event) => updateRequirement(item.id, { quantity: event.target.value })} placeholder="Optional" /></label>
                    <label><span>Herkunft</span><select value={selection.source} onChange={(event) => updateRequirement(item.id, { source: event.target.value as RequirementSource })}><option value="motherhouse">Vom Mutterhaus</option><option value="brought">Wird mitgebracht</option><option value="self">Selbst organisiert</option></select></label>
                    <label><span>Zuständig</span><input value={selection.responsible} onChange={(event) => updateRequirement(item.id, { responsible: event.target.value })} placeholder="Name / Team" /></label>
                    <label className="wide"><span>Details</span><input value={selection.details} onChange={(event) => updateRequirement(item.id, { details: event.target.value })} placeholder="Optionaler Hinweis" /></label>
                  </div> : null}
                </article>
              );
            })}
          </div>
        </fieldset>

        {conflicts.length > 0 ? <div className="outdoor-conflict-warning" role="alert"><AlertTriangle size={21} /><div><strong>Mögliche Doppelbelegung</strong><span>{conflicts.map((conflict) => `${conflict.id}: ${conflict.materials.join(", ")}`).join(" · ")}</span></div></div> : null}

        <label className="field"><span>Weitere Hinweise</span><textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Besondere Anforderungen, Übergabe oder Sicherheitsinformationen" /></label>
        <div className="button-row"><button className="primary" type="submit"><Send size={19} /> Outdoor-/Geräteanfrage speichern</button></div>
      </form>

      <div className="outdoor-list-heading"><div><h3>Gespeicherte Anfragen</h3><span>{bookings.length} insgesamt</span></div><button type="button" onClick={() => window.print()}><Printer size={18} /> Drucken</button></div>
      {bookings.length === 0 ? <p className="dienstleistung-empty">Noch keine Outdoor- oder Geräteanfrage gespeichert.</p> : <div className="outdoor-booking-list">
        {bookings.map((booking) => <OutdoorBookingCard key={booking.id} booking={booking} onStatusChange={updateStatus} />)}
      </div>}
    </div>
  );
}

function OutdoorBookingCard({ booking, onStatusChange }: { booking: OutdoorBooking; onStatusChange: (id: string, status: OutdoorBookingStatus) => void }) {
  const requested = requirementCatalog.filter((item) => booking.requirements[item.id]?.selected);
  return <article className="outdoor-booking-card">
    <div className="outdoor-booking-summary">
      <span className="outdoor-booking-icon"><PackageOpen size={21} /></span>
      <span><strong>{booking.eventName}</strong><small>{booking.id} · {booking.responsible}</small></span>
      <span><CalendarDays size={16} /> {formatDate(booking.date)} · {booking.from}–{booking.to}</span>
      <label><span className="sr-only">Status</span><select value={booking.status} onChange={(event) => onStatusChange(booking.id, event.target.value as OutdoorBookingStatus)}><option>Offen</option><option>Bestätigt</option><option>Abgelehnt</option><option>Abgeschlossen</option></select></label>
    </div>
    <details>
      <summary>Checkliste und Details anzeigen</summary>
      <div className="outdoor-booking-meta">
        <span><Users size={16} /> {booking.people} Personen</span>
        <span><MapPin size={16} /> {booking.location}</span>
        <span><Clock3 size={16} /> Aufbau: {booking.setupAt ? formatDateTimeInput(booking.setupAt) : "nicht angegeben"}</span>
        <span><Clock3 size={16} /> Abbau: {booking.dismantlingAt ? formatDateTimeInput(booking.dismantlingAt) : "nicht angegeben"}</span>
      </div>
      <div className="outdoor-booking-requirements">
        {requested.map((item) => {
          const selection = booking.requirements[item.id];
          return <span key={item.id}><CheckCircle2 size={16} /><b>{item.label}</b>{selection.quantity ? ` · ${selection.quantity}` : ""} · {sourceLabel(selection.source)}{selection.responsible ? ` · ${selection.responsible}` : ""}{selection.details ? ` · ${selection.details}` : ""}</span>;
        })}
      </div>
      <p><strong>Kontakt:</strong> {booking.contact}{booking.internalContact ? ` · MH: ${booking.internalContact}` : ""}</p>
      {booking.note ? <p><strong>Hinweise:</strong> {booking.note}</p> : null}
    </details>
  </article>;
}

function findConflicts(form: OutdoorBookingForm, bookings: OutdoorBooking[]) {
  if (!form.date || !form.from || !form.to) return [];
  const requestedIds = new Set(requirementCatalog.filter((item) => {
    const selection = form.requirements[item.id];
    return selection.selected && selection.source === "motherhouse";
  }).map((item) => item.id));
  if (requestedIds.size === 0) return [];
  return bookings.flatMap((booking) => {
    if (booking.date !== form.date || booking.status === "Abgelehnt" || booking.status === "Abgeschlossen" || form.to <= booking.from || form.from >= booking.to) return [];
    const materials = requirementCatalog.filter((item) => requestedIds.has(item.id) && booking.requirements[item.id]?.selected && booking.requirements[item.id]?.source === "motherhouse").map((item) => item.label);
    return materials.length > 0 ? [{ id: booking.id, materials }] : [];
  });
}

function readStoredBookings(): OutdoorBooking[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(outdoorBookingsKey) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistBookings(bookings: OutdoorBooking[]) {
  localStorage.setItem(outdoorBookingsKey, JSON.stringify(bookings));
}

function sourceLabel(source: RequirementSource) {
  if (source === "brought") return "wird mitgebracht";
  if (source === "self") return "selbst organisiert";
  return "vom Mutterhaus";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatDateTimeInput(value: string) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

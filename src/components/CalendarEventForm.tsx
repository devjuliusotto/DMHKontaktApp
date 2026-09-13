import {
  AlignLeft, Bell, CalendarClock, Clock3, ExternalLink, Eye, Link2, Lock,
  MapPin, Printer, Repeat2, Save, Tag, Trash2, UserPlus, Users, Video, X
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type {
  CalendarAvailability, CalendarEvent, CalendarMeetingOptions, CalendarRecurrence,
  CalendarRecurrenceFrequency
} from "../types/calendar";
import { calendarColorOptions, calendarColorValue, parseCalendarDate } from "../utils/calendar";

interface CalendarEventFormProps {
  value: CalendarEvent;
  isNew: boolean;
  categories: Array<{ name: string; color: string }>;
  events: CalendarEvent[];
  onChange: (value: CalendarEvent) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

const defaultMeeting: CalendarMeetingOptions = {
  requiredAttendees: [], optionalAttendees: [], showAs: "busy", reminderMinutes: 15,
  isPrivate: false, isOnlineMeeting: false, onlineMeetingUrl: ""
};

const availabilityLabels: Record<CalendarAvailability, string> = {
  free: "Frei", tentative: "Mit Vorbehalt", busy: "Beschäftigt",
  oof: "Abwesend", workingElsewhere: "An anderem Ort"
};

function attendeeValues(raw: string): string[] {
  return raw.split(/[;,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function timeParts(value: string) {
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

function dateTimeValue(date: string, time: string) {
  return `${date}T${time || "00:00"}`;
}

function eventMinutes(value: string): number {
  const date = parseCalendarDate(value);
  return date ? date.getHours() * 60 + date.getMinutes() : 0;
}

function eventDurationMinutes(event: CalendarEvent): number {
  const start = parseCalendarDate(event.startsAt);
  const end = parseCalendarDate(event.endsAt);
  return start && end ? Math.max(15, (end.getTime() - start.getTime()) / 60_000) : 60;
}

export function CalendarEventForm({ value, isNew, categories, events, onChange, onSave, onDelete, onCancel }: CalendarEventFormProps) {
  const [optionalVisible, setOptionalVisible] = useState((value.meeting?.optionalAttendees.length ?? 0) > 0);
  const [plannerVisible, setPlannerVisible] = useState(true);
  const [requiredAttendeesText, setRequiredAttendeesText] = useState((value.meeting?.requiredAttendees ?? []).join("; "));
  const [optionalAttendeesText, setOptionalAttendeesText] = useState((value.meeting?.optionalAttendees ?? []).join("; "));
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const update = <Key extends keyof CalendarEvent>(key: Key, fieldValue: CalendarEvent[Key]) => onChange({ ...value, [key]: fieldValue });
  const meeting = { ...defaultMeeting, ...value.meeting };
  const updateMeeting = (changes: Partial<CalendarMeetingOptions>) => update("meeting", { ...meeting, ...changes });
  const categoryNames = categories.map((category) => category.name);
  const recurrence = value.recurrence ?? null;
  const recurrencePreset = !recurrence ? "none" : recurrence.frequency === "monthly" && recurrence.interval === 6 ? "semiannual" : recurrence.frequency;
  const starts = timeParts(value.startsAt);
  const ends = timeParts(value.endsAt);
  const validRange = Boolean(value.startsAt && value.endsAt && new Date(value.endsAt).getTime() > new Date(value.startsAt).getTime());

  const startDate = () => {
    const date = new Date(value.startsAt);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  };

  const setRecurrencePreset = (preset: string) => {
    if (preset === "none") { update("recurrence", null); return; }
    const start = startDate();
    const frequency: CalendarRecurrenceFrequency = preset === "semiannual" ? "monthly" : preset as CalendarRecurrenceFrequency;
    const next: CalendarRecurrence = { frequency, interval: preset === "semiannual" ? 6 : 1 };
    if (frequency === "weekly") next.daysOfWeek = [start.getDay()];
    if (frequency === "monthly") next.dayOfMonth = start.getDate();
    if (frequency === "yearly") { next.dayOfMonth = start.getDate(); next.monthOfYear = start.getMonth() + 1; }
    update("recurrence", next);
  };

  const updateRecurrence = (changes: Partial<CalendarRecurrence>) => {
    if (recurrence) update("recurrence", { ...recurrence, ...changes });
  };

  const toggleRecurrenceWeekday = (weekday: number) => {
    if (!recurrence) return;
    const current = new Set(recurrence.daysOfWeek ?? [startDate().getDay()]);
    if (current.has(weekday) && current.size > 1) current.delete(weekday); else current.add(weekday);
    updateRecurrence({ daysOfWeek: Array.from(current).sort() });
  };

  const updateCategory = (categoryName: string) => {
    const category = categories.find((entry) => entry.name === categoryName);
    onChange({ ...value, category: categoryName, color: category?.color ?? value.color });
  };

  const updateStart = (nextStart: string) => {
    const oldStart = parseCalendarDate(value.startsAt);
    const oldEnd = parseCalendarDate(value.endsAt);
    const nextDate = parseCalendarDate(nextStart);
    if (!oldStart || !oldEnd || !nextDate) { update("startsAt", nextStart); return; }
    const nextEnd = new Date(nextDate.getTime() + Math.max(15 * 60_000, oldEnd.getTime() - oldStart.getTime()));
    const localEnd = new Date(nextEnd.getTime() - nextEnd.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    onChange({ ...value, startsAt: nextStart, endsAt: localEnd });
  };

  const plannerEvents = useMemo(() => events
    .filter((event) => event.id !== value.id && event.startsAt.slice(0, 10) === starts.date)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt)), [events, starts.date, value.id]);

  const addAgenda = () => {
    if (!value.description.trim()) update("description", "Agenda\n• ");
    window.setTimeout(() => descriptionRef.current?.focus(), 0);
  };

  return (
    <section className="calendar-meeting-editor">
      <header className="calendar-meeting-titlebar">
        <div><span>{isNew ? "Neues Ereignis" : "Ereignis bearbeiten"}</span><strong>{isNew ? "Neue Besprechung" : value.title || "Besprechung"}</strong></div>
        <button type="button" onClick={onCancel} aria-label="Schließen"><X size={21} /></button>
      </header>

      <div className="calendar-meeting-commandbar">
        <div className="calendar-meeting-tabs" role="tablist" aria-label="Ereignistyp">
          <button className={!recurrence ? "active" : ""} type="button" role="tab" aria-selected={!recurrence} onClick={() => setRecurrencePreset("none")}><CalendarClock size={17} /> Ereignis</button>
          <button className={recurrence ? "active" : ""} type="button" role="tab" aria-selected={Boolean(recurrence)} onClick={() => setRecurrencePreset(recurrencePreset === "none" ? "weekly" : recurrencePreset)}><Repeat2 size={17} /> Serie</button>
        </div>
        <label className="calendar-command-select"><Eye size={16} /><select aria-label="Anzeigen als" value={meeting.showAs} onChange={(event) => updateMeeting({ showAs: event.target.value as CalendarAvailability })}>{Object.entries(availabilityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="calendar-command-select"><Bell size={16} /><select aria-label="Erinnerung" value={meeting.reminderMinutes ?? "none"} onChange={(event) => updateMeeting({ reminderMinutes: event.target.value === "none" ? null : Number(event.target.value) })}><option value="none">Keine Erinnerung</option><option value="0">Zum Start</option><option value="5">5 Minuten vorher</option><option value="15">15 Minuten vorher</option><option value="30">30 Minuten vorher</option><option value="60">1 Stunde vorher</option><option value="1440">1 Tag vorher</option></select></label>
        <label className="calendar-command-select"><Tag size={16} /><select aria-label="Kategorie" value={value.category} onChange={(event) => updateCategory(event.target.value)}><option value="">Keine Kategorie</option>{value.category && !categoryNames.includes(value.category) && <option value={value.category}>{value.category}</option>}{categories.map((category) => <option value={category.name} key={category.name}>{category.name}</option>)}</select></label>
        <button className={meeting.isPrivate ? "calendar-command-toggle active" : "calendar-command-toggle"} type="button" aria-pressed={meeting.isPrivate} onClick={() => updateMeeting({ isPrivate: !meeting.isPrivate })}><Lock size={16} /> Privat</button>
        <button className="calendar-command-icon" type="button" onClick={() => window.print()} aria-label="Drucken" title="Drucken"><Printer size={17} /></button>
        {!isNew && <button className="calendar-command-icon danger" type="button" onClick={onDelete} aria-label="Termin löschen" title="Termin löschen"><Trash2 size={17} /></button>}
        <button className="primary calendar-meeting-save" type="button" onClick={onSave} disabled={!value.title.trim() || !value.startsAt || !validRange}><Save size={17} /> Speichern</button>
      </div>

      <div className={plannerVisible ? "calendar-meeting-layout" : "calendar-meeting-layout planner-hidden"}>
        <main className="calendar-meeting-fields">
          <div className="calendar-meeting-field title-field"><CalendarClock size={20} /><input value={value.title} onChange={(event) => update("title", event.target.value)} placeholder="Titel hinzufügen" autoFocus /></div>
          <div className="calendar-meeting-field attendee-field"><Users size={20} /><input value={requiredAttendeesText} onChange={(event) => { setRequiredAttendeesText(event.target.value); updateMeeting({ requiredAttendees: attendeeValues(event.target.value) }); }} placeholder="Erforderliche Teilnehmer einladen" /><button type="button" onClick={() => setOptionalVisible((visible) => !visible)}>{optionalVisible ? "Optional ausblenden" : "+ Optional"}</button></div>
          {optionalVisible && <div className="calendar-meeting-field attendee-field optional"><UserPlus size={20} /><input value={optionalAttendeesText} onChange={(event) => { setOptionalAttendeesText(event.target.value); updateMeeting({ optionalAttendees: attendeeValues(event.target.value) }); }} placeholder="Optionale Teilnehmer einladen" /></div>}
          <div className="calendar-meeting-field calendar-date-field"><Clock3 size={20} /><div className="calendar-date-controls"><input aria-label="Startdatum" type="date" value={starts.date} onChange={(event) => updateStart(dateTimeValue(event.target.value, starts.time))} /><input aria-label="Startzeit" type="time" value={starts.time} onChange={(event) => updateStart(dateTimeValue(starts.date, event.target.value))} /><span>bis</span><input aria-label="Enddatum" type="date" value={ends.date} onChange={(event) => update("endsAt", dateTimeValue(event.target.value, ends.time))} /><input aria-label="Endzeit" type="time" value={ends.time} onChange={(event) => update("endsAt", dateTimeValue(ends.date, event.target.value))} /></div><button className={plannerVisible ? "active" : ""} type="button" onClick={() => setPlannerVisible((visible) => !visible)}><CalendarClock size={16} /> Planer</button></div>
          {!validRange && <p className="calendar-meeting-validation">Das Ende muss nach dem Beginn liegen.</p>}
          <div className="calendar-meeting-field"><MapPin size={20} /><input value={value.location} onChange={(event) => update("location", event.target.value)} placeholder="Raum oder Ort hinzufügen" /></div>
          <div className="calendar-meeting-field online-field"><Video size={20} /><label className="switch"><input id={`online-meeting-${value.id}`} type="checkbox" checked={meeting.isOnlineMeeting} onChange={(event) => updateMeeting({ isOnlineMeeting: event.target.checked })} /><span /></label><span className="online-meeting-copy"><label className="online-meeting-label" htmlFor={`online-meeting-${value.id}`}>Teams-Besprechung</label>{meeting.isOnlineMeeting && !meeting.onlineMeetingUrl && <small>Der Link wird bei der Microsoft-365-Synchronisierung erstellt.</small>}</span>{meeting.onlineMeetingUrl && <a href={meeting.onlineMeetingUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Beitreten</a>}</div>

          {recurrence && <section className="calendar-recurrence-panel" aria-label="Serieneinstellungen">
            <label><span>Wiederholung</span><select value={recurrencePreset} onChange={(event) => setRecurrencePreset(event.target.value)}><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option><option value="monthly">Monatlich</option><option value="semiannual">Halbjährlich</option><option value="yearly">Jährlich</option></select></label>
            <label><span>Intervall</span><span className="recurrence-interval-field"><span>Alle</span><input type="number" min={1} max={365} value={recurrence.interval} onChange={(event) => updateRecurrence({ interval: Math.max(1, Number(event.target.value) || 1) })} /><span>{recurrence.frequency === "daily" ? "Tag(e)" : recurrence.frequency === "weekly" ? "Woche(n)" : recurrence.frequency === "monthly" ? "Monat(e)" : "Jahr(e)"}</span></span></label>
            {recurrence.frequency === "weekly" && <div className="field wide"><span>Wochentage</span><div className="recurrence-weekdays">{["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].map((label, weekday) => <button className={(recurrence.daysOfWeek ?? [startDate().getDay()]).includes(weekday) ? "active" : ""} type="button" onClick={() => toggleRecurrenceWeekday(weekday)} key={label}>{label}</button>)}</div></div>}
            <label><span>Serienende</span><select value={recurrence.count ? "count" : recurrence.until ? "until" : "never"} onChange={(event) => { if (event.target.value === "count") updateRecurrence({ count: 10, until: undefined }); else if (event.target.value === "until") updateRecurrence({ until: value.startsAt.slice(0, 4) + "-12-31", count: undefined }); else updateRecurrence({ count: undefined, until: undefined }); }}><option value="never">Kein Enddatum</option><option value="until">Endet am</option><option value="count">Nach Anzahl</option></select></label>
            {recurrence.until && <label><span>Letzter Termin</span><input type="date" value={recurrence.until} onChange={(event) => updateRecurrence({ until: event.target.value })} /></label>}
            {recurrence.count && <label><span>Anzahl Termine</span><input type="number" min={1} max={10000} value={recurrence.count} onChange={(event) => updateRecurrence({ count: Math.max(1, Number(event.target.value) || 1) })} /></label>}
          </section>}

          <div className="calendar-description-editor"><AlignLeft size={20} /><textarea ref={descriptionRef} value={value.description} onChange={(event) => update("description", event.target.value)} placeholder="Details zur Besprechung hinzufügen" /></div>
          <button className="calendar-add-agenda" type="button" onClick={addAgenda}><Link2 size={17} /> Eine Agenda hinzufügen</button>
          <div className="calendar-color-row"><Tag size={17} /><label>Farbe <select value={calendarColorValue(value.color)} onChange={(event) => update("color", event.target.value)}>{calendarColorOptions.map((color) => <option value={color.value} key={color.value}>{color.label}</option>)}</select></label></div>
        </main>

        {plannerVisible && <aside className="calendar-meeting-planner" aria-label="Tagesübersicht">
          <header><CalendarClock size={18} /><div><strong>{starts.date ? new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${starts.date}T12:00`)) : "Tagesübersicht"}</strong><span>{plannerEvents.length ? `${plannerEvents.length} weitere Termine` : "Keine weiteren Termine"}</span></div></header>
          <div className="calendar-planner-timeline">
            {Array.from({ length: 18 }, (_, index) => index + 6).map((hour) => <div className="calendar-planner-hour" key={hour}><time>{hour}</time></div>)}
            {plannerEvents.map((event) => { const start = eventMinutes(event.startsAt); const duration = eventDurationMinutes(event); return <div className="calendar-planner-event" key={event.id} style={{ top: `${((start - 360) / 60) * 44}px`, height: `${Math.max(24, duration / 60 * 44)}px` }}><strong>{event.title}</strong><span>{timeParts(event.startsAt).time}–{timeParts(event.endsAt).time}</span></div>; })}
            <div className="calendar-planner-event draft" style={{ top: `${((eventMinutes(value.startsAt) - 360) / 60) * 44}px`, height: `${Math.max(24, eventDurationMinutes(value) / 60 * 44)}px` }}><strong>{value.title || "Neue Besprechung"}</strong><span>{starts.time}–{ends.time}</span></div>
          </div>
        </aside>}
      </div>
    </section>
  );
}

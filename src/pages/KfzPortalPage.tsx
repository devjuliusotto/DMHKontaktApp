import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Building2, CalendarClock, CarFront, CheckCircle2, ChevronRight, CircleAlert,
  CloudOff, Database, FileBarChart, FileText, Gauge, LayoutDashboard, LoaderCircle, MapPin,
  RefreshCw, Search, Settings, ShieldCheck, Truck, Wrench, X
} from "lucide-react";
import { PortalGlobalHeader } from "../components/PortalGlobalHeader";
import { getKfzSnapshot, syncKfzData } from "../services/db";
import type { ExchangeSyncStatus, PortalSession } from "../types/m365";
import type { KfzDocument, KfzMaintenance, KfzSnapshot, KfzVehicle } from "../types/kfz";

type KfzTab = "overview" | "vehicles" | "maintenance" | "board" | "locations" | "documents" | "reports" | "settings";

interface KfzPortalPageProps {
  session: PortalSession;
  exchangeSyncStatus: ExchangeSyncStatus;
  offline: boolean;
  onBack: () => void;
  onSignOut: () => Promise<void>;
  onSyncExchange: () => Promise<void>;
}

const tabs: Array<{ id: KfzTab; title: string; icon: typeof Settings }> = [
  { id: "overview", title: "Übersicht", icon: LayoutDashboard },
  { id: "vehicles", title: "Fahrzeuge", icon: CarFront },
  { id: "maintenance", title: "Wartungen", icon: Wrench },
  { id: "board", title: "Wartungsboard", icon: CalendarClock },
  { id: "locations", title: "Standorte", icon: MapPin },
  { id: "documents", title: "Dokumente", icon: FileText },
  { id: "reports", title: "Auswertungen", icon: FileBarChart },
  { id: "settings", title: "Einstellungen", icon: Settings }
];

const emptySnapshot: KfzSnapshot = { vehicles: [], maintenance: [], locations: [], documents: [], lastSyncedAt: null, cacheReady: false };
const statuses = ["Posteingang", "Geplant", "In Arbeit", "Wartet auf Teile", "Erledigt", "Storniert"];

const previewSnapshot: KfzSnapshot = {
  cacheReady: true,
  lastSyncedAt: new Date().toISOString(),
  locations: [
    { id: "1", etag: "", name: "Aidlingen", aktiv: true, code: "AID", adresse: "Darmsheimer Steige 1, 71134 Aidlingen", legacyEinsatzortId: 1, modifiedAt: null },
    { id: "2", etag: "", name: "Stuttgart", aktiv: true, code: "STR", adresse: "Stuttgart", legacyEinsatzortId: 2, modifiedAt: null },
    { id: "3", etag: "", name: "Außenstelle", aktiv: true, code: "AST", adresse: "", legacyEinsatzortId: 3, modifiedAt: null }
  ],
  vehicles: [
    { id: "11", etag: "", kennzeichen: "BB-DM 101", spitzname: "Hausmeisterbus", farbe: "Weiß", aktiv: true, fahrzeugtyp: "Transporter", hersteller: "Mercedes-Benz", lackcode: "", vin: "WDB000000001", erstzulassung: "2019-03-14", baujahr: 2019, motorkennbuchstabe: "", hubraumCcm: 2143, leistungKw: 120, kilometerstand: 84210, standortId: "1", standortLabel: "Aidlingen", legacyStandortText: "", legacyVerantwortliche: "Technischer Dienst", tankkarte: true, versicherung: "", oeltyp: "5W-30", naechsterTuev: dateOffset(24), naechsteAu: dateOffset(24), naechsteInspektion: dateOffset(-5), naechsteInspektionKm: 85000, naechsterSommercheck: dateOffset(90), naechsterWintercheck: dateOffset(210), kaufdatum: "2019-03-01", verkaufsdatum: null, legacyKennzeichen: "BB-DM 101", legacyImportId: "KFZ-101", modifiedAt: new Date().toISOString() },
    { id: "12", etag: "", kennzeichen: "BB-DM 204", spitzname: "Küche", farbe: "Silber", aktiv: true, fahrzeugtyp: "Kombi", hersteller: "Volkswagen", lackcode: "", vin: "WVW000000002", erstzulassung: "2021-06-10", baujahr: 2021, motorkennbuchstabe: "", hubraumCcm: 1968, leistungKw: 110, kilometerstand: 48900, standortId: "1", standortLabel: "Aidlingen", legacyStandortText: "", legacyVerantwortliche: "Großküche", tankkarte: true, versicherung: "", oeltyp: "0W-30", naechsterTuev: dateOffset(120), naechsteAu: dateOffset(120), naechsteInspektion: dateOffset(35), naechsteInspektionKm: 52000, naechsterSommercheck: dateOffset(75), naechsterWintercheck: dateOffset(190), kaufdatum: "2021-05-20", verkaufsdatum: null, legacyKennzeichen: "BB-DM 204", legacyImportId: "KFZ-204", modifiedAt: new Date().toISOString() },
    { id: "13", etag: "", kennzeichen: "BB-DM 317", spitzname: "Gärtnerei", farbe: "Grün", aktiv: true, fahrzeugtyp: "Pritsche", hersteller: "Ford", lackcode: "", vin: "WF0000000003", erstzulassung: "2017-04-05", baujahr: 2017, motorkennbuchstabe: "", hubraumCcm: 1995, leistungKw: 96, kilometerstand: 126400, standortId: "3", standortLabel: "Außenstelle", legacyStandortText: "", legacyVerantwortliche: "Gärtnerei", tankkarte: true, versicherung: "", oeltyp: "5W-30", naechsterTuev: dateOffset(-12), naechsteAu: dateOffset(-12), naechsteInspektion: dateOffset(80), naechsteInspektionKm: 130000, naechsterSommercheck: dateOffset(60), naechsterWintercheck: dateOffset(180), kaufdatum: "2017-03-15", verkaufsdatum: null, legacyKennzeichen: "BB-DM 317", legacyImportId: "KFZ-317", modifiedAt: new Date().toISOString() },
    { id: "14", etag: "", kennzeichen: "BB-DM 88", spitzname: "Verwaltung", farbe: "Blau", aktiv: true, fahrzeugtyp: "PKW", hersteller: "Škoda", lackcode: "", vin: "TMB000000004", erstzulassung: "2023-01-17", baujahr: 2023, motorkennbuchstabe: "", hubraumCcm: 1498, leistungKw: 110, kilometerstand: 23800, standortId: "2", standortLabel: "Stuttgart", legacyStandortText: "", legacyVerantwortliche: "Verwaltung", tankkarte: false, versicherung: "", oeltyp: "0W-20", naechsterTuev: dateOffset(250), naechsteAu: dateOffset(250), naechsteInspektion: dateOffset(140), naechsteInspektionKm: 30000, naechsterSommercheck: dateOffset(70), naechsterWintercheck: dateOffset(195), kaufdatum: "2023-01-10", verkaufsdatum: null, legacyKennzeichen: "BB-DM 88", legacyImportId: "KFZ-88", modifiedAt: new Date().toISOString() }
  ],
  maintenance: [
    maintenance("21", "Inspektion BB-DM 101", "11", "BB-DM 101", -5, "Inspektion", "Geplant", 85000, 780),
    maintenance("22", "TÜV / AU BB-DM 317", "13", "BB-DM 317", -12, "TÜV", "Posteingang", 126400, 0),
    maintenance("23", "Reifenwechsel BB-DM 204", "12", "BB-DM 204", 14, "Reifen", "In Arbeit", 49000, 185),
    maintenance("24", "Bremsen prüfen BB-DM 101", "11", "BB-DM 101", 28, "Reparatur", "Wartet auf Teile", 84210, 430),
    maintenance("25", "Jahresinspektion BB-DM 88", "14", "BB-DM 88", 45, "Inspektion", "Geplant", 25000, 320),
    maintenance("26", "Ölwechsel BB-DM 204", "12", "BB-DM 204", -40, "Inspektion", "Erledigt", 47220, 219)
  ],
  documents: [
    document("31", "Rechnung_Inspektion_BB-DM-204.pdf", "12", "26", "Rechnung", -40, 219),
    document("32", "Fahrzeugschein_BB-DM-101.pdf", "11", "", "Fahrzeugschein", -400, null),
    document("33", "TUEV_Bericht_BB-DM-317.pdf", "13", "22", "TÜV-Bericht", -730, null)
  ]
};

function dateOffset(days: number) { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); }
function maintenance(id: string, title: string, fahrzeugId: string, fahrzeugLabel: string, days: number, kategorie: string, status: string, km: number, kosten: number): KfzMaintenance {
  return { id, etag: "", title, fahrzeugId, fahrzeugLabel, legacyKennzeichen: fahrzeugLabel, datum: dateOffset(days), kilometerstand: km, kategorie, beschreibung: "", arbeiten: "", status, werkstatt: "", kosten, naechsterTermin: null, naechsterKilometerstand: null, legacyWartungsId: Number(id), modifiedAt: new Date().toISOString() };
}
function document(id: string, fileName: string, fahrzeugId: string, wartungId: string, dokumenttyp: string, days: number, betrag: number | null): KfzDocument {
  return { id, driveItemId: id, fileName, webUrl: "", fahrzeugId, wartungId, legacyKennzeichen: "", dokumenttyp, dokumentdatum: dateOffset(days), beschreibung: "", betrag, aktiv: true, uploadedBy: "DMH Portal", uploadedAt: dateOffset(days), modifiedAt: dateOffset(days) };
}

function isBrowserPreview() { return !("__TAURI_INTERNALS__" in window); }
function formatDate(value?: string | null) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("de-DE"); }
function formatMoney(value?: number | null) { return value == null ? "—" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value); }
function dueState(value?: string | null) { if (!value) return "none"; const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86400000); return days < 0 ? "overdue" : days <= 30 ? "soon" : "ok"; }
function vehicleLabel(snapshot: KfzSnapshot, id: string, fallback = "") { return snapshot.vehicles.find((vehicle) => vehicle.id === id)?.kennzeichen || fallback || "Ohne Fahrzeug"; }

export function KfzPortalPage(props: KfzPortalPageProps) {
  const [tab, setTab] = useState<KfzTab>("overview");
  const [snapshot, setSnapshot] = useState<KfzSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [selectedVehicle, setSelectedVehicle] = useState<KfzVehicle | null>(null);

  const synchronize = useCallback(async (forceFull = false) => {
    if (isBrowserPreview()) { setNotice("Vorschau aktualisiert – im installierten Portal kommen diese Daten aus Microsoft 365."); return; }
    if (props.offline) { setNotice("Offline: Der zuletzt gespeicherte Fuhrparkstand bleibt verfügbar."); return; }
    setSyncing(true); setError(""); setNotice("");
    try {
      const result = await syncKfzData(forceFull);
      setSnapshot(result.snapshot);
      setNotice(`${result.downloaded} geänderte Datensätze aus Microsoft 365 übernommen.`);
    } catch (syncError) { setError(String(syncError).replace(/^Error:\s*/, "")); }
    finally { setSyncing(false); }
  }, [props.offline]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (isBrowserPreview()) { setSnapshot(previewSnapshot); setLoading(false); return; }
      try {
        const cached = await getKfzSnapshot();
        if (!cancelled) { setSnapshot(cached); setLoading(false); }
        if (!props.offline) void synchronize(false);
      } catch (loadError) { if (!cancelled) { setError(String(loadError)); setLoading(false); } }
    };
    void load();
    return () => { cancelled = true; };
  }, [props.offline, synchronize]);

  const openVehicle = (vehicle: KfzVehicle) => setSelectedVehicle(vehicle);
  const currentContent = loading ? <Loading /> : tab === "overview" ? <Overview snapshot={snapshot} onGo={setTab} onVehicle={openVehicle} />
    : tab === "vehicles" ? <Vehicles snapshot={snapshot} search={search} onSearch={setSearch} onVehicle={openVehicle} />
      : tab === "maintenance" ? <Maintenance snapshot={snapshot} search={search} onSearch={setSearch} />
        : tab === "board" ? <Board snapshot={snapshot} />
          : tab === "locations" ? <Locations snapshot={snapshot} />
            : tab === "documents" ? <Documents snapshot={snapshot} />
              : tab === "reports" ? <Reports snapshot={snapshot} />
                : <KfzSettings snapshot={snapshot} offline={props.offline} syncing={syncing} onSync={synchronize} />;

  return <main className="kfz-workspace">
    <PortalGlobalHeader session={props.session} exchangeSyncStatus={props.exchangeSyncStatus} searchValue={search}
      searchPlaceholder="Kennzeichen, Fahrzeug oder Wartung suchen …" onSearchActivate={() => setTab("vehicles")}
      onSearchChange={(value) => { setSearch(value); if (value) setTab("vehicles"); }} onGoHome={props.onBack}
      onSignOut={props.onSignOut} onSyncExchange={props.onSyncExchange} />
    <div className="kfz-layout">
      <nav className="kfz-nav" aria-label="KFZ-Bereiche">
        <div className="kfz-nav-title"><span><Truck size={24} /></span><div><small>DMH MODUL</small><strong>KFZ</strong></div></div>
        {tabs.map((item) => { const Icon = item.icon; return <button className={tab === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setTab(item.id)}><Icon size={21} /><span>{item.title}</span>{tab === item.id && <ChevronRight size={17} />}</button>; })}
        <button className="kfz-nav-back" type="button" onClick={props.onBack}><ArrowLeft size={20} /><span>Portalübersicht</span></button>
      </nav>
      <section className="kfz-main">
        {(notice || error) && <div className={`kfz-toast ${error ? "error" : "success"}`}>{error || notice}<button type="button" onClick={() => { setError(""); setNotice(""); }}><X size={18} /></button></div>}
        <header className="kfz-page-bar"><div><small>FUHRPARK · NUR LESEN</small><strong>{tabs.find((item) => item.id === tab)?.title}</strong></div><span className={props.offline ? "offline" : ""}>{props.offline ? <CloudOff size={18} /> : <Database size={18} />}{props.offline ? "Lokaler Cache" : snapshot.cacheReady ? "Cache + M365" : "M365 wird vorbereitet"}</span><button type="button" disabled={syncing || props.offline} onClick={() => void synchronize(false)}>{syncing ? <LoaderCircle className="spin" size={19} /> : <RefreshCw size={19} />} Aktualisieren</button></header>
        {currentContent}
      </section>
    </div>
    {selectedVehicle && <VehicleDetail vehicle={selectedVehicle} snapshot={snapshot} onClose={() => setSelectedVehicle(null)} />}
  </main>;
}

function Loading() { return <div className="kfz-loading"><LoaderCircle className="spin" size={34} /><strong>Lokaler Fuhrpark wird geladen …</strong><p>Die Oberfläche wartet nicht auf Microsoft 365.</p></div>; }

function Overview({ snapshot, onGo, onVehicle }: { snapshot: KfzSnapshot; onGo: (tab: KfzTab) => void; onVehicle: (vehicle: KfzVehicle) => void }) {
  const active = snapshot.vehicles.filter((vehicle) => vehicle.aktiv);
  const open = snapshot.maintenance.filter((item) => !["Erledigt", "Storniert"].includes(item.status));
  const overdueVehicles = active.filter((vehicle) => [vehicle.naechsterTuev, vehicle.naechsteAu, vehicle.naechsteInspektion].some((date) => dueState(date) === "overdue"));
  const overdueMaintenance = open.filter((item) => dueState(item.datum) === "overdue");
  return <div className="kfz-overview">
    <div className="kfz-hero"><div><span><ShieldCheck size={18} /> Fuhrpark zentral in Microsoft 365</span><h1>{active.length} aktive Fahrzeuge zuverlässig im Blick</h1><p>Die Daten werden lokal sofort angezeigt und im Hintergrund mit SharePoint abgeglichen.</p></div><Truck size={92} /></div>
    <div className="kfz-kpis">
      <button type="button" onClick={() => onGo("vehicles")}><span><CarFront size={23} /></span><small>AKTIVE FAHRZEUGE</small><strong>{active.length}</strong><em>{snapshot.vehicles.length - active.length} archiviert</em></button>
      <button type="button" onClick={() => onGo("maintenance")}><span><Wrench size={23} /></span><small>OFFENE WARTUNGEN</small><strong>{open.length}</strong><em>{overdueMaintenance.length} überfällig</em></button>
      <button type="button" onClick={() => onGo("vehicles")}><span><CircleAlert size={23} /></span><small>FÄLLIGKEITEN</small><strong>{overdueVehicles.length}</strong><em>TÜV, AU oder Inspektion</em></button>
      <button type="button" onClick={() => onGo("documents")}><span><FileText size={23} /></span><small>DOKUMENTE</small><strong>{snapshot.documents.length}</strong><em>im SharePoint</em></button>
    </div>
    <div className="kfz-overview-grid">
      <section className="kfz-panel"><header><div><h2>Handlungsbedarf</h2><p>Überfällige oder bald fällige Fahrzeuge</p></div><button type="button" onClick={() => onGo("vehicles")}>Alle Fahrzeuge <ChevronRight size={18} /></button></header><div className="kfz-action-list">{active.filter((vehicle) => [vehicle.naechsterTuev, vehicle.naechsteInspektion].some((date) => ["overdue", "soon"].includes(dueState(date)))).slice(0, 6).map((vehicle) => <button type="button" key={vehicle.id} onClick={() => onVehicle(vehicle)}><span className={`kfz-due-dot ${dueState(vehicle.naechsterTuev)}`} /><span><strong>{vehicle.kennzeichen}</strong><small>{vehicle.spitzname || vehicle.fahrzeugtyp || vehicle.hersteller}</small></span><span><small>Nächster TÜV</small><strong>{formatDate(vehicle.naechsterTuev)}</strong></span><ChevronRight size={18} /></button>)}</div></section>
      <section className="kfz-panel"><header><div><h2>Nächste Wartungen</h2><p>Aktuelle Werkstattplanung</p></div><button type="button" onClick={() => onGo("board")}>Zum Board <ChevronRight size={18} /></button></header><div className="kfz-maintenance-list">{open.sort((a, b) => (a.datum || "").localeCompare(b.datum || "")).slice(0, 6).map((item) => <article key={item.id}><span className={`kfz-status status-${statusSlug(item.status)}`}>{item.status || "Posteingang"}</span><div><strong>{item.title}</strong><small>{vehicleLabel(snapshot, item.fahrzeugId, item.fahrzeugLabel)} · {item.kategorie}</small></div><time>{formatDate(item.datum)}</time></article>)}</div></section>
    </div>
  </div>;
}

function Vehicles({ snapshot, search, onSearch, onVehicle }: { snapshot: KfzSnapshot; search: string; onSearch: (value: string) => void; onVehicle: (vehicle: KfzVehicle) => void }) {
  const [activeOnly, setActiveOnly] = useState(true);
  const [location, setLocation] = useState("all");
  const term = search.trim().toLocaleLowerCase("de-DE");
  const visible = snapshot.vehicles.filter((vehicle) => (!activeOnly || vehicle.aktiv) && (location === "all" || vehicle.standortId === location) && (!term || `${vehicle.kennzeichen} ${vehicle.spitzname} ${vehicle.hersteller} ${vehicle.fahrzeugtyp} ${vehicle.vin}`.toLocaleLowerCase("de-DE").includes(term)));
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Fahrzeuge</h1><p>{visible.length} von {snapshot.vehicles.length} Fahrzeugen</p></div><span className="kfz-readonly"><ShieldCheck size={18} /> Sichere Leseansicht</span></div><div className="kfz-filterbar"><label><Search size={19} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Kennzeichen, Typ, Hersteller oder VIN" /></label><select value={location} onChange={(event) => setLocation(event.target.value)}><option value="all">Alle Standorte</option>{snapshot.locations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><label className="kfz-checkbox"><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Nur aktive</label></div><div className="kfz-vehicle-grid">{visible.map((vehicle) => <button className="kfz-vehicle-card" type="button" key={vehicle.id} onClick={() => onVehicle(vehicle)}><header><span className="kfz-plate">{vehicle.kennzeichen || "Ohne Kennzeichen"}</span><span className={vehicle.aktiv ? "active" : "inactive"}>{vehicle.aktiv ? "Aktiv" : "Archiv"}</span></header><div className="kfz-vehicle-icon"><CarFront size={40} /></div><h2>{vehicle.spitzname || [vehicle.hersteller, vehicle.fahrzeugtyp].filter(Boolean).join(" ") || "Fahrzeug"}</h2><p>{[vehicle.hersteller, vehicle.fahrzeugtyp, vehicle.baujahr].filter(Boolean).join(" · ")}</p><dl><div><dt><Gauge size={16} /> Kilometer</dt><dd>{vehicle.kilometerstand?.toLocaleString("de-DE") ?? "—"}</dd></div><div><dt><MapPin size={16} /> Standort</dt><dd>{vehicle.standortLabel || vehicle.legacyStandortText || "—"}</dd></div></dl><footer><span className={dueState(vehicle.naechsterTuev)}>TÜV {formatDate(vehicle.naechsterTuev)}</span><span className={dueState(vehicle.naechsteInspektion)}>Inspektion {formatDate(vehicle.naechsteInspektion)}</span></footer></button>)}</div>{visible.length === 0 && <Empty icon={CarFront} title="Keine Fahrzeuge gefunden" text="Passen Sie Suche oder Filter an." />}</section>;
}

function Maintenance({ snapshot, search, onSearch }: { snapshot: KfzSnapshot; search: string; onSearch: (value: string) => void }) {
  const [status, setStatus] = useState("all"); const [category, setCategory] = useState("all");
  const term = search.trim().toLocaleLowerCase("de-DE");
  const visible = snapshot.maintenance.filter((item) => (status === "all" || item.status === status) && (category === "all" || item.kategorie === category) && (!term || `${item.title} ${item.fahrzeugLabel} ${item.legacyKennzeichen} ${item.werkstatt}`.toLocaleLowerCase("de-DE").includes(term))).sort((a, b) => (b.datum || "").localeCompare(a.datum || ""));
  const categories = [...new Set(snapshot.maintenance.map((item) => item.kategorie).filter(Boolean))];
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Wartungen</h1><p>Inspektionen, Reparaturen und Prüfungen</p></div></div><div className="kfz-filterbar"><label><Search size={19} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Wartung oder Fahrzeug suchen" /></label><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Alle Status</option>{statuses.map((item) => <option key={item}>{item}</option>)}</select><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">Alle Kategorien</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></div><div className="kfz-table-wrap"><table className="kfz-table"><thead><tr><th>Datum</th><th>Fahrzeug</th><th>Wartung</th><th>Kategorie</th><th>Status</th><th>Werkstatt</th><th>Kosten</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id}><td><span className={dueState(item.datum)}>{formatDate(item.datum)}</span></td><td><strong className="kfz-table-plate">{vehicleLabel(snapshot, item.fahrzeugId, item.fahrzeugLabel || item.legacyKennzeichen)}</strong></td><td><strong>{item.title}</strong>{item.beschreibung && <small>{item.beschreibung}</small>}</td><td>{item.kategorie || "—"}</td><td><span className={`kfz-status status-${statusSlug(item.status)}`}>{item.status || "Posteingang"}</span></td><td>{item.werkstatt || "—"}</td><td>{formatMoney(item.kosten)}</td></tr>)}</tbody></table></div></section>;
}

function Board({ snapshot }: { snapshot: KfzSnapshot }) {
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Wartungsboard</h1><p>Statusübersicht aus den aktuellen SharePoint-Daten</p></div><span className="kfz-readonly"><ShieldCheck size={18} /> Verschieben nach Freigabe</span></div><div className="kfz-board">{statuses.map((status) => { const items = snapshot.maintenance.filter((item) => normalizeStatus(item.status) === status); return <section key={status}><header><span className={`kfz-status status-${statusSlug(status)}`}>{status}</span><strong>{items.length}</strong></header><div>{items.map((item) => <article key={item.id}><strong>{item.title}</strong><span className="kfz-board-plate">{vehicleLabel(snapshot, item.fahrzeugId, item.fahrzeugLabel)}</span><small><CalendarClock size={15} /> {formatDate(item.datum)}</small>{item.kosten != null && <small>{formatMoney(item.kosten)}</small>}</article>)}</div></section>; })}</div></section>;
}

function Locations({ snapshot }: { snapshot: KfzSnapshot }) {
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Standorte</h1><p>Fahrzeuge nach Einsatzort</p></div></div><div className="kfz-location-grid">{snapshot.locations.map((location) => { const vehicles = snapshot.vehicles.filter((vehicle) => vehicle.standortId === location.id); return <article key={location.id}><header><span><Building2 size={27} /></span><div><small>{location.code || "STANDORT"}</small><h2>{location.name}</h2></div><em>{location.aktiv ? "Aktiv" : "Inaktiv"}</em></header><p>{location.adresse || "Keine Adresse hinterlegt"}</p><footer><strong>{vehicles.filter((vehicle) => vehicle.aktiv).length}</strong><span>aktive Fahrzeuge</span><div>{vehicles.slice(0, 4).map((vehicle) => <small key={vehicle.id}>{vehicle.kennzeichen}</small>)}</div></footer></article>; })}</div></section>;
}

function Documents({ snapshot }: { snapshot: KfzSnapshot }) {
  const [type, setType] = useState("all"); const types = [...new Set(snapshot.documents.map((item) => item.dokumenttyp).filter(Boolean))]; const visible = snapshot.documents.filter((item) => type === "all" || item.dokumenttyp === type);
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Dokumente</h1><p>Rechnungen, Fahrzeugscheine und Prüfberichte</p></div></div><div className="kfz-filterbar"><select value={type} onChange={(event) => setType(event.target.value)}><option value="all">Alle Dokumenttypen</option>{types.map((item) => <option key={item}>{item}</option>)}</select></div><div className="kfz-document-list">{visible.map((item) => <article key={item.id}><span><FileText size={25} /></span><div><strong>{item.fileName || "Dokument"}</strong><small>{item.dokumenttyp || "Sonstiges"} · {vehicleLabel(snapshot, item.fahrzeugId, item.legacyKennzeichen)}</small></div><time>{formatDate(item.dokumentdatum || item.uploadedAt)}</time><b>{formatMoney(item.betrag)}</b>{item.webUrl ? <a href={item.webUrl} target="_blank" rel="noreferrer">Öffnen</a> : <button type="button" disabled>Öffnen</button>}</article>)}</div>{visible.length === 0 && <Empty icon={FileText} title="Keine Dokumente" text="Für diesen Filter wurden keine Dokumente gefunden." />}</section>;
}

function Reports({ snapshot }: { snapshot: KfzSnapshot }) {
  const maintenanceCost = snapshot.maintenance.reduce((sum, item) => sum + (item.kosten || 0), 0);
  const byCategory = [...new Set(snapshot.maintenance.map((item) => item.kategorie || "Sonstiges"))].map((category) => ({ category, count: snapshot.maintenance.filter((item) => (item.kategorie || "Sonstiges") === category).length, cost: snapshot.maintenance.filter((item) => (item.kategorie || "Sonstiges") === category).reduce((sum, item) => sum + (item.kosten || 0), 0) })).sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...byCategory.map((item) => item.count));
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Auswertungen</h1><p>Kennzahlen direkt aus dem lokalen Fuhrpark-Cache</p></div></div><div className="kfz-report-kpis"><article><small>ERFASSTE KOSTEN</small><strong>{formatMoney(maintenanceCost)}</strong><span>{snapshot.maintenance.length} Wartungen</span></article><article><small>Ø KOSTEN / WARTUNG</small><strong>{formatMoney(snapshot.maintenance.length ? maintenanceCost / snapshot.maintenance.length : 0)}</strong><span>nur Einträge mit Betrag</span></article><article><small>Ø KILOMETERSTAND</small><strong>{Math.round(snapshot.vehicles.reduce((sum, item) => sum + (item.kilometerstand || 0), 0) / Math.max(1, snapshot.vehicles.filter((item) => item.kilometerstand != null).length)).toLocaleString("de-DE")}</strong><span>aktive und archivierte Fahrzeuge</span></article></div><div className="kfz-panel kfz-report-chart"><header><div><h2>Wartungen nach Kategorie</h2><p>Anzahl und erfasste Kosten</p></div></header>{byCategory.map((item) => <div key={item.category}><strong>{item.category}</strong><span><i style={{ width: `${Math.max(4, item.count / max * 100)}%` }} /></span><b>{item.count}</b><em>{formatMoney(item.cost)}</em></div>)}</div></section>;
}

function KfzSettings({ snapshot, offline, syncing, onSync }: { snapshot: KfzSnapshot; offline: boolean; syncing: boolean; onSync: (force: boolean) => Promise<void> }) {
  return <section className="kfz-section"><div className="kfz-section-heading"><div><h1>Einstellungen</h1><p>Verbindung und lokaler Datenbestand</p></div></div><div className="kfz-settings-grid"><article><span><Database size={28} /></span><div><small>DATENQUELLE</small><h2>Microsoft 365 · SharePoint</h2><p><code>dmhaidlingen.sharepoint.com/sites/DMHFuhrpark</code></p><dl><div><dt>Fahrzeuge</dt><dd>{snapshot.vehicles.length}</dd></div><div><dt>Wartungen</dt><dd>{snapshot.maintenance.length}</dd></div><div><dt>Standorte</dt><dd>{snapshot.locations.length}</dd></div><div><dt>Dokumente</dt><dd>{snapshot.documents.length}</dd></div></dl></div></article><article><span><RefreshCw size={28} /></span><div><small>SYNCHRONISIERUNG</small><h2>Lokaler, persistenter Cache</h2><p>Beim Öffnen erscheinen zuerst die lokalen Daten. Microsoft 365 liefert danach nur Änderungen.</p><p><strong>Letzter Abgleich:</strong> {snapshot.lastSyncedAt ? new Date(snapshot.lastSyncedAt).toLocaleString("de-DE") : "Noch nicht ausgeführt"}</p><div className="kfz-settings-actions"><button type="button" disabled={offline || syncing} onClick={() => void onSync(false)}>{syncing ? <LoaderCircle className="spin" size={19} /> : <RefreshCw size={19} />} Änderungen abrufen</button><button type="button" disabled={offline || syncing} onClick={() => void onSync(true)}><Database size={19} /> Cache vollständig neu aufbauen</button></div></div></article><article><span><ShieldCheck size={28} /></span><div><small>SICHERHEIT</small><h2>Nur-Lesen-Pilot</h2><p>Diese Version verändert keine SharePoint-Daten. Bearbeiten, Anlegen, Löschen und Statuswechsel werden erst nach Ihrer Prüfung freigeschaltet.</p></div></article></div></section>;
}

function VehicleDetail({ vehicle, snapshot, onClose }: { vehicle: KfzVehicle; snapshot: KfzSnapshot; onClose: () => void }) {
  const maintenance = snapshot.maintenance.filter((item) => item.fahrzeugId === vehicle.id || (!item.fahrzeugId && item.legacyKennzeichen === vehicle.kennzeichen));
  const documents = snapshot.documents.filter((item) => item.fahrzeugId === vehicle.id || (!item.fahrzeugId && item.legacyKennzeichen === vehicle.kennzeichen));
  return <div className="kfz-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="kfz-vehicle-dialog" role="dialog" aria-modal="true"><header><span><CarFront size={34} /></span><div><small>FAHRZEUG</small><h1>{vehicle.kennzeichen}</h1><p>{vehicle.spitzname || [vehicle.hersteller, vehicle.fahrzeugtyp].filter(Boolean).join(" ")}</p></div><button type="button" onClick={onClose}><X size={22} /></button></header><div className="kfz-detail-status"><span className={vehicle.aktiv ? "active" : "inactive"}>{vehicle.aktiv ? "Aktiv" : "Archiviert"}</span><span><MapPin size={17} /> {vehicle.standortLabel || vehicle.legacyStandortText || "Kein Standort"}</span><span><Gauge size={17} /> {vehicle.kilometerstand?.toLocaleString("de-DE") ?? "—"} km</span></div><div className="kfz-detail-grid"><section><h2>Fahrzeugdaten</h2><dl>{[["Hersteller", vehicle.hersteller], ["Fahrzeugtyp", vehicle.fahrzeugtyp], ["Baujahr", vehicle.baujahr], ["VIN", vehicle.vin], ["Farbe", vehicle.farbe], ["Leistung", vehicle.leistungKw ? `${vehicle.leistungKw} kW` : ""], ["Öltyp", vehicle.oeltyp], ["Verantwortlich", vehicle.legacyVerantwortliche]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl></section><section><h2>Fälligkeiten</h2><dl>{[["TÜV", vehicle.naechsterTuev], ["AU", vehicle.naechsteAu], ["Inspektion", vehicle.naechsteInspektion], ["Sommercheck", vehicle.naechsterSommercheck], ["Wintercheck", vehicle.naechsterWintercheck]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd><span className={dueState(value as string)}>{formatDate(value as string)}</span></dd></div>)}</dl></section></div><section className="kfz-detail-history"><h2>Wartungshistorie <span>{maintenance.length}</span></h2>{maintenance.slice(0, 10).map((item) => <article key={item.id}><time>{formatDate(item.datum)}</time><span className={`kfz-status status-${statusSlug(item.status)}`}>{item.status}</span><div><strong>{item.title}</strong><small>{item.kategorie} · {item.kilometerstand?.toLocaleString("de-DE") ?? "—"} km</small></div><b>{formatMoney(item.kosten)}</b></article>)}{maintenance.length === 0 && <p>Keine Wartungshistorie vorhanden.</p>}</section><section className="kfz-detail-documents"><h2>Dokumente <span>{documents.length}</span></h2>{documents.map((item) => <article key={item.id}><FileText size={20} /><span><strong>{item.fileName}</strong><small>{item.dokumenttyp}</small></span><time>{formatDate(item.dokumentdatum)}</time></article>)}</section><footer><span><ShieldCheck size={18} /> Daten aus dem sicheren lokalen Cache</span><button type="button" onClick={onClose}>Schließen</button></footer></section></div>;
}

function Empty({ icon: Icon, title, text }: { icon: typeof CarFront; title: string; text: string }) { return <div className="kfz-empty"><Icon size={38} /><strong>{title}</strong><p>{text}</p></div>; }
function statusSlug(value: string) { return normalizeStatus(value).toLocaleLowerCase("de-DE").replace(/ /g, "-").replace(/ä/g, "a"); }
function normalizeStatus(value: string) { const normalized = value.trim().toLocaleLowerCase("de-DE"); if (["geplant"].includes(normalized)) return "Geplant"; if (["in arbeit"].includes(normalized)) return "In Arbeit"; if (["wartet auf teile"].includes(normalized)) return "Wartet auf Teile"; if (["erledigt"].includes(normalized)) return "Erledigt"; if (["storniert", "archiviert", "abgeschlossen"].includes(normalized)) return "Storniert"; return "Posteingang"; }

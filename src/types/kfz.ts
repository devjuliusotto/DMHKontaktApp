export interface KfzVehicle {
  id: string; etag: string; kennzeichen: string; spitzname: string; farbe: string; aktiv: boolean;
  fahrzeugtyp: string; hersteller: string; lackcode: string; vin: string; erstzulassung: string | null;
  baujahr: number | null; motorkennbuchstabe: string; hubraumCcm: number | null; leistungKw: number | null;
  kilometerstand: number | null; standortId: string; standortLabel: string; legacyStandortText: string;
  legacyVerantwortliche: string; tankkarte: boolean; versicherung: string; oeltyp: string;
  naechsterTuev: string | null; naechsteAu: string | null; naechsteInspektion: string | null;
  naechsteInspektionKm: number | null; naechsterSommercheck: string | null; naechsterWintercheck: string | null;
  kaufdatum: string | null; verkaufsdatum: string | null; legacyKennzeichen: string; legacyImportId: string;
  modifiedAt: string | null;
}

export interface KfzMaintenance {
  id: string; etag: string; title: string; fahrzeugId: string; fahrzeugLabel: string; legacyKennzeichen: string;
  datum: string | null; kilometerstand: number | null; kategorie: string; beschreibung: string; arbeiten: string;
  status: string; werkstatt: string; kosten: number | null; naechsterTermin: string | null;
  naechsterKilometerstand: number | null; legacyWartungsId: number | null; modifiedAt: string | null;
}

export interface KfzLocation {
  id: string; etag: string; name: string; aktiv: boolean; code: string; adresse: string;
  legacyEinsatzortId: number | null; modifiedAt: string | null;
}

export interface KfzDocument {
  id: string; driveItemId: string; fileName: string; webUrl: string; fahrzeugId: string; wartungId: string;
  legacyKennzeichen: string; dokumenttyp: string; dokumentdatum: string | null; beschreibung: string;
  betrag: number | null; aktiv: boolean; uploadedBy: string; uploadedAt: string | null; modifiedAt: string | null;
}

export interface KfzSnapshot {
  vehicles: KfzVehicle[]; maintenance: KfzMaintenance[]; locations: KfzLocation[]; documents: KfzDocument[];
  lastSyncedAt: string | null; cacheReady: boolean;
}

export interface KfzSyncResult {
  snapshot: KfzSnapshot; downloaded: number; fullSync: boolean; syncedAt: string;
}

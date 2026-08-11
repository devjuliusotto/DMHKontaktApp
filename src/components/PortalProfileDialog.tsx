import { CalendarClock, Check, LoaderCircle, MapPin, Save, UserRound, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { getPortalUserProfile, updatePortalUserProfile } from "../services/db";
import type { Microsoft365Account, PortalUserProfile, PortalUserProfileUpdate } from "../types/m365";

interface PortalProfileDialogProps {
  account: Microsoft365Account;
  onClose: () => void;
}

const emptyUpdate: PortalUserProfileUpdate = {
  businessPhone: "",
  mobilePhone: "",
  officeLocation: "",
  streetAddress: "",
  postalCode: "",
  city: "",
  country: "Deutschland"
};

function editableProfile(profile: PortalUserProfile): PortalUserProfileUpdate {
  return {
    businessPhone: profile.businessPhones[0] ?? "",
    mobilePhone: profile.mobilePhone,
    officeLocation: profile.officeLocation,
    streetAddress: profile.streetAddress,
    postalCode: profile.postalCode,
    city: profile.city,
    country: profile.country || "Deutschland"
  };
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("reading 'invoke'")
    ? "Die Microsoft-Profildaten sind nur in der installierten App verfügbar."
    : message;
}

export function PortalProfileDialog({ account, onClose }: PortalProfileDialogProps) {
  const [profile, setProfile] = useState<PortalUserProfile | null>(null);
  const [form, setForm] = useState<PortalUserProfileUpdate>(emptyUpdate);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getPortalUserProfile()
      .then((loaded) => {
        if (!active) return;
        setProfile(loaded);
        setForm(editableProfile(loaded));
      })
      .catch((loadError) => {
        if (active) setError(errorText(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const change = (field: keyof PortalUserProfileUpdate, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setMessage("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const updated = await updatePortalUserProfile(form);
      setProfile(updated);
      setForm(editableProfile(updated));
      setMessage("Profil wurde mit Microsoft 365 synchronisiert.");
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="portal-profile-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="portal-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="portal-profile-title" onSubmit={(event) => void save(event)}>
        <header>
          <span className="portal-profile-dialog-icon"><UserRound size={27} /></span>
          <div>
            <small>MICROSOFT 365</small>
            <h2 id="portal-profile-title">Mein Profil</h2>
            <p>Diese Angaben können später auch am Empfang angezeigt werden.</p>
          </div>
          <button className="portal-profile-close" type="button" aria-label="Profil schließen" onClick={onClose}><X size={23} /></button>
        </header>

        <div className="portal-profile-identity">
          <span>{account.displayName.trim().slice(0, 1).toUpperCase() || "D"}</span>
          <div>
            <strong>{profile?.displayName || account.displayName}</strong>
            <small>{profile?.jobTitle || "Funktion nicht hinterlegt"}{profile?.department ? ` · ${profile.department}` : ""}</small>
            <small>{profile?.mail || profile?.userPrincipalName || account.email || account.userPrincipalName}</small>
          </div>
        </div>

        {loading ? (
          <div className="portal-profile-loading"><LoaderCircle className="spin" size={28} /> Profil wird von Microsoft geladen …</div>
        ) : (
          <>
            {error && <div className="portal-profile-message error" role="alert">{error}</div>}
            {message && <div className="portal-profile-message success" role="status"><Check size={18} /> {message}</div>}

            <section className="portal-profile-section">
              <div className="portal-profile-section-title"><MapPin size={20} /><div><h3>Erreichbarkeit und Arbeitsplatz</h3><p>Nur diese persönlichen Kontaktdaten können Sie selbst ändern.</p></div></div>
              <div className="portal-profile-form-grid">
                <label>Diensttelefon<input value={form.businessPhone} onChange={(event) => change("businessPhone", event.target.value)} autoComplete="tel" /></label>
                <label>Mobiltelefon<input value={form.mobilePhone} onChange={(event) => change("mobilePhone", event.target.value)} autoComplete="tel" /></label>
                <label className="portal-profile-wide">Büro / Standort<input value={form.officeLocation} onChange={(event) => change("officeLocation", event.target.value)} placeholder="z. B. Haus A · Zimmer 12" /></label>
                <label className="portal-profile-wide">Straße und Hausnummer<input value={form.streetAddress} onChange={(event) => change("streetAddress", event.target.value)} autoComplete="street-address" /></label>
                <label>Postleitzahl<input value={form.postalCode} onChange={(event) => change("postalCode", event.target.value)} autoComplete="postal-code" /></label>
                <label>Ort<input value={form.city} onChange={(event) => change("city", event.target.value)} autoComplete="address-level2" /></label>
                <label className="portal-profile-wide">Land<input value={form.country} onChange={(event) => change("country", event.target.value)} autoComplete="country-name" /></label>
              </div>
            </section>

            <section className="portal-profile-automatic">
              <CalendarClock size={22} />
              <div><strong>Automatisch aus Microsoft 365</strong><p>Urlaub, Abwesenheit sowie Raum- und sonstige Reservierungen werden später aus Kalender und Buchungssystem übernommen.</p></div>
            </section>
          </>
        )}

        <footer>
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button className="primary" type="submit" disabled={loading || saving || !profile}>
            {saving ? <LoaderCircle className="spin" size={19} /> : <Save size={19} />}
            {saving ? "Speichern …" : "Mit Microsoft speichern"}
          </button>
        </footer>
      </form>
    </div>
  );
}

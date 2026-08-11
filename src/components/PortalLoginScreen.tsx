import {
  Building2,
  Check,
  ExternalLink,
  HelpCircle,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  UserRoundCheck
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  disconnectMicrosoft365Account,
  openMicrosoft365PasswordChange,
  openMicrosoft365PasswordReset,
  openMicrosoft365SecurityInfo,
  restorePortalSession,
  startMicrosoft365Connection
} from "../services/db";
import type { PortalSession } from "../types/m365";

interface PortalLoginScreenProps {
  session: PortalSession;
  startupError?: string;
  onSessionChanged: (session: PortalSession) => void;
}

export function PortalLoginScreen({ session, startupError = "", onSessionChanged }: PortalLoginScreenProps) {
  const [rememberSignIn, setRememberSignIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(startupError || session.message);
  const [showAccessHelp, setShowAccessHelp] = useState(false);
  useEffect(() => {
    setMessage(startupError || session.message);
  }, [session.message, startupError]);

  const startSignIn = async () => {
    setBusy(true);
    setMessage("");
    try {
      await startMicrosoft365Connection(rememberSignIn);
      onSessionChanged(await restorePortalSession());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryAuthorization = async () => {
    setBusy(true);
    setMessage("");
    try {
      onSessionChanged(await restorePortalSession());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await disconnectMicrosoft365Account();
      onSessionChanged(await restorePortalSession());
    } catch (error) {
      setMessage(String(error));
      setBusy(false);
    }
  };

  const openHelpPage = async (action: "reset" | "change" | "prepare") => {
    setMessage("");
    try {
      if (action === "reset") await openMicrosoft365PasswordReset();
      else if (action === "change") await openMicrosoft365PasswordChange();
      else await openMicrosoft365SecurityInfo();
      setMessage("Die sichere Microsoft-Seite wurde im Browser geöffnet.");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const configurationMissing = session.state === "configuration_required";
  const accessDenied = session.state === "access_denied";

  return (
    <main className="portal-login-screen">
      <section className="portal-login-card" aria-labelledby="portal-login-title">
        <div className="portal-login-brand">
          <img src="/dmh-kontakte-kalender.png" alt="DMH" />
          <div>
            <span>Diakonissenmutterhaus Aidlingen</span>
            <h1 id="portal-login-title">DMH Portal</h1>
          </div>
        </div>

        {!configurationMissing && !accessDenied && !showAccessHelp && (
          <>
            <div className="portal-login-intro">
              <div className="portal-login-icon"><Building2 size={32} /></div>
              <h2>Bei Microsoft anmelden</h2>
              <p>Klicken Sie auf den großen Knopf. Microsoft führt Sie anschließend Schritt für Schritt weiter.</p>
            </div>
            <div className="portal-login-trust">
              <ShieldCheck size={21} />
              <span>Das Microsoft-Kennwort wird ausschließlich bei Microsoft eingegeben und niemals in dieser App gespeichert.</span>
            </div>
            <label className="portal-remember-option">
              <input
                type="checkbox"
                checked={rememberSignIn}
                onChange={(event) => setRememberSignIn(event.target.checked)}
              />
              <span><strong>Angemeldet bleiben</strong><small>Die Sitzung wird geschützt für den nächsten Start gespeichert.</small></span>
              {rememberSignIn && <Check size={20} />}
            </label>
            {message && <p className="portal-login-message error" role="alert">{message}</p>}
            <button className="primary large portal-login-button" type="button" onClick={startSignIn} disabled={busy || !session.configured}>
              {busy ? <LoaderCircle className="spin" size={22} /> : <Building2 size={22} />}
              {busy ? "Microsoft-Anmeldung läuft …" : "Mit Microsoft 365 anmelden"}
            </button>
            {busy && <p className="portal-waiting"><LoaderCircle className="spin" size={19} /> Folgen Sie einfach der geöffneten Microsoft-Seite. Danach kehren Sie automatisch zum Portal zurück.</p>}
            <button className="portal-login-help-button large" type="button" onClick={() => setShowAccessHelp(true)} disabled={busy}>
              <HelpCircle size={22} /> Hilfe mit Anmeldung oder Kennwort
            </button>
          </>
        )}

        {showAccessHelp && (
          <div className="portal-access-help">
            <div className="portal-login-icon"><HelpCircle size={32} /></div>
            <h2>Wobei brauchen Sie Hilfe?</h2>
            <p>Wählen Sie einfach den Satz aus, der zu Ihrer Situation passt.</p>

            <button className="portal-help-choice primary-choice" type="button" onClick={() => void openHelpPage("reset")}>
              <KeyRound size={27} />
              <span><strong>Ich habe mein Kennwort vergessen</strong><small>Microsoft prüft Ihre Identität und lässt Sie ein neues Kennwort wählen.</small></span>
              <ExternalLink size={19} />
            </button>
            <button className="portal-help-choice" type="button" onClick={() => void openHelpPage("change")}>
              <ShieldCheck size={27} />
              <span><strong>Ich kenne mein Kennwort und möchte es ändern</strong><small>Öffnet direkt die sichere Microsoft-Seite zur Kennwortänderung.</small></span>
              <ExternalLink size={19} />
            </button>
            <button className="portal-help-choice" type="button" onClick={() => void openHelpPage("prepare")}>
              <Smartphone size={27} />
              <span><strong>Telefon oder E-Mail für die Wiederherstellung einrichten</strong><small>Damit Sie Ihr Kennwort später ohne Hilfe der EDV zurücksetzen können.</small></span>
              <ExternalLink size={19} />
            </button>

            <div className="portal-help-steps">
              <strong>Nach einer Kennwortänderung</strong>
              <span><b>1</b> Kehren Sie zu diesem Fenster zurück.</span>
              <span><b>2</b> Klicken Sie unten auf „Zur Anmeldung“.</span>
              <span><b>3</b> Melden Sie sich mit dem neuen Kennwort an.</span>
            </div>
            {message && <p className="portal-login-message" role="status">{message}</p>}
            <button className="large portal-help-back" type="button" onClick={() => { setShowAccessHelp(false); setMessage(""); }}>
              <UserRoundCheck size={21} /> Zur Anmeldung
            </button>
          </div>
        )}

        {configurationMissing && !showAccessHelp && (
          <div className="portal-access-state">
            <div className="portal-login-icon warning"><ShieldCheck size={31} /></div>
            <h2>Einrichtung durch die EDV erforderlich</h2>
            <p>
              {!session.configured
                ? "Die Microsoft-Anwendungs-ID ist in diesem Build noch nicht hinterlegt."
                : "Die Sicherheitsgruppen für die Portal-Module sind in diesem Build noch nicht hinterlegt."}
            </p>
            <p className="portal-login-message">{message}</p>
            {session.account && (
              <button type="button" onClick={signOut} disabled={busy}><LogOut size={20} /> Anderes Konto verwenden</button>
            )}
          </div>
        )}

        {accessDenied && !showAccessHelp && (
          <div className="portal-access-state">
            <div className="portal-login-icon warning"><ShieldCheck size={31} /></div>
            <h2>Noch kein Modul freigegeben</h2>
            <p>
              Das Konto <strong>{session.account?.userPrincipalName || session.account?.email}</strong> ist angemeldet,
              gehört aber noch keiner für das DMH Portal freigegebenen Sicherheitsgruppe an.
            </p>
            {message && <p className="portal-login-message">{message}</p>}
            <div className="portal-access-actions">
              <button className="primary" type="button" onClick={retryAuthorization} disabled={busy}>
                <RefreshCw className={busy ? "spin" : ""} size={20} /> Gruppen erneut prüfen
              </button>
              <button type="button" onClick={signOut} disabled={busy}><LogOut size={20} /> Anderes Konto</button>
            </div>
            <button className="portal-login-help-button" type="button" onClick={() => setShowAccessHelp(true)}>
              <HelpCircle size={20} /> Hilfe mit dem Kennwort
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

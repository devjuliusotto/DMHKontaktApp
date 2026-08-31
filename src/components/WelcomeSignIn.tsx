import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Mail,
  ShieldCheck
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { completeLocalAccountPasswordRecovery, requestLocalAccountPasswordRecovery } from "../services/db";
import type { VaultRecoveryDelivery } from "../types/vault";
import { isValidEmail } from "../utils/validation";
import {
  createLocalAccount,
  localAccountExists,
  resetLocalAccountPassword,
  signInToLocalAccount,
  type LocalAccountSession
} from "../utils/localAuth";

interface WelcomeSignInProps {
  onAuthenticated: (session: LocalAccountSession, isNewAccount: boolean) => void;
}

type SignInStep = "email" | "password" | "recovery";

export function WelcomeSignIn({ onAuthenticated }: WelcomeSignInProps) {
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [accountExists, setAccountExists] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryDelivery, setRecoveryDelivery] = useState<VaultRecoveryDelivery | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberForOneWeek, setRememberForOneWeek] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const normalizedEmail = email.trim().toLocaleLowerCase("de-DE");
  const emailIsValid = normalizedEmail.length > 0 && isValidEmail(normalizedEmail);
  const passwordIsLongEnough = password.length >= 8;
  const passwordsMatch = password.length > 0 && password === passwordAgain;
  const passwordActionLabel = useMemo(() => {
    if (busy) return accountExists ? "Anmeldung läuft …" : "Konto wird erstellt …";
    return accountExists ? "Anmelden" : "Konto erstellen";
  }, [accountExists, busy]);

  const continueWithEmail = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!emailIsValid) {
      setError("Bitte geben Sie eine gültige E-Mail-Adresse ein.");
      return;
    }
    setEmail(normalizedEmail);
    setAccountExists(localAccountExists(normalizedEmail));
    setStep("password");
  };

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!passwordIsLongEnough) {
      setError("Das Kennwort muss mindestens 8 Zeichen lang sein.");
      return;
    }
    if (!accountExists && !passwordsMatch) {
      setError("Die beiden Kennwörter stimmen nicht überein.");
      return;
    }

    setBusy(true);
    try {
      const session = accountExists
        ? await signInToLocalAccount(normalizedEmail, password, rememberForOneWeek)
        : await createLocalAccount(normalizedEmail, password, rememberForOneWeek);
      onAuthenticated(session, !accountExists);
    } catch (authenticationError) {
      setError(authenticationError instanceof Error ? authenticationError.message : String(authenticationError));
    } finally {
      setBusy(false);
    }
  };

  const returnToEmail = () => {
    setStep("email");
    setPassword("");
    setPasswordAgain("");
    setError("");
  };

  const requestPasswordRecovery = async () => {
    setBusy(true);
    setError("");
    try {
      if (!("__TAURI_INTERNALS__" in window)) {
        throw new Error("Die Kennwort-Wiederherstellung ist nur in der installierten Windows-App verfügbar.");
      }
      const delivery = await requestLocalAccountPasswordRecovery(normalizedEmail);
      setRecoveryDelivery(delivery);
      setRecoveryCode("");
      setPassword("");
      setPasswordAgain("");
      setStep("recovery");
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    } finally {
      setBusy(false);
    }
  };

  const completePasswordRecovery = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (recoveryCode.length !== 6) {
      setError("Bitte geben Sie den 6-stelligen Code ein.");
      return;
    }
    if (!passwordIsLongEnough) {
      setError("Das Kennwort muss mindestens 8 Zeichen lang sein.");
      return;
    }
    if (!passwordsMatch) {
      setError("Die beiden Kennwörter stimmen nicht überein.");
      return;
    }

    setBusy(true);
    try {
      await completeLocalAccountPasswordRecovery(normalizedEmail, recoveryCode);
      const session = await resetLocalAccountPassword(normalizedEmail, password, rememberForOneWeek);
      onAuthenticated(session, false);
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome-sign-in-screen" data-step={step}>
      <section className="welcome-sign-in-card" aria-labelledby="welcome-sign-in-title">
        <aside className="welcome-sign-in-intro">
          <div className="welcome-sign-in-brand">
            <img src="/dmh-kontakte-kalender.png" alt="" />
            <span><strong>DMH</strong><small>Kontakte und Kalender</small></span>
          </div>
          <div className="welcome-sign-in-intro-copy">
            <h1 id="welcome-sign-in-title">Willkommen.</h1>
          </div>
        </aside>

        <div className="welcome-sign-in-form-panel">
          {step === "email" ? (
            <form className="welcome-sign-in-form" onSubmit={continueWithEmail}>
              <span className="welcome-sign-in-form-icon"><Mail size={28} aria-hidden="true" /></span>
              <div className="welcome-sign-in-heading">
                <h2>Geben Sie Ihre E-Mail-Adresse des Mutterhauses ein.</h2>
              </div>
              <label className="welcome-sign-in-field">
                <span>E-Mail-Adresse des Mutterhauses</span>
                <input
                  autoComplete="email"
                  autoFocus
                  inputMode="email"
                  placeholder="name@beispiel.de"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-describedby={error ? "welcome-sign-in-error" : undefined}
                  required
                />
              </label>
              {error && <p className="welcome-sign-in-error" id="welcome-sign-in-error" role="alert">{error}</p>}
              <button className="primary large welcome-sign-in-submit" type="submit">
                Weiter <ArrowRight size={22} aria-hidden="true" />
              </button>
            </form>
          ) : step === "password" ? (
            <form className="welcome-sign-in-form" onSubmit={(event) => void authenticate(event)}>
              <button className="welcome-sign-in-back" type="button" onClick={returnToEmail} disabled={busy}>
                <ArrowLeft size={19} aria-hidden="true" /> Andere E-Mail-Adresse
              </button>
              <span className="welcome-sign-in-form-icon"><KeyRound size={28} aria-hidden="true" /></span>
              <div className="welcome-sign-in-heading">
                <h2>{accountExists ? "Kennwort eingeben" : "Kennwort erstellen"}</h2>
                <span className="welcome-sign-in-email"><Mail size={16} aria-hidden="true" /> {normalizedEmail}</span>
              </div>

              <label className="welcome-sign-in-field">
                <span>{accountExists ? "Ihr Kennwort" : "Neues Kennwort"}</span>
                <span className="welcome-sign-in-password-wrap">
                  <input
                    autoComplete={accountExists ? "current-password" : "new-password"}
                    autoFocus
                    minLength={8}
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} title={showPassword ? "Kennwort ausblenden" : "Kennwort anzeigen"}>
                    {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
                  </button>
                </span>
              </label>

              {!accountExists && (
                <>
                  <label className="welcome-sign-in-field">
                    <span>Kennwort wiederholen</span>
                    <input
                      autoComplete="new-password"
                      minLength={8}
                      type={showPassword ? "text" : "password"}
                      value={passwordAgain}
                      onChange={(event) => setPasswordAgain(event.target.value)}
                      required
                    />
                  </label>
                  <p className={passwordIsLongEnough ? "welcome-password-rule valid" : "welcome-password-rule"}>
                    <Check size={18} aria-hidden="true" /> Mindestens 8 Zeichen
                  </p>
                </>
              )}

              <label className="welcome-remember-option">
                <input type="checkbox" checked={rememberForOneWeek} onChange={(event) => setRememberForOneWeek(event.target.checked)} />
                <span><strong>Eine Woche angemeldet bleiben</strong></span>
              </label>

              {error && <p className="welcome-sign-in-error" role="alert">{error}</p>}
              {accountExists && (
                <button className="welcome-password-recovery-button" type="button" onClick={() => void requestPasswordRecovery()} disabled={busy}>
                  Kennwort vergessen?
                </button>
              )}
              <button className="primary large welcome-sign-in-submit" type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={22} aria-hidden="true" /> : <ShieldCheck size={22} aria-hidden="true" />}
                {passwordActionLabel}
              </button>
            </form>
          ) : (
            <form className="welcome-sign-in-form" onSubmit={(event) => void completePasswordRecovery(event)}>
              <button className="welcome-sign-in-back" type="button" onClick={() => { setStep("password"); setError(""); }} disabled={busy}>
                <ArrowLeft size={19} aria-hidden="true" /> Zurück
              </button>
              <span className="welcome-sign-in-form-icon"><Mail size={28} aria-hidden="true" /></span>
              <div className="welcome-sign-in-heading">
                <h2>Kennwort zurücksetzen</h2>
                <span className="welcome-sign-in-email">Code an {recoveryDelivery?.recoveryEmailHint}</span>
              </div>

              <label className="welcome-sign-in-field welcome-recovery-code-field">
                <span>6-stelliger Code</span>
                <input
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/g, ""))}
                  required
                />
              </label>
              <label className="welcome-sign-in-field">
                <span>Neues Kennwort</span>
                <span className="welcome-sign-in-password-wrap">
                  <input autoComplete="new-password" minLength={8} type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} title={showPassword ? "Kennwort ausblenden" : "Kennwort anzeigen"}>
                    {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
                  </button>
                </span>
              </label>
              <label className="welcome-sign-in-field">
                <span>Kennwort wiederholen</span>
                <input autoComplete="new-password" minLength={8} type={showPassword ? "text" : "password"} value={passwordAgain} onChange={(event) => setPasswordAgain(event.target.value)} required />
              </label>
              {error && <p className="welcome-sign-in-error" role="alert">{error}</p>}
              <button className="primary large welcome-sign-in-submit" type="submit" disabled={busy || recoveryCode.length !== 6}>
                {busy ? <LoaderCircle className="spin" size={22} aria-hidden="true" /> : <ShieldCheck size={22} aria-hidden="true" />}
                Neues Kennwort speichern
              </button>
              <button className="welcome-password-recovery-button" type="button" onClick={() => void requestPasswordRecovery()} disabled={busy}>
                Neuen Code senden
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

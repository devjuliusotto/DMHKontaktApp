import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowLeft, CalendarClock, Check, ChevronRight, CircleUserRound, CloudOff,
  Columns3, FileClock, KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole,
  LogOut, MonitorCog, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2, UserPlus,
  UsersRound, Wrench
} from "lucide-react";
import {
  addDirectoryGroupMember, createDirectoryGroup, createDirectoryUser, createPlannerTask,
  deleteDirectoryGroup, deleteEdvSystem, deletePlannerTask, disconnectEdvAdminSession,
  getEdvAccessProfile, getEdvAdminSessionStatus, getEdvPlannerPlanId, listDirectoryGroupMembers,
  listDirectoryGroups, listDirectoryUsers, listEdvAuditLog, listEdvSystems, loadPlannerBoard,
  removeDirectoryGroupMember,
  resetDirectoryUserPassword, saveEdvSystem, setEdvPlannerPlanId, startEdvAdminConnection,
  updateDirectoryGroup, updateDirectoryUser, updatePlannerTask
} from "../services/db";
import type {
  EdvAccessProfile, EdvAdminSessionStatus, EdvAuditEntry, EdvDirectoryGroup,
  EdvDirectoryUser, EdvSystemRecord, Microsoft365Account,
  PlannerBoard, PlannerTask, PortalModuleId
} from "../types/m365";

type EdvTab = "overview" | "tickets" | "users" | "groups" | "systems" | "audit" | "settings";

interface EdvPortalPageProps {
  account: Microsoft365Account;
  modules: PortalModuleId[];
  offline: boolean;
  refreshing: boolean;
  message: string;
  onBack: () => void;
  onRefreshAuthorization: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

const tabs: Array<{ id: EdvTab; title: string; icon: typeof Settings }> = [
  { id: "overview", title: "Übersicht", icon: LayoutDashboard },
  { id: "tickets", title: "Tickets", icon: Columns3 },
  { id: "users", title: "Benutzer", icon: CircleUserRound },
  { id: "groups", title: "Gruppen", icon: UsersRound },
  { id: "systems", title: "Systeme", icon: MonitorCog },
  { id: "audit", title: "Änderungsprotokoll", icon: FileClock },
  { id: "settings", title: "Einstellungen", icon: Settings }
];

const emptyAdminStatus: EdvAdminSessionStatus = { configured: false, connected: false, accountMatches: false, scopes: [] };

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function roleName(level?: EdvAccessProfile["level"]) {
  if (level === "identity_admin") return "Identitätsadministrator";
  if (level === "operator") return "EDV-Operator";
  return "Leseberechtigung";
}

function errorText(error: unknown) {
  return String(error).replace(/^Error:\s*/, "");
}

export function EdvPortalPage(props: EdvPortalPageProps) {
  const [tab, setTab] = useState<EdvTab>("overview");
  const [access, setAccess] = useState<EdvAccessProfile | null>(null);
  const [adminStatus, setAdminStatus] = useState<EdvAdminSessionStatus>(emptyAdminStatus);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refreshFoundation = useCallback(async () => {
    try {
      const [nextAccess, nextStatus] = await Promise.all([getEdvAccessProfile(), getEdvAdminSessionStatus()]);
      setAccess(nextAccess);
      setAdminStatus(nextStatus);
    } catch (loadError) {
      setError(errorText(loadError));
    }
  }, []);

  useEffect(() => { void refreshFoundation(); }, [refreshFoundation]);

  const connectAdmin = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      await startEdvAdminConnection();
      setNotice("Administrative Microsoft-Sitzung wurde sicher verbunden.");
      await refreshFoundation();
    } catch (connectError) { setError(errorText(connectError)); }
    finally { setBusy(false); }
  };

  const disconnectAdmin = async () => {
    await disconnectEdvAdminSession();
    setAdminStatus(emptyAdminStatus);
    setNotice("Administrative Sitzung wurde beendet.");
  };

  return (
    <main className="edv-workspace">
      <header className="edv-topbar">
        <button className="edv-back" type="button" onClick={props.onBack}><ArrowLeft size={20} /> Portalübersicht</button>
        <div className="edv-topbar-title"><span><Settings size={24} /></span><div><small>DMH PORTAL</small><strong>EDV-Verwaltung</strong></div></div>
        <div className="edv-topbar-account"><span><strong>{props.account.displayName}</strong><small>{roleName(access?.level)}</small></span><button type="button" onClick={() => void props.onSignOut()}><LogOut size={19} /> Konto wechseln</button></div>
      </header>

      <div className="edv-layout">
        <nav className="edv-nav" aria-label="EDV-Bereiche">
          {tabs.map((item) => {
            const Icon = item.icon;
            return <button className={tab === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setTab(item.id)}><Icon size={21} /><span>{item.title}</span>{tab === item.id && <ChevronRight size={17} />}</button>;
          })}
          <div className={`edv-nav-session ${adminStatus.connected ? "connected" : ""}`}>
            {adminStatus.connected ? <ShieldCheck size={20} /> : <LockKeyhole size={20} />}
            <span><strong>{adminStatus.connected ? "Admin-Sitzung aktiv" : "Admin-Sitzung gesperrt"}</strong><small>{adminStatus.connected ? "Microsoft Graph verbunden" : "Bei Bedarf separat anmelden"}</small></span>
          </div>
        </nav>

        <section className="edv-main">
          {(notice || error || props.message) && <div className={`edv-toast ${error || props.message ? "error" : "success"}`}>{error || props.message || notice}<button type="button" onClick={() => { setError(""); setNotice(""); }}>×</button></div>}
          {tab === "overview" && <Overview account={props.account} modules={props.modules} offline={props.offline} access={access} adminStatus={adminStatus} onGo={setTab} />}
          {tab === "tickets" && <ProtectedArea status={adminStatus} busy={busy} onConnect={connectAdmin}><Tickets accountId={props.account.id} access={access} onError={setError} onNotice={setNotice} /></ProtectedArea>}
          {tab === "users" && <ProtectedArea status={adminStatus} busy={busy} onConnect={connectAdmin}><Users access={access} onError={setError} onNotice={setNotice} /></ProtectedArea>}
          {tab === "groups" && <ProtectedArea status={adminStatus} busy={busy} onConnect={connectAdmin}><Groups access={access} onError={setError} onNotice={setNotice} /></ProtectedArea>}
          {tab === "systems" && <Systems access={access} onError={setError} onNotice={setNotice} />}
          {tab === "audit" && <Audit onError={setError} />}
          {tab === "settings" && <SettingsPanel {...props} access={access} adminStatus={adminStatus} busy={busy} onConnect={connectAdmin} onDisconnect={disconnectAdmin} onError={setError} onNotice={setNotice} />}
        </section>
      </div>
    </main>
  );
}

function Overview({ account, modules, offline, access, adminStatus, onGo }: { account: Microsoft365Account; modules: PortalModuleId[]; offline: boolean; access: EdvAccessProfile | null; adminStatus: EdvAdminSessionStatus; onGo: (tab: EdvTab) => void }) {
  const cards: Array<{ tab: EdvTab; icon: typeof Settings; title: string; text: string; state: string }> = [
    { tab: "tickets", icon: Columns3, title: "Tickets", text: "Kanban-Ansicht mit Microsoft Planner als unsichtbarem Backend.", state: adminStatus.connected ? "Bereit" : "Anmeldung nötig" },
    { tab: "users", icon: CircleUserRound, title: "Benutzer", text: "Konten im Microsoft Entra ID suchen und verwalten.", state: access?.canManageIdentities ? "Verwaltung" : "Lesen" },
    { tab: "groups", icon: UsersRound, title: "Gruppen", text: "Sicherheitsgruppen, Mitglieder und Portalzugriffe.", state: access?.canManageMembers ? "Verwaltung" : "Lesen" },
    { tab: "systems", icon: MonitorCog, title: "Systeme", text: "Zentrales Verzeichnis der eingesetzten Anwendungen und Dienste.", state: access?.canManageSystems ? "Bearbeiten" : "Lesen" }
  ];
  return <>
    <div className="edv-page-heading"><div><span className="edv-eyebrow"><ShieldCheck size={18} /> EDV-Zugriff bestätigt</span><h1>Guten Tag, {account.displayName.split(" ")[0]}</h1><p>Benutzer, Gruppen, Systeme und Tickets an einem verständlichen Ort.</p></div><div className={`edv-online ${offline ? "offline" : ""}`}>{offline ? <CloudOff size={21} /> : <Check size={21} />}<span><strong>{offline ? "Offline" : "Microsoft 365 verbunden"}</strong><small>{account.userPrincipalName || account.email}</small></span></div></div>
    <div className="edv-summary-row"><div><small>IHRE EDV-ROLLE</small><strong>{roleName(access?.level)}</strong></div><div><small>PORTALMODULE</small><strong>{modules.length}</strong></div><div><small>ADMIN-SITZUNG</small><strong>{adminStatus.connected ? "Aktiv" : "Gesperrt"}</strong></div></div>
    <div className="edv-feature-grid">{cards.map((card) => { const Icon = card.icon; return <button key={card.tab} type="button" onClick={() => onGo(card.tab)}><span className="edv-feature-icon"><Icon size={25} /></span><span><small>{card.state}</small><strong>{card.title}</strong><p>{card.text}</p></span><ChevronRight size={22} /></button>; })}</div>
  </>;
}

function ProtectedArea({ status, busy, onConnect, children }: { status: EdvAdminSessionStatus; busy: boolean; onConnect: () => Promise<void>; children: React.ReactNode }) {
  if (status.connected) return <>{children}</>;
  return <div className="edv-connect-card"><span className="edv-connect-icon"><KeyRound size={34} /></span><h1>Administrative Verbindung herstellen</h1><p>Dieser Bereich verwendet eine getrennte Microsoft-Sitzung. Melden Sie sich mit demselben Konto an. Berechtigungen werden weiterhin durch Ihre Entra-Administratorrolle begrenzt.</p><button className="primary" type="button" disabled={busy} onClick={() => void onConnect()}>{busy ? <LoaderCircle className="spin" size={20} /> : <ShieldCheck size={20} />} {busy ? "Microsoft-Anmeldung läuft …" : "Sicher mit Microsoft verbinden"}</button>{busy && <span className="edv-browser-wait"><LoaderCircle className="spin" size={18} /> Folgen Sie der geöffneten Microsoft-Seite. Danach geht es hier automatisch weiter.</span>}</div>;
}

function Tickets({ accountId, access, onError, onNotice }: { accountId: string; access: EdvAccessProfile | null; onError: (value: string) => void; onNotice: (value: string) => void }) {
  const [planId, setPlanId] = useState("");
  const [planDraft, setPlanDraft] = useState("");
  const [board, setBoard] = useState<PlannerBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyMine, setOnlyMine] = useState(false);
  const [newBucket, setNewBucket] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(async (id?: string) => {
    setLoading(true);
    try {
      const configured = id ?? await getEdvPlannerPlanId();
      setPlanId(configured); setPlanDraft(configured);
      setBoard(configured ? await loadPlannerBoard(configured) : null);
    } catch (loadError) { onError(errorText(loadError)); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  const savePlan = async () => {
    try { await setEdvPlannerPlanId(planDraft); setPlanId(planDraft.trim()); await load(planDraft.trim()); onNotice("Planner-Board wurde verbunden."); }
    catch (saveError) { onError(errorText(saveError)); }
  };
  const addTask = async () => {
    if (!newBucket || !newTitle.trim()) return;
    try { await createPlannerTask(planId, { title: newTitle, bucketId: newBucket, assigneeIds: [], dueDateTime: null, priority: 5 }); setNewTitle(""); setNewBucket(null); await load(planId); }
    catch (createError) { onError(errorText(createError)); }
  };
  const moveTask = async (task: PlannerTask, bucketId: string) => {
    if (task.bucketId === bucketId || !access?.canManageTickets) return;
    try { await updatePlannerTask({ id: task.id, etag: task.etag, title: task.title, bucketId, dueDateTime: task.dueDateTime, priority: task.priority, percentComplete: task.percentComplete }); await load(planId); onNotice("Ticket wurde verschoben."); }
    catch (moveError) { onError(errorText(moveError)); await load(planId); }
  };
  const removeTask = async (task: PlannerTask) => {
    if (!window.confirm(`Ticket „${task.title}“ wirklich löschen?`)) return;
    try { await deletePlannerTask(task.id, task.etag, task.title); await load(planId); }
    catch (deleteError) { onError(errorText(deleteError)); }
  };
  if (loading) return <Loading label="Tickets werden aus Microsoft Planner geladen …" />;
  if (!planId || !board) return <div className="edv-setup-card"><Columns3 size={38} /><h1>Ticket-Board verbinden</h1><p>Das Portal zeigt später nur diese Kanban-Ansicht. Der Microsoft Planner dient unsichtbar als Datenspeicher.</p><label>Planner-Plan-ID<input value={planDraft} onChange={(event) => setPlanDraft(event.target.value)} placeholder="Plan-ID aus der Planner-Adresse" /></label><button className="primary" type="button" disabled={!planDraft.trim() || !access?.canManageTickets} onClick={() => void savePlan()}><Check size={19} /> Board verbinden</button></div>;
  return <div className="edv-tickets-page"><div className="edv-section-heading"><div><span className="edv-eyebrow">TICKETS</span><h1>{board.plan.title}</h1><p>Kanban-Ansicht · automatisch mit Microsoft Planner synchronisiert</p></div><div className="edv-heading-actions"><label className="edv-toggle"><input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} /> Meine Tickets</label><button type="button" onClick={() => void load(planId)}><RefreshCw size={18} /> Aktualisieren</button></div></div><div className="kanban-board">{board.buckets.map((bucket) => {
    const tasks = board.tasks.filter((task) => task.bucketId === bucket.id).filter((task) => !onlyMine || Object.prototype.hasOwnProperty.call(task.assignments ?? {}, accountId));
    return <section className="kanban-column" key={bucket.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const id = event.dataTransfer.getData("text/plain"); const task = board.tasks.find((item) => item.id === id); if (task) void moveTask(task, bucket.id); }}><header><strong>{bucket.name}</strong><span>{tasks.length}</span></header><div className="kanban-cards">{tasks.map((task) => <article className="kanban-card" key={task.id} draggable={Boolean(access?.canManageTickets)} onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)}><div className={`kanban-priority p${task.priority}`} /><strong>{task.title}</strong><div className="kanban-meta">{task.dueDateTime && <span><CalendarClock size={15} /> {formatDate(task.dueDateTime)}</span>}{task.percentComplete === 100 && <span><Check size={15} /> Erledigt</span>}</div>{access?.canManageTickets && <footer><select aria-label="Ticket verschieben" value={task.bucketId} onChange={(event) => void moveTask(task, event.target.value)}>{board.buckets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select><button className="icon-only danger" type="button" aria-label="Ticket löschen" onClick={() => void removeTask(task)}><Trash2 size={16} /></button></footer>}</article>)}</div>{access?.canManageTickets && (newBucket === bucket.id ? <div className="kanban-add"><textarea autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Titel des Tickets" /><div><button type="button" onClick={() => { setNewBucket(null); setNewTitle(""); }}>Abbrechen</button><button className="primary" type="button" onClick={() => void addTask()}>Hinzufügen</button></div></div> : <button className="kanban-add-button" type="button" onClick={() => setNewBucket(bucket.id)}><Plus size={18} /> Ticket hinzufügen</button>)}</section>;
  })}</div></div>;
}

function Users({ access, onError, onNotice }: { access: EdvAccessProfile | null; onError: (value: string) => void; onNotice: (value: string) => void }) {
  const [users, setUsers] = useState<EdvDirectoryUser[]>([]); const [search, setSearch] = useState(""); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState<EdvDirectoryUser | "new" | null>(null);
  const load = useCallback(async () => { setLoading(true); try { setUsers(await listDirectoryUsers()); } catch (e) { onError(errorText(e)); } finally { setLoading(false); } }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => users.filter((user) => `${user.displayName} ${user.userPrincipalName} ${user.department}`.toLowerCase().includes(search.toLowerCase())), [users, search]);
  const resetPassword = async (user: EdvDirectoryUser) => { const password = window.prompt(`Temporäres Kennwort für ${user.displayName}:`); if (!password) return; if (!window.confirm("Das Kennwort wird sofort ersetzt und muss bei der nächsten Anmeldung geändert werden. Fortfahren?")) return; try { await resetDirectoryUserPassword(user.id, user.displayName, password); onNotice("Temporäres Kennwort wurde gesetzt."); } catch (e) { onError(errorText(e)); } };
  return <div><DirectoryHeading eyebrow="MICROSOFT ENTRA ID" title="Benutzer" description={`${users.length} Konten geladen`} search={search} onSearch={setSearch} action={access?.canManageIdentities ? <button className="primary" type="button" onClick={() => setEditing("new")}><UserPlus size={19} /> Benutzer anlegen</button> : null} onReload={load} />{loading ? <Loading label="Benutzer werden geladen …" /> : <div className="edv-table-wrap"><table className="edv-data-table"><thead><tr><th>Benutzer</th><th>Abteilung</th><th>Status</th><th>Rolle</th><th /></tr></thead><tbody>{visible.map((user) => <tr key={user.id}><td><span className="edv-person"><b>{user.displayName.slice(0, 2).toUpperCase()}</b><span><strong>{user.displayName}</strong><small>{user.userPrincipalName}</small></span></span></td><td>{user.department || "—"}</td><td><span className={`edv-status-pill ${user.accountEnabled === false ? "disabled" : "active"}`}>{user.accountEnabled === false ? "Gesperrt" : "Aktiv"}</span></td><td>{user.jobTitle || "—"}</td><td>{access?.canManageIdentities && <div className="edv-row-actions"><button type="button" onClick={() => setEditing(user)}>Bearbeiten</button><button type="button" onClick={() => void resetPassword(user)}><KeyRound size={16} /> Kennwort</button></div>}</td></tr>)}</tbody></table></div>}{editing && <UserEditor user={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); onNotice("Benutzer wurde gespeichert."); }} onError={onError} />}</div>;
}

function UserEditor({ user, onClose, onSaved, onError }: { user: EdvDirectoryUser | "new"; onClose: () => void; onSaved: () => Promise<void>; onError: (value: string) => void }) {
  const current = user === "new" ? null : user; const [name, setName] = useState(current?.displayName ?? ""); const [upn, setUpn] = useState(""); const [password, setPassword] = useState(""); const [department, setDepartment] = useState(current?.department ?? ""); const [jobTitle, setJobTitle] = useState(current?.jobTitle ?? ""); const [mobilePhone, setMobilePhone] = useState(current?.mobilePhone ?? ""); const [enabled, setEnabled] = useState(current?.accountEnabled !== false); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { if (current) await updateDirectoryUser({ id: current.id, displayName: name, accountEnabled: enabled, department, jobTitle, mobilePhone }); else await createDirectoryUser({ displayName: name, userPrincipalName: upn, initialPassword: password, department, jobTitle }); await onSaved(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } };
  return <div className="edv-modal-backdrop" role="presentation"><form className="edv-modal" onSubmit={(event) => { event.preventDefault(); void save(); }}><header><div><small>MICROSOFT ENTRA ID</small><h2>{current ? "Benutzer bearbeiten" : "Benutzer anlegen"}</h2></div><button type="button" onClick={onClose}>×</button></header><label>Anzeigename<input required value={name} onChange={(e) => setName(e.target.value)} /></label>{!current && <><label>Microsoft-Benutzername<input required type="email" value={upn} onChange={(e) => setUpn(e.target.value)} placeholder="name@dmh-aidlingen.de" /></label><label>Temporäres Kennwort<input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label></>}<div className="edv-form-grid"><label>Abteilung<input value={department} onChange={(e) => setDepartment(e.target.value)} /></label><label>Funktion<input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} /></label></div>{current && <><label>Mobiltelefon<input value={mobilePhone} onChange={(e) => setMobilePhone(e.target.value)} /></label><label className="edv-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Konto ist aktiviert</label></>}<footer><button type="button" onClick={onClose}>Abbrechen</button><button className="primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={18} />} Speichern</button></footer></form></div>;
}

function Groups({ access, onError, onNotice }: { access: EdvAccessProfile | null; onError: (value: string) => void; onNotice: (value: string) => void }) {
  const [groups, setGroups] = useState<EdvDirectoryGroup[]>([]); const [users, setUsers] = useState<EdvDirectoryUser[]>([]); const [members, setMembers] = useState<EdvDirectoryUser[]>([]); const [selected, setSelected] = useState<EdvDirectoryGroup | null>(null); const [search, setSearch] = useState(""); const [loading, setLoading] = useState(true); const [addUser, setAddUser] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const [nextGroups, nextUsers] = await Promise.all([listDirectoryGroups(), listDirectoryUsers()]); setGroups(nextGroups); setUsers(nextUsers); } catch (e) { onError(errorText(e)); } finally { setLoading(false); } }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const openGroup = async (group: EdvDirectoryGroup) => { setSelected(group); try { setMembers(await listDirectoryGroupMembers(group.id)); } catch (e) { onError(errorText(e)); } };
  const add = async () => { const user = users.find((item) => item.id === addUser); if (!selected || !user) return; try { await addDirectoryGroupMember(selected.id, user.id, user.displayName); setMembers(await listDirectoryGroupMembers(selected.id)); setAddUser(""); onNotice("Mitglied wurde hinzugefügt."); } catch (e) { onError(errorText(e)); } };
  const remove = async (user: EdvDirectoryUser) => { if (!selected || !window.confirm(`${user.displayName} aus ${selected.displayName} entfernen?`)) return; try { await removeDirectoryGroupMember(selected.id, user.id, user.displayName); setMembers(await listDirectoryGroupMembers(selected.id)); } catch (e) { onError(errorText(e)); } };
  const create = async () => { const name = window.prompt("Name der neuen Sicherheitsgruppe:"); if (!name) return; try { await createDirectoryGroup({ displayName: name, description: "Über DMH Portal erstellt" }); await load(); onNotice("Sicherheitsgruppe wurde erstellt."); } catch (e) { onError(errorText(e)); } };
  const rename = async () => { if (!selected) return; const name = window.prompt("Neuer Gruppenname:", selected.displayName); if (!name) return; try { await updateDirectoryGroup({ id: selected.id, displayName: name, description: selected.description }); setSelected(null); await load(); } catch (e) { onError(errorText(e)); } };
  const destroy = async () => { if (!selected || !window.confirm(`Gruppe „${selected.displayName}“ wirklich aus Microsoft Entra löschen?`)) return; try { await deleteDirectoryGroup(selected.id, selected.displayName); setSelected(null); await load(); } catch (e) { onError(errorText(e)); } };
  const visible = groups.filter((group) => group.displayName.toLowerCase().includes(search.toLowerCase()));
  return <div><DirectoryHeading eyebrow="MICROSOFT ENTRA ID" title="Gruppen & Berechtigungen" description={`${groups.length} Gruppen geladen`} search={search} onSearch={setSearch} action={access?.canManageIdentities ? <button className="primary" type="button" onClick={() => void create()}><Plus size={19} /> Sicherheitsgruppe</button> : null} onReload={load} />{loading ? <Loading label="Gruppen werden geladen …" /> : <div className="edv-group-layout"><div className="edv-group-list">{visible.map((group) => <button className={selected?.id === group.id ? "active" : ""} type="button" key={group.id} onClick={() => void openGroup(group)}><span className="edv-group-icon"><UsersRound size={20} /></span><span><strong>{group.displayName}</strong><small>{group.securityEnabled ? "Sicherheitsgruppe" : group.groupTypes.includes("Unified") ? "Microsoft 365" : "Gruppe"}</small></span><ChevronRight size={18} /></button>)}</div><aside className="edv-group-detail">{selected ? <><header><div><small>GRUPPE</small><h2>{selected.displayName}</h2><p>{selected.description || "Keine Beschreibung"}</p></div>{access?.canManageIdentities && <div><button type="button" onClick={() => void rename()}>Bearbeiten</button><button className="danger" type="button" onClick={() => void destroy()}><Trash2 size={17} /></button></div>}</header><h3>Mitglieder ({members.length})</h3>{access?.canManageMembers && <div className="edv-member-add"><select value={addUser} onChange={(e) => setAddUser(e.target.value)}><option value="">Benutzer auswählen …</option>{users.filter((user) => !members.some((member) => member.id === user.id)).map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><button className="primary" type="button" disabled={!addUser} onClick={() => void add()}><Plus size={18} /> Hinzufügen</button></div>}<div className="edv-member-list">{members.map((member) => <div key={member.id}><span className="edv-person"><b>{member.displayName.slice(0, 2).toUpperCase()}</b><span><strong>{member.displayName}</strong><small>{member.userPrincipalName}</small></span></span>{access?.canManageMembers && <button className="icon-only danger" type="button" aria-label="Mitglied entfernen" onClick={() => void remove(member)}><Trash2 size={17} /></button>}</div>)}</div></> : <div className="edv-empty"><UsersRound size={36} /><strong>Gruppe auswählen</strong><p>Danach sehen Sie Mitglieder und Berechtigungen.</p></div>}</aside></div>}</div>;
}

function Systems({ access, onError, onNotice }: { access: EdvAccessProfile | null; onError: (value: string) => void; onNotice: (value: string) => void }) {
  const [systems, setSystems] = useState<EdvSystemRecord[]>([]); const [editing, setEditing] = useState<EdvSystemRecord | "new" | null>(null); const [search, setSearch] = useState("");
  const load = useCallback(async () => { try { setSystems(await listEdvSystems()); } catch (e) { onError(errorText(e)); } }, [onError]); useEffect(() => { void load(); }, [load]);
  const remove = async (system: EdvSystemRecord) => { if (!window.confirm(`System „${system.name}“ löschen?`)) return; try { await deleteEdvSystem(system.id, system.name); await load(); } catch (e) { onError(errorText(e)); } };
  const visible = systems.filter((item) => `${item.name} ${item.category} ${item.owner} ${item.provider}`.toLowerCase().includes(search.toLowerCase()));
  return <div><DirectoryHeading eyebrow="INVENTAR" title="Systeme & Dienste" description={`${systems.length} Einträge`} search={search} onSearch={setSearch} action={access?.canManageSystems ? <button className="primary" type="button" onClick={() => setEditing("new")}><Plus size={19} /> System erfassen</button> : null} onReload={load} /><div className="edv-system-grid">{visible.map((system) => <article key={system.id}><header><span><MonitorCog size={22} /></span><span className={`edv-status-pill ${system.status === "active" ? "active" : "disabled"}`}>{system.status === "active" ? "Aktiv" : system.status}</span></header><small>{system.category || "System"}</small><h3>{system.name}</h3><dl><div><dt>Verantwortlich</dt><dd>{system.owner || "—"}</dd></div><div><dt>Anbieter</dt><dd>{system.provider || "—"}</dd></div></dl>{access?.canManageSystems && <footer><button type="button" onClick={() => setEditing(system)}>Bearbeiten</button><button className="icon-only danger" type="button" onClick={() => void remove(system)}><Trash2 size={17} /></button></footer>}</article>)}</div>{editing && <SystemEditor system={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); onNotice("Systeminventar wurde gespeichert."); }} onError={onError} />}</div>;
}

function SystemEditor({ system, onClose, onSaved, onError }: { system: EdvSystemRecord | "new"; onClose: () => void; onSaved: () => Promise<void>; onError: (value: string) => void }) {
  const current = system === "new" ? null : system; const [form, setForm] = useState({ name: current?.name ?? "", category: current?.category ?? "", owner: current?.owner ?? "", status: current?.status ?? "active", provider: current?.provider ?? "", url: current?.url ?? "", notes: current?.notes ?? "" }); const update = (key: keyof typeof form, value: string) => setForm((old) => ({ ...old, [key]: value }));
  return <div className="edv-modal-backdrop"><form className="edv-modal" onSubmit={(e) => { e.preventDefault(); void saveEdvSystem({ id: current?.id, ...form }).then(onSaved).catch((err) => onError(errorText(err))); }}><header><div><small>INVENTAR</small><h2>{current ? "System bearbeiten" : "System erfassen"}</h2></div><button type="button" onClick={onClose}>×</button></header><label>Name<input required value={form.name} onChange={(e) => update("name", e.target.value)} /></label><div className="edv-form-grid"><label>Kategorie<input value={form.category} onChange={(e) => update("category", e.target.value)} /></label><label>Status<select value={form.status} onChange={(e) => update("status", e.target.value)}><option value="active">Aktiv</option><option value="planned">Geplant</option><option value="retired">Stillgelegt</option></select></label><label>Verantwortlich<input value={form.owner} onChange={(e) => update("owner", e.target.value)} /></label><label>Anbieter<input value={form.provider} onChange={(e) => update("provider", e.target.value)} /></label></div><label>Webadresse<input value={form.url} onChange={(e) => update("url", e.target.value)} /></label><label>Notizen<textarea value={form.notes} onChange={(e) => update("notes", e.target.value)} /></label><footer><button type="button" onClick={onClose}>Abbrechen</button><button className="primary" type="submit">Speichern</button></footer></form></div>;
}

function Audit({ onError }: { onError: (value: string) => void }) {
  const [entries, setEntries] = useState<EdvAuditEntry[]>([]); const [loading, setLoading] = useState(true); const load = useCallback(async () => { setLoading(true); try { setEntries(await listEdvAuditLog()); } catch (e) { onError(errorText(e)); } finally { setLoading(false); } }, [onError]); useEffect(() => { void load(); }, [load]);
  return <div><DirectoryHeading eyebrow="NACHVOLLZIEHBARKEIT" title="Änderungsprotokoll" description="Die letzten 500 Änderungen auf diesem Gerät" search="" onSearch={() => undefined} onReload={load} />{loading ? <Loading label="Protokoll wird geladen …" /> : <div className="edv-timeline">{entries.length ? entries.map((entry) => <article key={entry.id}><span className="edv-timeline-icon"><Activity size={18} /></span><div><header><strong>{entry.details}</strong><time>{new Date(entry.occurredAt).toLocaleString("de-DE")}</time></header><p><b>{entry.actorName}</b> · {entry.targetType}: {entry.targetName || entry.targetId}</p></div></article>) : <div className="edv-empty"><FileClock size={36} /><strong>Noch keine Änderungen</strong><p>Administrative Aktionen erscheinen automatisch hier.</p></div>}</div>}</div>;
}

function SettingsPanel(props: EdvPortalPageProps & { access: EdvAccessProfile | null; adminStatus: EdvAdminSessionStatus; busy: boolean; onConnect: () => Promise<void>; onDisconnect: () => Promise<void>; onError: (value: string) => void; onNotice: (value: string) => void }) {
  return <div><div className="edv-section-heading"><div><span className="edv-eyebrow">PORTALKONFIGURATION</span><h1>Einstellungen</h1><p>Sicherheitsstatus und Verbindungen des EDV-Moduls.</p></div></div><div className="edv-settings-grid"><article><header><ShieldCheck size={24} /><div><h3>Ihre EDV-Rolle</h3><p>{roleName(props.access?.level)}</p></div></header><ul><li className={props.access?.canManageTickets ? "yes" : "no"}>Tickets bearbeiten</li><li className={props.access?.canManageSystems ? "yes" : "no"}>Systeme bearbeiten</li><li className={props.access?.canManageMembers ? "yes" : "no"}>Gruppenmitglieder ändern</li><li className={props.access?.canManageIdentities ? "yes" : "no"}>Benutzer und Gruppen verwalten</li></ul></article><article><header><KeyRound size={24} /><div><h3>Administrative Sitzung</h3><p>{props.adminStatus.connected ? "Sicher verbunden" : props.busy ? "Microsoft-Anmeldung läuft …" : "Nicht verbunden"}</p></div></header>{props.adminStatus.connected ? <button type="button" onClick={() => void props.onDisconnect()}><LogOut size={18} /> Admin-Sitzung beenden</button> : <button className="primary" type="button" disabled={props.busy} onClick={() => void props.onConnect()}>{props.busy ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />} {props.busy ? "Bitte im Browser fortfahren" : "Microsoft verbinden"}</button>}</article><article><header><RefreshCw size={24} /><div><h3>Portalgruppen</h3><p>Zugriffe erneut aus Entra laden</p></div></header><button type="button" disabled={props.offline || props.refreshing} onClick={() => void props.onRefreshAuthorization()}><RefreshCw className={props.refreshing ? "spin" : ""} size={18} /> Gruppen erneut prüfen</button></article><article><header><Wrench size={24} /><div><h3>Zentrale Konfiguration</h3><p>Nächster Cloud-Ausbauschritt</p></div></header><p>Plan-ID und Inventar sind derzeit lokal gespeichert. Die spätere SharePoint-Liste kann ohne Änderung an Entra und Planner ergänzt werden.</p></article></div></div>;
}

function DirectoryHeading({ eyebrow, title, description, search, onSearch, action, onReload }: { eyebrow: string; title: string; description: string; search: string; onSearch: (value: string) => void; action?: React.ReactNode; onReload: () => Promise<void> }) {
  return <><div className="edv-section-heading"><div><span className="edv-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><div className="edv-heading-actions">{action}<button type="button" onClick={() => void onReload()}><RefreshCw size={18} /> Aktualisieren</button></div></div>{onSearch.toString() !== (() => undefined).toString() && <label className="edv-search"><Search size={19} /><input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={`${title} durchsuchen …`} /></label>}</>;
}

function Loading({ label }: { label: string }) {
  return <div className="edv-loading"><LoaderCircle className="spin" size={27} /><p>{label}</p></div>;
}

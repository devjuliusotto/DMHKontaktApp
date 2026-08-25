import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Cloud, Download, ExternalLink, File, Folder, FolderOpen, FolderPlus, HardDrive, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Page } from "../components/Sidebar";
import { createDocumentFolder, deleteDocumentItem, downloadDocumentItem, getDocumentsLocalRoot, getMicrosoft365ConnectionStatus, listDocumentItems, listDocumentSources, renameDocumentItem, uploadDocumentFile, uploadDocumentRevision } from "../services/db";
import type { DocumentItem, DocumentSource } from "../types/documents";

interface DocumentsPageProps {
  onNavigate: (page: Page) => void;
}

interface Breadcrumb { id?: string; name: string; webUrl?: string }

const documentSourceCacheTtl = 5 * 60 * 1000;
let documentSourceCache: { accountId: string; sources: DocumentSource[]; cachedAt: number } | null = null;

function sortDocumentSources(sources: DocumentSource[]) {
  return [...sources].sort((left, right) => left.kind.localeCompare(right.kind)
    || left.siteName.localeCompare(right.siteName, "de")
    || left.name.localeCompare(right.name, "de"));
}

function cacheDocumentSources(accountId: string, sources: DocumentSource[]) {
  documentSourceCache = { accountId, sources, cachedAt: Date.now() };
}

export function DocumentsPage({ onNavigate }: DocumentsPageProps) {
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [source, setSource] = useState<DocumentSource | null>(null);
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const parentId = breadcrumbs[breadcrumbs.length - 1]?.id;
  const groupedSources = useMemo(() => ({
    oneDrive: sources.filter((item) => item.kind === "onedrive"),
    sharePoint: sources.filter((item) => item.kind === "sharepoint")
  }), [sources]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de-DE");
    return query ? items.filter((item) => item.name.toLocaleLowerCase("de-DE").includes(query)) : items;
  }, [items, search]);

  const loadItems = async (nextSource: DocumentSource, nextParentId?: string) => {
    setBusy(true); setError(""); setMenuItemId(null);
    try { setItems(await listDocumentItems(nextSource.id, nextParentId)); }
    catch (loadError) { setError(String(loadError)); }
    finally { setBusy(false); }
  };

  const selectSource = async (next: DocumentSource) => {
    setSource(next);
    setBreadcrumbs([{ name: next.siteName || next.name, webUrl: next.webUrl }]);
    setSearch("");
    await loadItems(next);
  };

  const loadSharePointSources = async (accountId: string, selectFirst: boolean) => {
    setSourcesLoading(true);
    setSourcesError("");
    try {
      const sharePointSources = await listDocumentSources("sharepoint");
      setSources((current) => {
        const next = sortDocumentSources([
          ...current.filter((item) => item.kind !== "sharepoint"),
          ...sharePointSources
        ]);
        cacheDocumentSources(accountId, next);
        return next;
      });
      if (selectFirst && sharePointSources.length > 0) await selectSource(sharePointSources[0]);
    } catch (loadError) {
      setSourcesError(`SharePoint konnte nicht geladen werden: ${String(loadError)}`);
    } finally {
      setSourcesLoading(false);
    }
  };

  const loadSources = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const status = await getMicrosoft365ConnectionStatus();
      setConnected(status.connected);
      if (!status.connected || !status.account) {
        documentSourceCache = null;
        return;
      }
      const accountId = status.account.id;

      const cached = documentSourceCache
        && documentSourceCache.accountId === accountId
        && Date.now() - documentSourceCache.cachedAt < documentSourceCacheTtl
        ? documentSourceCache.sources
        : [];
      if (cached.length > 0) {
        setSources(cached);
        const sharePointPromise = loadSharePointSources(accountId, false);
        await selectSource(cached[0]);
        void sharePointPromise;
        return;
      }

      const oneDriveSources = await listDocumentSources("onedrive");
      setSources(oneDriveSources);
      cacheDocumentSources(accountId, oneDriveSources);
      const sharePointPromise = loadSharePointSources(accountId, oneDriveSources.length === 0);
      if (oneDriveSources.length > 0) await selectSource(oneDriveSources[0]);
      void sharePointPromise;
    } catch (loadError) {
      setError(String(loadError));
    } finally { setBusy(false); }
  };

  useEffect(() => { void loadSources(); }, []);

  const openFolder = async (item: DocumentItem) => {
    if (!source) return;
    setBreadcrumbs((current) => [...current, { id: item.id, name: item.name, webUrl: item.webUrl }]);
    setSearch("");
    await loadItems(source, item.id);
  };

  const navigateBreadcrumb = async (index: number) => {
    if (!source) return;
    const next = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(next);
    setSearch("");
    await loadItems(source, next[next.length - 1]?.id);
  };

  const createFolder = async () => {
    if (!source) return;
    const name = window.prompt("Name des neuen Ordners:")?.trim();
    if (!name) return;
    setBusy(true); setError("");
    try {
      await createDocumentFolder({ driveId: source.id, parentId, name });
      await loadItems(source, parentId);
      setMessage(`Ordner „${name}“ wurde erstellt.`);
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const renameItem = async (item: DocumentItem) => {
    if (!source) return;
    const name = window.prompt("Neuer Name:", item.name)?.trim();
    if (!name || name === item.name) return;
    setBusy(true); setError("");
    try {
      await renameDocumentItem({ driveId: source.id, itemId: item.id, name });
      await loadItems(source, parentId);
      setMessage("Element wurde umbenannt.");
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const removeItem = async (item: DocumentItem) => {
    if (!source || !window.confirm(`„${item.name}“ in den Microsoft-365-Papierkorb verschieben?`)) return;
    setBusy(true); setError("");
    try {
      await deleteDocumentItem(source.id, item.id);
      await loadItems(source, parentId);
      setMessage("Element wurde in den Papierkorb verschoben.");
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const downloadItem = async (item: DocumentItem) => {
    if (!source || item.isFolder) return;
    setBusy(true); setError("");
    try {
      const relativePath = [source.siteName || source.name, ...breadcrumbs.slice(1).map((crumb) => crumb.name)];
      const path = await downloadDocumentItem(source.id, item.id, item.name, relativePath, item.eTag);
      setMessage(`Offline gespeichert: ${path}`);
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const uploadLocalRevision = async (item: DocumentItem) => {
    if (!source || !item.offlineAvailable || !item.localPath) return;
    if (!window.confirm(`Lokale Änderungen an „${item.name}“ nach Microsoft 365 hochladen?\n\nWenn die Online-Datei inzwischen geändert wurde, wird nichts überschrieben und ein Konflikt angezeigt.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await uploadDocumentRevision(source.id, item.id, item.localPath, item.offlineETag);
      await loadItems(source, parentId);
      setMessage("Die lokale Version wurde sicher nach Microsoft 365 hochgeladen.");
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const uploadFiles = async () => {
    if (!source) return;
    const selected = await open({ multiple: true, directory: false, title: "Dateien in Microsoft 365 hochladen" });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setBusy(true); setError(""); setMessage("");
    let uploaded = 0;
    try {
      for (const path of paths) {
        await uploadDocumentFile(source.id, parentId, path);
        uploaded += 1;
      }
      await loadItems(source, parentId);
      setMessage(`${uploaded} ${uploaded === 1 ? "Datei wurde" : "Dateien wurden"} hochgeladen.`);
    } catch (actionError) {
      setError(uploaded > 0 ? `${uploaded} Datei(en) hochgeladen. Danach trat ein Fehler auf: ${String(actionError)}` : String(actionError));
    } finally { setBusy(false); }
  };

  const openLocalFolder = async () => {
    try { await openPath(await getDocumentsLocalRoot()); }
    catch (actionError) { setError(String(actionError)); }
  };

  if (connected === false) return (
    <div className="page documents-page documents-empty-state">
      <Cloud size={52} />
      <h2>Dokumente</h2>
      <p>Verbinden Sie zuerst Ihr Microsoft-365-Konto. Danach erscheinen OneDrive und freigegebene SharePoint-Bibliotheken automatisch.</p>
      <button className="primary large" type="button" onClick={() => onNavigate("m365")}>Microsoft 365 verbinden</button>
    </div>
  );

  return (
    <div className="page documents-page">
      <header className="documents-header">
        <div><h2>Dokumente</h2><p>OneDrive und SharePoint – entsprechend Ihren Berechtigungen.</p></div>
        <div className="button-row">
          <button type="button" onClick={openLocalFolder}><FolderOpen size={18} /> Lokaler Ordner</button>
          <button type="button" onClick={() => source && loadItems(source, parentId)} disabled={busy || !source}><RefreshCw size={18} /> Aktualisieren</button>
          <button type="button" onClick={uploadFiles} disabled={busy || !source}><Upload size={18} /> Hochladen</button>
          <button className="primary" type="button" onClick={createFolder} disabled={busy || !source}><FolderPlus size={18} /> Neuer Ordner</button>
        </div>
      </header>
      {error && <div className="status-message error">{error}</div>}
      {message && <div className="status-message success">{message}</div>}
      <div className="documents-layout">
        <aside className="documents-sources">
          <h3><HardDrive size={18} /> Speicherorte</h3>
          {groupedSources.oneDrive.map((item) => <button className={source?.id === item.id ? "active" : ""} type="button" key={item.id} onClick={() => selectSource(item)} title={item.name}><Cloud size={18} /><span><strong>Mein OneDrive</strong><small>{item.name}</small></span></button>)}
          {sourcesLoading && <p className="documents-sources-loading"><LoaderCircle className="spin" size={17} /> SharePoint wird geladen …</p>}
          {sourcesError && <p className="documents-sources-error">{sourcesError}</p>}
          {groupedSources.sharePoint.length > 0 && <h4>SharePoint</h4>}
          {groupedSources.sharePoint.map((item) => <button className={source?.id === item.id ? "active" : ""} type="button" key={item.id} onClick={() => selectSource(item)} title={`${item.siteName} – ${item.name}`}><Folder size={18} /><span><strong>{item.siteName}</strong><small>{item.name}</small></span></button>)}
          {!busy && !sourcesLoading && sources.length === 0 && <p className="documents-no-sources">Keine zugänglichen Speicherorte gefunden.</p>}
        </aside>
        <section className="documents-browser">
          <nav className="documents-breadcrumbs" aria-label="Ordnerpfad">
            {breadcrumbs.map((crumb, index) => <button type="button" key={`${crumb.id ?? "root"}-${index}`} onClick={() => navigateBreadcrumb(index)}>{crumb.name}</button>)}
            {breadcrumbs[breadcrumbs.length - 1]?.webUrl && <button className="documents-open-online" type="button" onClick={() => openUrl(breadcrumbs[breadcrumbs.length - 1].webUrl!)}><ExternalLink size={15} /> Online öffnen</button>}
          </nav>
          {source && <label className="documents-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="In diesem Ordner suchen" aria-label="Dokumente in diesem Ordner suchen" /></label>}
          {busy ? <div className="documents-loading"><LoaderCircle className="spin" size={30} /> Dokumente werden geladen …</div> : (
            <div className="documents-table" role="table">
              <div className="documents-row heading" role="row"><span>Name</span><span>Geändert</span><span>Geändert von</span><span>Größe</span><span /></div>
              {visibleItems.map((item) => (
                <div className="documents-row" role="row" key={item.id}>
                  <button className="documents-name" type="button" onClick={() => item.isFolder ? openFolder(item) : openUrl(item.webUrl)}>{item.isFolder ? <Folder size={21} /> : <File size={21} />}<span>{item.name}{item.offlineAvailable && <small className={item.offlineOutdated ? "outdated" : ""}>{item.offlineOutdated ? "Online-Version ist neuer" : "Offline verfügbar"}</small>}</span></button>
                  <span>{formatDate(item.lastModifiedAt)}</span><span>{item.modifiedBy || "–"}</span><span>{item.isFolder ? "–" : formatSize(item.size)}</span>
                  <div className="documents-menu-wrap">
                    <button className="icon-only compact" type="button" aria-label={`Aktionen für ${item.name}`} onClick={() => setMenuItemId((current) => current === item.id ? null : item.id)}><MoreHorizontal size={18} /></button>
                    {menuItemId === item.id && <div className="documents-menu">
                      {!item.isFolder && <button type="button" onClick={() => downloadItem(item)}><Download size={17} /> {item.offlineAvailable ? "Offline-Version aktualisieren" : "Offline speichern"}</button>}
                      {item.offlineAvailable && <button type="button" onClick={() => openPath(item.localPath)}><FolderOpen size={17} /> Lokale Datei öffnen</button>}
                      {item.offlineAvailable && <button type="button" onClick={() => uploadLocalRevision(item)}><Upload size={17} /> Lokale Änderung hochladen</button>}
                      <button type="button" onClick={() => openUrl(item.webUrl)}><ExternalLink size={17} /> Im Browser öffnen</button>
                      <button type="button" onClick={() => renameItem(item)}><Pencil size={17} /> Umbenennen</button>
                      <button className="danger" type="button" onClick={() => removeItem(item)}><Trash2 size={17} /> Löschen</button>
                    </div>}
                  </div>
                </div>
              ))}
              {items.length === 0 && <div className="documents-no-items">Dieser Ordner ist leer.</div>}
              {items.length > 0 && visibleItems.length === 0 && <div className="documents-no-items">Keine passenden Dokumente gefunden.</div>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(value: string) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

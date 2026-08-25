import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle, ArrowUp, CheckCircle2, CheckSquare, ChevronDown, ChevronRight, ClipboardPaste, Cloud, Copy, Download,
  ExternalLink, File, FilePlus2, Folder, FolderOpen, FolderPlus, Grid2X2, HardDrive,
  History, List, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Scissors, Search,
  Share2, Trash2, Upload, UploadCloud, X
} from "lucide-react";
import { DragEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Page } from "../components/Sidebar";
import {
  copyDocumentItems, createDocumentFolder, createDocumentShareLink, createDocumentTextFile,
  deleteDocumentItem, downloadDocumentItem, getDocumentsLocalRoot,
  getMicrosoft365ConnectionStatus, listDocumentItems, listDocumentSources,
  listDocumentVersions, moveDocumentItems, renameDocumentItem, restoreDocumentVersion,
  uploadDocumentPath, uploadDocumentRevision, listDocumentSyncConflicts,
  resolveDocumentSyncConflict, syncOfflineDocuments, makeDocumentFolderOffline
} from "../services/db";
import type { DocumentConflictDecision, DocumentItem, DocumentSource, DocumentSyncConflict, DocumentSyncSummary, DocumentVersion } from "../types/documents";

interface DocumentsPageProps { onNavigate: (page: Page) => void }
interface Breadcrumb { id?: string; name: string; webUrl?: string }
interface DocumentClipboard { operation: "copy" | "cut"; driveId: string; items: Array<Pick<DocumentItem, "id" | "name" | "isFolder">> }
interface DocumentsContextMenuState { x: number; y: number; itemId?: string }
type DocumentView = "list" | "grid";
type SortKey = "name" | "modified" | "size";

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
  const [contextMenu, setContextMenu] = useState<DocumentsContextMenuState | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<DocumentClipboard | null>(null);
  const [view, setView] = useState<DocumentView>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAscending, setSortAscending] = useState(true);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [externalDrag, setExternalDrag] = useState(false);
  const [versionsItem, setVersionsItem] = useState<DocumentItem | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<DocumentSyncSummary | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<DocumentSyncConflict[]>([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);
  const initialSyncStarted = useRef(false);

  const parentId = breadcrumbs[breadcrumbs.length - 1]?.id;
  const currentBreadcrumb = breadcrumbs[breadcrumbs.length - 1];
  const groupedSources = useMemo(() => ({
    oneDrive: sources.filter((item) => item.kind === "onedrive"),
    sharePoint: sources.filter((item) => item.kind === "sharepoint")
  }), [sources]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de-DE");
    const filtered = query ? items.filter((item) => item.name.toLocaleLowerCase("de-DE").includes(query)) : items;
    return [...filtered].sort((left, right) => {
      const folders = Number(right.isFolder) - Number(left.isFolder);
      if (folders) return folders;
      const value = sortKey === "name" ? left.name.localeCompare(right.name, "de", { numeric: true })
        : sortKey === "modified" ? left.lastModifiedAt.localeCompare(right.lastModifiedAt) : left.size - right.size;
      return sortAscending ? value : -value;
    });
  }, [items, search, sortAscending, sortKey]);
  const selectedItems = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds]);
  const contextMenuItems = useMemo(() => {
    const itemId = contextMenu?.itemId;
    if (!itemId) return [];
    if (selectedIds.has(itemId)) return selectedItems;
    const item = items.find((entry) => entry.id === itemId);
    return item ? [item] : [];
  }, [contextMenu?.itemId, items, selectedIds, selectedItems]);

  const loadItems = useCallback(async (nextSource: DocumentSource, nextParentId?: string) => {
    setBusy(true); setError(""); setMenuItemId(null);
    try { setItems(await listDocumentItems(nextSource.id, nextParentId)); setSelectedIds(new Set()); }
    catch (loadError) { setError(String(loadError)); }
    finally { setBusy(false); }
  }, []);

  const selectSource = useCallback(async (next: DocumentSource) => {
    setSource(next); setBreadcrumbs([{ name: next.siteName || next.name, webUrl: next.webUrl }]);
    setSearch(""); setMessage(""); await loadItems(next);
  }, [loadItems]);

  const loadSharePointSources = useCallback(async (accountId: string, selectFirst: boolean) => {
    setSourcesLoading(true); setSourcesError("");
    try {
      const sharePointSources = await listDocumentSources("sharepoint");
      setSources((current) => {
        const next = sortDocumentSources([...current.filter((item) => item.kind !== "sharepoint"), ...sharePointSources]);
        cacheDocumentSources(accountId, next); return next;
      });
      if (selectFirst && sharePointSources.length > 0) await selectSource(sharePointSources[0]);
    } catch (loadError) { setSourcesError(`SharePoint konnte nicht geladen werden: ${String(loadError)}`); }
    finally { setSourcesLoading(false); }
  }, [selectSource]);

  const loadSources = useCallback(async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const status = await getMicrosoft365ConnectionStatus(); setConnected(status.connected);
      if (!status.connected || !status.account) { documentSourceCache = null; return; }
      const accountId = status.account.id;
      const cached = documentSourceCache && documentSourceCache.accountId === accountId
        && Date.now() - documentSourceCache.cachedAt < documentSourceCacheTtl ? documentSourceCache.sources : [];
      if (cached.length > 0) {
        setSources(cached); const sharePointPromise = loadSharePointSources(accountId, false);
        await selectSource(cached[0]); void sharePointPromise; return;
      }
      const oneDriveSources = await listDocumentSources("onedrive");
      setSources(oneDriveSources); cacheDocumentSources(accountId, oneDriveSources);
      const sharePointPromise = loadSharePointSources(accountId, oneDriveSources.length === 0);
      if (oneDriveSources.length > 0) await selectSource(oneDriveSources[0]); void sharePointPromise;
    } catch (loadError) { setError(String(loadError)); }
    finally { setBusy(false); }
  }, [loadSharePointSources, selectSource]);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const refreshSyncConflicts = useCallback(async () => {
    try { setSyncConflicts(await listDocumentSyncConflicts()); }
    catch { /* The app may currently be running without its Tauri backend. */ }
  }, []);

  const runDocumentSync = useCallback(async (announce = true) => {
    if (syncing) return;
    setSyncing(true);
    if (announce) { setError(""); setMessage(""); }
    try {
      const summary = await syncOfflineDocuments();
      setSyncSummary(summary);
      await refreshSyncConflicts();
      if (source && (summary.uploaded || summary.downloaded)) await loadItems(source, parentId);
      if (announce) {
        if (summary.conflicts) setMessage(`${summary.conflicts} Konflikt(e) benötigen eine Entscheidung. Keine Version wurde überschrieben.`);
        else if (summary.uploaded || summary.downloaded) setMessage(`${summary.uploaded} Änderung(en) hochgeladen, ${summary.downloaded} aktualisiert.`);
        else setMessage("Alle Offline-Dateien sind aktuell.");
        if (summary.errors.length) setError(summary.errors.join("\n"));
      }
    } catch (syncError) {
      if (announce) setError(`Synchronisierung wird später erneut versucht: ${String(syncError)}`);
    } finally { setSyncing(false); }
  }, [loadItems, parentId, refreshSyncConflicts, source, syncing]);

  useEffect(() => {
    if (connected !== true || initialSyncStarted.current) return;
    initialSyncStarted.current = true;
    void runDocumentSync(false);
  }, [connected, runDocumentSync]);

  useEffect(() => {
    void refreshSyncConflicts();
    const interval = window.setInterval(() => void refreshSyncConflicts(), 15_000);
    return () => window.clearInterval(interval);
  }, [refreshSyncConflicts]);

  const resolveSyncConflict = async (conflict: DocumentSyncConflict, decision: DocumentConflictDecision) => {
    if (decision === "later") { setShowConflicts(false); return; }
    setResolvingConflictId(conflict.id); setError(""); setMessage("");
    try {
      await resolveDocumentSyncConflict(conflict.id, decision);
      await refreshSyncConflicts();
      if (source) await loadItems(source, parentId);
      setMessage(decision === "keepBoth" ? "Beide Versionen wurden sicher aufbewahrt." : decision === "useLocal" ? "Ihre lokale Version wurde übernommen." : "Die Online-Version wurde übernommen. Die lokale Fassung bleibt bei Online-Löschungen im Wiederherstellungsordner erhalten.");
    } catch (resolveError) { setError(String(resolveError)); }
    finally { setResolvingConflictId(null); }
  };

  const openFolder = async (item: DocumentItem) => {
    if (!source) return;
    setBreadcrumbs((current) => [...current, { id: item.id, name: item.name, webUrl: item.webUrl }]);
    setSearch(""); setMessage(""); await loadItems(source, item.id);
  };

  const navigateBreadcrumb = async (index: number) => {
    if (!source) return;
    const next = breadcrumbs.slice(0, index + 1); setBreadcrumbs(next); setSearch(""); setMessage("");
    await loadItems(source, next[next.length - 1]?.id);
  };

  const navigateUp = () => {
    if (breadcrumbs.length <= 1) return;
    void navigateBreadcrumb(breadcrumbs.length - 2);
  };

  const createFolder = async () => {
    if (!source) return;
    const name = window.prompt("Name des neuen Ordners:")?.trim(); if (!name) return;
    setBusy(true); setError("");
    try { await createDocumentFolder({ driveId: source.id, parentId, name }); await loadItems(source, parentId); setMessage(`Ordner „${name}“ wurde erstellt.`); }
    catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  };

  const createTextFile = async () => {
    if (!source) return;
    const name = window.prompt("Name der neuen Textdatei:", "Neue Textdatei.txt")?.trim(); if (!name) return;
    setBusy(true); setError("");
    try { await createDocumentTextFile(source.id, parentId, name); await loadItems(source, parentId); setMessage(`Datei „${name}“ wurde erstellt.`); }
    catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  };

  const renameItem = useCallback(async (item: DocumentItem) => {
    if (!source) return;
    const name = window.prompt("Neuer Name:", item.name)?.trim(); if (!name || name === item.name) return;
    setBusy(true); setError("");
    try { await renameDocumentItem({ driveId: source.id, itemId: item.id, name }); await loadItems(source, parentId); setMessage("Element wurde umbenannt."); }
    catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  }, [loadItems, parentId, source]);

  const removeItems = useCallback(async (targets: DocumentItem[]) => {
    if (!source || targets.length === 0) return;
    const label = targets.length === 1 ? `„${targets[0].name}“` : `${targets.length} ausgewählte Elemente`;
    if (!window.confirm(`${label} in den Microsoft-365-Papierkorb verschieben?`)) return;
    setBusy(true); setError(""); let deleted = 0;
    try {
      for (const item of targets) { await deleteDocumentItem(source.id, item.id); deleted += 1; }
      await loadItems(source, parentId); setMessage(`${deleted} Element(e) wurden in den Papierkorb verschoben.`);
    } catch (actionError) { setError(deleted ? `${deleted} Element(e) gelöscht. Danach: ${String(actionError)}` : String(actionError)); }
    finally { setBusy(false); }
  }, [loadItems, parentId, source]);

  const downloadItem = async (item: DocumentItem, openAfter = false) => {
    if (!source || item.isFolder) return;
    setBusy(true); setError("");
    try {
      const relativePath = [source.siteName || source.name, ...breadcrumbs.slice(1).map((crumb) => crumb.name)];
      const path = await downloadDocumentItem(source.id, item.id, item.name, relativePath, item.eTag, parentId);
      setMessage(`Offline gespeichert: ${path}`);
      if (openAfter) await openPath(path);
    } catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  };

  const openItem = async (item: DocumentItem) => {
    if (item.isFolder) { await openFolder(item); return; }
    if (item.offlineAvailable && item.localPath) {
      await openPath(item.localPath);
      return;
    }
    await downloadItem(item, true);
  };

  const uploadLocalRevision = async (item: DocumentItem) => {
    if (!source || !item.offlineAvailable || !item.localPath) return;
    if (!window.confirm(`Lokale Änderungen an „${item.name}“ nach Microsoft 365 hochladen?\n\nBei einem Online-Konflikt wird nichts überschrieben.`)) return;
    setBusy(true); setError(""); setMessage("");
    try { await uploadDocumentRevision(source.id, item.id, item.localPath, item.offlineETag); await loadItems(source, parentId); setMessage("Die lokale Version wurde sicher hochgeladen."); }
    catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  };

  const makeFolderOffline = async (item: DocumentItem) => {
    if (!source || !item.isFolder) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const relativePath = [source.siteName || source.name, ...breadcrumbs.slice(1).map((crumb) => crumb.name), item.name];
      const result = await makeDocumentFolderOffline(source.id, item.id, item.name, relativePath);
      await loadItems(source, parentId);
      setMessage(`„${item.name}“ ist jetzt immer offline verfügbar: ${result.files} Datei(en), ${result.folders} Ordner.`);
      if (result.skippedLocalChanges) setMessage((current) => `${current} ${result.skippedLocalChanges} lokale Änderung(en) bleiben geschützt.`);
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); }
  };

  const uploadPaths = useCallback(async (paths: string[]) => {
    if (!source || paths.length === 0) return;
    setBusy(true); setError(""); setMessage(""); let files = 0; let folders = 0;
    try {
      for (const path of paths) { const result = await uploadDocumentPath(source.id, parentId, path); files += result.files; folders += result.folders; }
      await loadItems(source, parentId); setMessage(`${files} Datei(en) und ${folders} Ordner hochgeladen.`);
    } catch (actionError) { setError(`${files || folders ? `${files} Datei(en), ${folders} Ordner verarbeitet. ` : ""}${String(actionError)}`); }
    finally { setBusy(false); setExternalDrag(false); }
  }, [loadItems, parentId, source]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") setExternalDrag(true);
      if (event.payload.type === "leave") setExternalDrag(false);
      if (event.payload.type === "drop") void uploadPaths(event.payload.paths);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [uploadPaths]);

  const chooseUpload = async (directory: boolean) => {
    const selected = await open({ multiple: !directory, directory, title: directory ? "Ordner hochladen" : "Dateien hochladen" });
    if (selected) await uploadPaths(Array.isArray(selected) ? selected : [selected]);
  };

  const transferItems = useCallback(async (transfer: DocumentClipboard, destinationDriveId: string, destinationParentId?: string) => {
    if (!source || transfer.items.length === 0) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const crossDriveCut = transfer.operation === "cut" && transfer.driveId !== destinationDriveId;
      const request = { sourceDriveId: transfer.driveId, itemIds: transfer.items.map((item) => item.id), destinationDriveId, destinationParentId };
      const result = transfer.operation === "copy" || crossDriveCut ? await copyDocumentItems(request) : await moveDocumentItems(request);
      if (result.errors.length) setError(result.errors.join("\n"));
      const count = result.processed + result.queued;
      if (count) setMessage(crossDriveCut ? `${count} Element(e) wurden kopiert. Das Original bleibt bestehen, da Microsoft 365 kein Verschieben zwischen Bibliotheken unterstützt.` : `${count} Element(e) ${result.queued ? "werden kopiert" : "wurden verschoben"}.`);
      if (transfer.operation === "cut" && !crossDriveCut && !result.errors.length) setClipboard(null);
      if (result.queued) await new Promise((resolve) => window.setTimeout(resolve, 1400));
      if (source.id === destinationDriveId || source.id === transfer.driveId) await loadItems(source, parentId);
    } catch (actionError) { setError(String(actionError)); }
    finally { setBusy(false); setDropTargetId(null); }
  }, [loadItems, parentId, source]);

  const placeOnClipboard = useCallback((operation: "copy" | "cut", targets = selectedItems) => {
    if (!source || targets.length === 0) return;
    setClipboard({ operation, driveId: source.id, items: targets.map(({ id, name, isFolder }) => ({ id, name, isFolder })) });
    setMessage(`${targets.length} Element(e) zum ${operation === "copy" ? "Kopieren" : "Verschieben"} vorgemerkt.`);
  }, [selectedItems, source]);

  const shareItem = async (item: DocumentItem) => {
    if (!source) return;
    const allowEdit = window.confirm("Soll der Link Bearbeitung erlauben?\n\nOK = Bearbeiten, Abbrechen = Nur anzeigen");
    setBusy(true); setError("");
    try { const link = await createDocumentShareLink(source.id, item.id, allowEdit); await writeText(link); setMessage("Interner Freigabelink wurde in die Zwischenablage kopiert."); }
    catch (actionError) { setError(String(actionError)); } finally { setBusy(false); }
  };

  const showVersions = async (item: DocumentItem) => {
    if (!source || item.isFolder) return;
    setVersionsItem(item); setVersions([]); setVersionsLoading(true); setError("");
    try { setVersions(await listDocumentVersions(source.id, item.id)); }
    catch (actionError) { setError(String(actionError)); } finally { setVersionsLoading(false); }
  };

  const restoreVersion = async (version: DocumentVersion) => {
    if (!source || !versionsItem || !window.confirm(`Version ${version.id} als aktuelle Version wiederherstellen?`)) return;
    setVersionsLoading(true); setError("");
    try { await restoreDocumentVersion(source.id, versionsItem.id, version.id); setMessage(`Version ${version.id} wurde wiederhergestellt.`); setVersionsItem(null); await loadItems(source, parentId); }
    catch (actionError) { setError(String(actionError)); } finally { setVersionsLoading(false); }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelectedIds(new Set(visibleItems.map((item) => item.id))); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); placeOnClipboard("copy"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") { event.preventDefault(); placeOnClipboard("cut"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && clipboard && source) { event.preventDefault(); void transferItems(clipboard, source.id, parentId); }
      if (event.key === "Delete" && selectedItems.length) { event.preventDefault(); void removeItems(selectedItems); }
      if (event.key === "F2" && selectedItems.length === 1) { event.preventDefault(); void renameItem(selectedItems[0]); }
      if (event.key === "Enter" && selectedItems.length === 1) { event.preventDefault(); void openItem(selectedItems[0]); }
    };
    window.addEventListener("keydown", handleKey); return () => window.removeEventListener("keydown", handleKey);
  }, [clipboard, parentId, placeOnClipboard, removeItems, renameItem, selectedItems, source, transferItems, visibleItems]);

  const selectItem = (event: MouseEvent, item: DocumentItem) => {
    setContextMenu(null);
    setMenuItemId(null);
    setSelectedIds((current) => {
      if (event.ctrlKey || event.metaKey) { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }
      return new Set([item.id]);
    });
  };

  const toggleItem = (item: DocumentItem) => setSelectedIds((current) => {
    const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;
  });

  const openItemContextMenu = (event: MouseEvent, item: DocumentItem) => {
    event.preventDefault(); event.stopPropagation(); setMenuItemId(null);
    setSelectedIds((current) => current.has(item.id) ? current : new Set([item.id]));
    setContextMenu({ x: event.clientX, y: event.clientY, itemId: item.id });
  };

  const openFolderContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, label, .documents-menu, .documents-row:not(.heading), .documents-tile")) return;
    event.preventDefault(); setMenuItemId(null); setSelectedIds(new Set());
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const startInternalDrag = (event: DragEvent, item: DocumentItem) => {
    const ids = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
    if (!selectedIds.has(item.id)) setSelectedIds(new Set([item.id]));
    event.dataTransfer.effectAllowed = "copyMove"; event.dataTransfer.setData("application/x-dmh-document-ids", JSON.stringify(ids));
  };

  const dropInternal = (event: DragEvent, destinationParentId?: string, destinationDriveId = source?.id) => {
    event.preventDefault(); event.stopPropagation(); setDropTargetId(null);
    if (!source || !destinationDriveId) return;
    const raw = event.dataTransfer.getData("application/x-dmh-document-ids"); if (!raw) return;
    const ids = JSON.parse(raw) as string[];
    const transfer: DocumentClipboard = { operation: event.ctrlKey ? "copy" : "cut", driveId: source.id, items: items.filter((item) => ids.includes(item.id)).map(({ id, name, isFolder }) => ({ id, name, isFolder })) };
    void transferItems(transfer, destinationDriveId, destinationParentId);
  };

  const openLocalFolder = async () => {
    try { await openPath(await getDocumentsLocalRoot()); } catch (actionError) { setError(String(actionError)); }
  };

  const actions: DocumentActions = {
    open: openItem, download: downloadItem, openLocal: (item) => void openPath(item.localPath), uploadRevision: uploadLocalRevision,
    makeOffline: makeFolderOffline,
    share: shareItem, versions: showVersions, copy: (item) => placeOnClipboard("copy", [item]),
    cut: (item) => placeOnClipboard("cut", [item]), rename: renameItem, remove: (item) => removeItems([item])
  };

  if (connected === false) return <div className="page documents-page documents-empty-state"><Cloud size={52} /><h2>Dokumente</h2><p>Verbinden Sie zuerst Ihr Microsoft-365-Konto. Danach erscheinen OneDrive und freigegebene SharePoint-Bibliotheken automatisch.</p><button className="primary large" type="button" onClick={() => onNavigate("m365")}>Microsoft 365 verbinden</button></div>;

  return <div className={`page documents-page ${externalDrag ? "external-drag-active" : ""}`} onClick={() => setContextMenu(null)}>
    <header className="documents-header">
      <h2>Dokumente</h2>
      <div className="documents-header-actions">
        <button
          className={`documents-header-icon-button ${syncConflicts.length ? "documents-conflict-button" : ""}`}
          type="button"
          title={syncConflicts.length ? `${syncConflicts.length} Synchronisierungskonflikt(e) anzeigen` : "Keine Synchronisierungskonflikte"}
          aria-label={syncConflicts.length ? `${syncConflicts.length} Synchronisierungskonflikt(e) anzeigen` : "Keine Synchronisierungskonflikte"}
          onClick={() => setShowConflicts(true)}
          disabled={!syncConflicts.length}
        >
          <AlertTriangle size={19} />
          {syncConflicts.length > 0 && <span className="documents-header-badge" aria-hidden="true">{syncConflicts.length}</span>}
        </button>
        <button
          className="documents-header-icon-button"
          type="button"
          title={syncing ? "Synchronisierung läuft" : "Jetzt synchronisieren"}
          aria-label={syncing ? "Synchronisierung läuft" : "Jetzt synchronisieren"}
          onClick={() => runDocumentSync(true)}
          disabled={syncing}
        >
          {syncing ? <LoaderCircle className="spin" size={19} /> : <RefreshCw size={19} />}
        </button>
        <button
          className="documents-header-icon-button"
          type="button"
          title="Offline-Dateien öffnen"
          aria-label="Offline-Dateien öffnen"
          onClick={openLocalFolder}
        >
          <FolderOpen size={19} />
        </button>
      </div>
    </header>
    {syncSummary && <div className="documents-sync-strip"><CheckCircle2 size={16} /><span>{syncing ? "Änderungen werden abgeglichen …" : syncConflicts.length ? `${syncConflicts.length} Konflikt(e) warten auf Ihre Entscheidung` : "Offline-Dateien werden automatisch synchronisiert"}</span><small>{syncSummary.uploaded} hochgeladen · {syncSummary.downloaded} aktualisiert</small></div>}
    {error && <div className="status-message error documents-multiline-message">{error}</div>}
    {message && <div className="status-message success">{message}</div>}

    <div className="documents-layout">
      <aside className="documents-sources"><h3><HardDrive size={18} /> Speicherorte</h3>
        {groupedSources.oneDrive.map((item) => <SourceButton key={item.id} item={item} active={source?.id === item.id} onClick={() => selectSource(item)} onDrop={(event) => dropInternal(event, undefined, item.id)} />)}
        {sourcesLoading && <p className="documents-sources-loading"><LoaderCircle className="spin" size={17} /> SharePoint wird geladen …</p>}{sourcesError && <p className="documents-sources-error">{sourcesError}</p>}
        {groupedSources.sharePoint.length > 0 && <h4>SharePoint</h4>}
        {groupedSources.sharePoint.map((item) => <SourceButton key={item.id} item={item} active={source?.id === item.id} onClick={() => selectSource(item)} onDrop={(event) => dropInternal(event, undefined, item.id)} />)}
        {!busy && !sourcesLoading && sources.length === 0 && <p className="documents-no-sources">Keine zugänglichen Speicherorte gefunden.</p>}
      </aside>

      <section className="documents-browser" onContextMenu={openFolderContextMenu} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropInternal(event, parentId)}>
        <div className={`documents-explorer-addressbar${source ? "" : " no-source"}`}>
          <button className="documents-navigation-button" type="button" title="Eine Ebene nach oben" aria-label="Eine Ebene nach oben" onClick={navigateUp} disabled={breadcrumbs.length <= 1}>
            <ArrowUp size={18} />
          </button>
          <nav className="documents-breadcrumbs" aria-label="Ordnerpfad">
            {breadcrumbs.length === 0 && <span className="documents-address-placeholder">Kein Speicherort ausgewählt</span>}
            {breadcrumbs.map((crumb, index) => <span key={`${crumb.id ?? "root"}-${index}`}><button type="button" onClick={() => navigateBreadcrumb(index)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropInternal(event, crumb.id)}>{crumb.name}</button>{index < breadcrumbs.length - 1 && <ChevronRight size={15} />}</span>)}
            {currentBreadcrumb?.webUrl && <button className="documents-open-online" type="button" title="In SharePoint öffnen" aria-label="In SharePoint öffnen" onClick={() => openUrl(currentBreadcrumb.webUrl!)}><ExternalLink size={16} /></button>}
          </nav>
          {source && <label className="documents-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Diesen Ordner durchsuchen" aria-label="Diesen Ordner durchsuchen" /></label>}
        </div>
        <div className="documents-browser-tools">
          <label className="documents-sort"><span>Sortieren</span><select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}><option value="name">Name</option><option value="modified">Geändert</option><option value="size">Größe</option></select><button type="button" title="Sortierreihenfolge" aria-label="Sortierreihenfolge ändern" onClick={() => setSortAscending((current) => !current)}><ChevronDown className={sortAscending ? "" : "reverse"} size={17} /></button></label>
          <div className="documents-view-buttons"><button className={view === "list" ? "active" : ""} type="button" title="Listenansicht" aria-label="Listenansicht" onClick={() => setView("list")}><List size={18} /></button><button className={view === "grid" ? "active" : ""} type="button" title="Kachelansicht" aria-label="Kachelansicht" onClick={() => setView("grid")}><Grid2X2 size={18} /></button></div>
        </div>
        {busy ? <div className="documents-loading"><LoaderCircle className="spin" size={30} /> Dokumente werden geladen …</div> : view === "list" ? <div className="documents-table" role="table">
          <div className="documents-row heading" role="row"><button className="documents-select-all" type="button" title="Alle auswählen" onClick={() => setSelectedIds(selectedIds.size === visibleItems.length ? new Set() : new Set(visibleItems.map((item) => item.id)))}><CheckSquare size={17} /></button><span>Name</span><span>Geändert</span><span>Geändert von</span><span>Größe</span><span /></div>
          {visibleItems.map((item) => <DocumentRow key={item.id} item={item} selected={selectedIds.has(item.id)} cut={clipboard?.operation === "cut" && clipboard.driveId === source?.id && clipboard.items.some((entry) => entry.id === item.id)} menuOpen={menuItemId === item.id} dropTarget={dropTargetId === item.id} onSelect={selectItem} onToggle={toggleItem} onOpen={() => openItem(item)} onMenu={() => { setSelectedIds(new Set([item.id])); setMenuItemId((current) => current === item.id ? null : item.id); }} onContextMenu={openItemContextMenu} onDragStart={startInternalDrag} onDragOver={(event) => { if (item.isFolder) { event.preventDefault(); event.stopPropagation(); setDropTargetId(item.id); } }} onDragLeave={() => setDropTargetId(null)} onDrop={(event) => item.isFolder && dropInternal(event, item.id)} actions={actions} />)}
          {items.length === 0 && <div className="documents-no-items">Dieser Ordner ist leer. Dateien oder Ordner können hierher gezogen werden.</div>}{items.length > 0 && visibleItems.length === 0 && <div className="documents-no-items">Keine passenden Dokumente gefunden.</div>}
        </div> : <div className="documents-grid">{visibleItems.map((item) => <article key={item.id} className={`documents-tile ${selectedIds.has(item.id) ? "selected" : ""} ${dropTargetId === item.id ? "drop-target" : ""}`} role="button" tabIndex={0} draggable onClick={(event) => selectItem(event, item)} onDoubleClick={() => openItem(item)} onKeyDown={(event) => { if (event.key === "Enter") void openItem(item); }} onContextMenu={(event) => openItemContextMenu(event, item)} onDragStart={(event) => startInternalDrag(event, item)} onDragOver={(event) => { if (item.isFolder) { event.preventDefault(); event.stopPropagation(); setDropTargetId(item.id); } }} onDragLeave={() => setDropTargetId(null)} onDrop={(event) => item.isFolder && dropInternal(event, item.id)}>{item.isFolder ? <Folder size={42} /> : <File size={42} />}<strong>{item.name}</strong><small>{item.isFolder ? "Ordner" : item.offlineAvailable ? "Offline verfügbar" : formatSize(item.size)}</small>{menuItemId === item.id && <div className="documents-menu documents-grid-menu" onClick={(event) => event.stopPropagation()}><DocumentMenu item={item} actions={actions} /></div>}</article>)}</div>}
        <footer className="documents-statusbar"><span>{visibleItems.length} Element(e)</span><span>{selectedIds.size ? `${selectedIds.size} ausgewählt` : "Rechtsklick für Aktionen · Strg+A wählt alles aus"}</span>{clipboard && <span className="documents-clipboard-status">{clipboard.operation === "copy" ? <Copy size={14} /> : <Scissors size={14} />} {clipboard.items.length} vorgemerkt</span>}</footer>
      </section>
    </div>

    {contextMenu && <div
      className="documents-menu documents-context-menu"
      role="menu"
      style={{
        left: contextMenu.x,
        top: contextMenu.y,
        transform: `translate(${contextMenu.x > window.innerWidth / 2 ? "-100%" : "0"}, ${contextMenu.y > window.innerHeight / 2 ? "-100%" : "0"})`
      }}
      onClick={(event) => { event.stopPropagation(); setContextMenu(null); }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {contextMenuItems.length === 0 ? <>
        <button type="button" onClick={createFolder} disabled={busy || !source}><FolderPlus size={17} /> Neuer Ordner</button>
        <button type="button" onClick={createTextFile} disabled={busy || !source}><FilePlus2 size={17} /> Neue Datei</button>
        <span className="documents-menu-separator" role="separator" />
        <button type="button" onClick={() => chooseUpload(false)} disabled={busy || !source}><Upload size={17} /> Dateien hochladen</button>
        <button type="button" onClick={() => chooseUpload(true)} disabled={busy || !source}><UploadCloud size={17} /> Ordner hochladen</button>
        <span className="documents-menu-separator" role="separator" />
        <button type="button" onClick={() => clipboard && source && transferItems(clipboard, source.id, parentId)} disabled={!clipboard || !source}><ClipboardPaste size={17} /> Einfügen</button>
      </> : contextMenuItems.length === 1 ? <DocumentMenu item={contextMenuItems[0]} actions={actions} /> : <>
        <button type="button" onClick={() => placeOnClipboard("copy", contextMenuItems)}><Copy size={17} /> {contextMenuItems.length} Elemente kopieren</button>
        <button type="button" onClick={() => placeOnClipboard("cut", contextMenuItems)}><Scissors size={17} /> {contextMenuItems.length} Elemente ausschneiden</button>
        <span className="documents-menu-separator" role="separator" />
        <button className="danger" type="button" onClick={() => removeItems(contextMenuItems)}><Trash2 size={17} /> {contextMenuItems.length} Elemente löschen</button>
      </>}
    </div>}

    {externalDrag && <div className="documents-drop-overlay"><UploadCloud size={52} /><strong>In „{currentBreadcrumb?.name}“ hochladen</strong><span>Dateien oder komplette Ordner loslassen</span></div>}
    {versionsItem && <div className="modal-backdrop" onMouseDown={() => setVersionsItem(null)}><section className="modal-card documents-versions-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><History size={22} /><span><strong>Versionsverlauf</strong><small>{versionsItem.name}</small></span></div><button className="icon-only" type="button" onClick={() => setVersionsItem(null)}><X size={20} /></button></header>{versionsLoading ? <div className="documents-loading"><LoaderCircle className="spin" size={25} /> Versionen werden geladen …</div> : versions.length === 0 ? <p>Keine früheren Versionen verfügbar.</p> : <div className="documents-version-list">{versions.map((version, index) => <article key={version.id}><span><strong>Version {version.id}{index === 0 ? " · Aktuell" : ""}</strong><small>{formatDate(version.lastModifiedAt)} · {version.modifiedBy || "Unbekannt"} · {formatSize(version.size)}</small></span>{index > 0 && <button type="button" onClick={() => restoreVersion(version)}>Wiederherstellen</button>}</article>)}</div>}</section></div>}
    {showConflicts && <div className="modal-backdrop" onMouseDown={() => setShowConflicts(false)}><section className="modal-card documents-conflict-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><AlertTriangle size={24} /><span><strong>Synchronisierungskonflikte</strong><small>Keine Version wird ohne Ihre Entscheidung überschrieben.</small></span></div><button className="icon-only" type="button" onClick={() => setShowConflicts(false)}><X size={20} /></button></header>{syncConflicts.length === 0 ? <div className="documents-conflict-empty"><CheckCircle2 size={34} /><strong>Alles gelöst</strong><span>Es sind keine Konflikte mehr offen.</span></div> : <div className="documents-conflict-list">{syncConflicts.map((conflict) => <article key={conflict.id}><div className="documents-conflict-title"><File size={23} /><span><strong>{conflict.name}</strong><small>{conflict.kind === "remoteDeleted" ? "Online gelöscht, lokal noch vorhanden" : "Lokal und online geändert"}</small></span></div>{conflict.kind === "bothModified" && <div className="documents-conflict-comparison"><span><strong>Ihre Offline-Version</strong><small>Auf diesem PC geändert</small></span><span><strong>Online-Version</strong><small>{conflict.remoteModifiedBy || "Andere Person"} · {formatDate(conflict.remoteModifiedAt)}</small></span></div>}<div className="documents-conflict-actions">{conflict.kind === "remoteDeleted" ? <><button className="primary" type="button" disabled={resolvingConflictId === conflict.id} onClick={() => resolveSyncConflict(conflict, "useLocal")}>Lokale Datei wiederherstellen</button><button type="button" disabled={resolvingConflictId === conflict.id} onClick={() => resolveSyncConflict(conflict, "useOnline")}>Online-Löschung akzeptieren</button></> : <><button className="primary" type="button" disabled={resolvingConflictId === conflict.id} onClick={() => resolveSyncConflict(conflict, "keepBoth")}>Beide behalten <small>Empfohlen</small></button><button type="button" disabled={resolvingConflictId === conflict.id} onClick={() => resolveSyncConflict(conflict, "useLocal")}>Meine Version</button><button type="button" disabled={resolvingConflictId === conflict.id} onClick={() => resolveSyncConflict(conflict, "useOnline")}>Online-Version</button></>}<button type="button" onClick={() => resolveSyncConflict(conflict, "later")}>Später</button></div></article>)}</div>}</section></div>}
  </div>;
}

interface DocumentActions { open: (item: DocumentItem) => void; download: (item: DocumentItem) => void; openLocal: (item: DocumentItem) => void; uploadRevision: (item: DocumentItem) => void; makeOffline: (item: DocumentItem) => void; share: (item: DocumentItem) => void; versions: (item: DocumentItem) => void; copy: (item: DocumentItem) => void; cut: (item: DocumentItem) => void; rename: (item: DocumentItem) => void; remove: (item: DocumentItem) => void }

function SourceButton({ item, active, onClick, onDrop }: { item: DocumentSource; active: boolean; onClick: () => void; onDrop: (event: DragEvent) => void }) {
  return <button className={active ? "active" : ""} type="button" onClick={onClick} onDragOver={(event) => event.preventDefault()} onDrop={onDrop} title={`${item.siteName} – ${item.name}`}>{item.kind === "onedrive" ? <Cloud size={18} /> : <Folder size={18} />}<span><strong>{item.kind === "onedrive" ? "Mein OneDrive" : item.siteName}</strong><small>{item.name}</small></span></button>;
}

function DocumentRow({ item, selected, cut, menuOpen, dropTarget, onSelect, onToggle, onOpen, onMenu, onContextMenu, onDragStart, onDragOver, onDragLeave, onDrop, actions }: { item: DocumentItem; selected: boolean; cut: boolean; menuOpen: boolean; dropTarget: boolean; onSelect: (event: MouseEvent, item: DocumentItem) => void; onToggle: (item: DocumentItem) => void; onOpen: () => void; onMenu: () => void; onContextMenu: (event: MouseEvent, item: DocumentItem) => void; onDragStart: (event: DragEvent, item: DocumentItem) => void; onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void; actions: DocumentActions }) {
  return <div className={`documents-row ${selected ? "selected" : ""} ${cut ? "cut" : ""} ${dropTarget ? "drop-target" : ""}`} role="row" draggable onClick={(event) => onSelect(event, item)} onDoubleClick={onOpen} onContextMenu={(event) => onContextMenu(event, item)} onDragStart={(event) => onDragStart(event, item)} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <label className="documents-row-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected} onChange={() => onToggle(item)} aria-label={`${item.name} auswählen`} /></label>
    <button className="documents-name" type="button" onClick={(event) => { event.stopPropagation(); onSelect(event, item); }} onDoubleClick={(event) => { event.stopPropagation(); onOpen(); }}>{item.isFolder ? <Folder size={21} /> : <File size={21} />}<span>{item.name}{item.offlineAvailable && <small className={item.offlineOutdated ? "outdated" : ""}>{item.offlineOutdated ? "Online-Version ist neuer" : "Offline verfügbar"}</small>}</span></button>
    <span>{formatDate(item.lastModifiedAt)}</span><span>{item.modifiedBy || "–"}</span><span>{item.isFolder ? "–" : formatSize(item.size)}</span>
    <div className="documents-menu-wrap"><button className="icon-only compact" type="button" aria-label={`Aktionen für ${item.name}`} onClick={(event) => { event.stopPropagation(); onMenu(); }}><MoreHorizontal size={18} /></button>{menuOpen && <div className="documents-menu" onClick={(event) => event.stopPropagation()}><DocumentMenu item={item} actions={actions} /></div>}</div>
  </div>;
}

function DocumentMenu({ item, actions }: { item: DocumentItem; actions: DocumentActions }) {
  return <><button type="button" onClick={() => actions.open(item)}>{item.isFolder ? <ExternalLink size={17} /> : <FolderOpen size={17} />} {item.isFolder ? "Öffnen" : "Bearbeiten / öffnen"}</button>{item.isFolder && <button type="button" onClick={() => item.offlineAvailable ? actions.openLocal(item) : actions.makeOffline(item)}><Download size={17} /> {item.offlineAvailable ? "Offline-Ordner öffnen" : "Immer offline verfügbar"}</button>}{!item.isFolder && <button type="button" onClick={() => actions.download(item)}><Download size={17} /> {item.offlineAvailable ? "Offline aktualisieren" : "Offline speichern"}</button>}{!item.isFolder && item.offlineAvailable && <button type="button" onClick={() => actions.openLocal(item)}><FolderOpen size={17} /> Lokal öffnen</button>}{!item.isFolder && item.offlineAvailable && <button type="button" onClick={() => actions.uploadRevision(item)}><Upload size={17} /> Lokale Änderung hochladen</button>}<button type="button" onClick={() => actions.share(item)}><Share2 size={17} /> Link teilen</button>{!item.isFolder && <button type="button" onClick={() => actions.versions(item)}><History size={17} /> Versionsverlauf</button>}<button type="button" onClick={() => actions.copy(item)}><Copy size={17} /> Kopieren</button><button type="button" onClick={() => actions.cut(item)}><Scissors size={17} /> Ausschneiden</button><button type="button" onClick={() => actions.rename(item)}><Pencil size={17} /> Umbenennen</button><button className="danger" type="button" onClick={() => actions.remove(item)}><Trash2 size={17} /> Löschen</button></>;
}

function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
function formatDate(value: string) { if (!value) return "–"; return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }

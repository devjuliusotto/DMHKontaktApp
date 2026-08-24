import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { t } from "../i18n";
import { deleteGroup, getAppSetting, listGroups, saveGroup } from "../services/db";
import type { Group } from "../types/contact";
import { deletionConfirmationSettingKey } from "../utils/settings";

const blankGroup: Group = { name: "", description: "", createdAt: "", updatedAt: "" };

export function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [form, setForm] = useState<Group>(blankGroup);
  const [message, setMessage] = useState("");
  const [confirmDeletions, setConfirmDeletions] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<Group | null>(null);

  const refresh = async () => setGroups(await listGroups());

  useEffect(() => {
    refresh().catch((error) => setMessage(`Fehler beim Laden: ${error}`));
    getAppSetting(deletionConfirmationSettingKey)
      .then((value) => setConfirmDeletions(value !== "false"))
      .catch(() => setConfirmDeletions(true));
  }, []);

  const submit = async () => {
    if (!form.name.trim()) {
      setMessage("Bitte geben Sie einen Gruppennamen ein.");
      return;
    }
    await saveGroup(form);
    setForm(blankGroup);
    setMessage("Gruppe wurde gespeichert.");
    await refresh();
  };

  const removeNow = async (group: Group) => {
    if (!group.id) return;
    await deleteGroup(group.id);
    setMessage("Gruppe wurde gelöscht.");
    await refresh();
  };

  const remove = (group: Group) => {
    if (!group.id) return;
    if (confirmDeletions) setPendingDelete(group);
    else void removeNow(group);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t.groups}</h2>
          <p>Gruppen helfen beim Sortieren von Kontakten.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="form-panel">
        <h3>{t.createGroup}</h3>
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="field wide">
            <span>Beschreibung</span>
            <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </label>
        </div>
        <div className="button-row">
          <button className="primary" type="button" onClick={submit}>
            <Plus size={22} /> {t.save}
          </button>
        </div>
      </section>
      <section className="card-grid">
        {groups.map((group) => (
          <article className="simple-card" key={group.id}>
            <div>
              <h3>{group.name}</h3>
              <p>{group.description || "Keine Beschreibung"}</p>
            </div>
            <button title={t.delete} type="button" onClick={() => remove(group)}>
              <Trash2 size={20} />
            </button>
          </article>
        ))}
      </section>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Gruppe löschen"
        message={pendingDelete ? `Möchten Sie die Gruppe „${pendingDelete.name}“ wirklich löschen?` : "Möchten Sie diese Gruppe wirklich löschen?"}
        confirmLabel="Gruppe löschen"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void removeNow(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

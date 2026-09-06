export type DataSection = "contacts" | "calendar";

export const hiddenDataSectionsStorageKey = "dmh.hiddenDataSections.v1";
export const dataSectionVisibilityChangedEventName = "dmh:data-section-visibility-changed";

function readStoredSections(): DataSection[] {
  try {
    const stored = JSON.parse(localStorage.getItem(hiddenDataSectionsStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.filter((section): section is DataSection => section === "contacts" || section === "calendar");
  } catch {
    return [];
  }
}

export function readHiddenDataSections(): DataSection[] {
  return Array.from(new Set(readStoredSections()));
}

export function setDataSectionHidden(section: DataSection, hidden: boolean): void {
  const current = new Set(readHiddenDataSections());
  if (hidden) current.add(section);
  else current.delete(section);

  const next = Array.from(current);
  try {
    localStorage.setItem(hiddenDataSectionsStorageKey, JSON.stringify(next));
  } catch {
    // The in-memory event still lets the current app session update.
  }
  window.dispatchEvent(new CustomEvent<DataSection[]>(dataSectionVisibilityChangedEventName, { detail: next }));
}

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

vi.mock("../services/db", () => ({
  clearContactGroups: vi.fn(),
  cleanupContactDuplicates: vi.fn(),
  deleteAllContacts: vi.fn(),
  deleteContact: vi.fn(),
  deleteContacts: vi.fn(),
  deleteGroup: vi.fn(),
  detectConnectedCalendarSources: vi.fn(),
  getAppSetting: vi.fn().mockResolvedValue(null),
  getContactOverviewCounts: vi.fn().mockResolvedValue({ total: 0, ungrouped: 0, groups: {} }),
  getMigrationCaptureStatus: vi.fn().mockResolvedValue({ configured: false, completed: false }),
  listContacts: vi.fn().mockResolvedValue([]),
  listGroups: vi.fn().mockResolvedValue([]),
  moveContactToGroup: vi.fn(),
  openNewOutlookBulkEmail: vi.fn(),
  openNewOutlookEmail: vi.fn(),
  openOutlookClassicBulkEmail: vi.fn(),
  openOutlookClassicEmail: vi.fn(),
  saveContact: vi.fn(),
  saveGroup: vi.fn(),
  setAppSetting: vi.fn(),
  migrationCaptureStatusChangedEventName: "dmh:migration-capture-status-changed"
}));

vi.mock("../utils/easyImport", () => ({
  easyImport: vi.fn()
}));

import { ContactsPage } from "./ContactsPage";

describe("ContactsPage", () => {
  it("mostra o estado vazio sem abrir uma janela e aguarda a escolha do usuário", async () => {
    const user = userEvent.setup();
    render(<ContactsPage onNavigate={() => undefined} onRegisterNavigationBlocker={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Noch keine Kontakte" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /Kontakte einfach importieren/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Einfach importieren/ }));
    expect(await screen.findByRole("dialog", { name: /Kontakte einfach importieren/ })).toBeVisible();
  });
});

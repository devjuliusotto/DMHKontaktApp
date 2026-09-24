import { expect, test, type Page } from "@playwright/test";

type MockContact = {
  id: number;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  privateEmail: string;
  secondPrivateEmail: string;
  phone: string;
  mobilePhone: string;
  privatePhone: string;
  secondPrivatePhone: string;
  company: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  shortInfo: string;
  notes: string;
  groups: unknown[];
  createdAt: string;
  updatedAt: string;
};

function mockContact(id: number, firstName: string, lastName: string): MockContact {
  return {
    id,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    email: `${firstName}.${lastName}@example.test`.toLowerCase(),
    privateEmail: "",
    secondPrivateEmail: "",
    phone: "",
    mobilePhone: "",
    privatePhone: "",
    secondPrivatePhone: "",
    company: "DMH",
    street: "",
    postalCode: "",
    city: "Aidlingen",
    country: "Deutschland",
    shortInfo: "",
    notes: "",
    groups: [],
    createdAt: "2026-09-24T08:00:00Z",
    updatedAt: "2026-09-24T08:00:00Z"
  };
}

async function installTauriMock(page: Page, contacts: MockContact[]) {
  await page.addInitScript((seedContacts) => {
    let callbackId = 0;
    const callbacks = new Map<number, (...args: unknown[]) => void>();
    const invoke = async (command: string) => {
      switch (command) {
        case "get_vault_status":
          return { protectionEnabled: false, unlocked: true, username: "", recoveryEmail: "", recoveryEmailHint: "", recoveryAvailable: false, entryCount: 0 };
        case "get_microsoft365_connection_status":
          return { connected: false, accountName: "", accountEmail: "" };
        case "list_contacts":
          return seedContacts;
        case "list_groups":
          return [];
        case "get_contact_overview_counts":
          return { total: seedContacts.length, ungrouped: seedContacts.length, groups: {} };
        case "get_app_setting":
          return null;
        case "get_calendar_overview":
          return { total: 0, sources: [] };
        case "list_calendar_events_in_range":
        case "list_calendar_events":
          return [];
        case "plugin:event|listen":
          return ++callbackId;
        case "plugin:event|unlisten":
        case "plugin:updater|check":
        case "sync_offline_documents":
        case "create_automatic_safety_backup":
          return null;
        default:
          return null;
      }
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        invoke,
        transformCallback(callback: (...args: unknown[]) => void) {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        convertFileSrc(path: string) {
          return path;
        }
      }
    });
  }, contacts);
}

test("zero contatos abre a página normalmente e só mostra o importador após escolha", async ({ page }) => {
  await installTauriMock(page, []);
  await page.goto("/");
  await page.getByRole("button", { name: "Kontakte", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Noch keine Kontakte" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Kontakte einfach importieren/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Einfach importieren/ }).click();
  const dialog = page.getByRole("dialog", { name: /Kontakte einfach importieren/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Outlook Classic/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Thunderbird/ })).toBeVisible();
});

test("seleção múltipla, menu e alterações não salvas funcionam juntos", async ({ page }) => {
  await installTauriMock(page, [
    mockContact(1, "Anna", "Adler"),
    mockContact(2, "Berta", "Bauer"),
    mockContact(3, "Clara", "Christ")
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Kontakte", exact: true }).click();

  const rows = page.getByRole("listbox", { name: "Kontakte" }).getByRole("option");
  await expect(rows).toHaveCount(3);
  const panes = await page.locator(".groups-panel, .contacts-main, .contact-inspector").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width };
  }));
  expect(panes).toHaveLength(3);
  expect(panes.every((pane) => pane.width > 100)).toBe(true);
  expect(panes[0].right).toBeLessThanOrEqual(panes[1].left + 1);
  expect(panes[1].right).toBeLessThanOrEqual(panes[2].left + 1);

  await rows.nth(0).click({ modifiers: ["Control"] });
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveCSS("user-select", "none");

  await rows.nth(0).click();
  await page.getByRole("button", { name: "Aktionen für Anna Adler" }).click();
  await expect(page.getByRole("menuitem", { name: /Löschen/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByLabel("Vorname").fill("Anneliese");
  await rows.nth(1).click();
  const dialog = page.getByRole("dialog", { name: /Nicht gespeicherte Änderungen/ });
  await expect(dialog).toContainText("Anna");
  await expect(dialog).toContainText("Anneliese");
  await dialog.getByRole("button", { name: /Änderungen verwerfen/ }).click();
  await expect(page.getByLabel("Vorname")).toHaveValue("Berta");
});

test("evento de dia inteiro usa a faixa superior e esconde horários", async ({ page }) => {
  await installTauriMock(page, [mockContact(1, "Anna", "Adler")]);
  await page.goto("/");
  await page.getByRole("button", { name: "Kalender", exact: true }).click();
  await page.getByRole("button", { name: /Neuer Termin/ }).click();
  await page.getByPlaceholder("Titel hinzufügen").fill("Fortbildung");

  const editorBox = await page.locator(".calendar-meeting-editor").boundingBox();
  const fieldsBox = await page.locator(".calendar-meeting-fields").boundingBox();
  const plannerBox = await page.locator(".calendar-meeting-planner").boundingBox();
  expect(editorBox).not.toBeNull();
  expect(fieldsBox).not.toBeNull();
  expect(plannerBox).not.toBeNull();
  expect(fieldsBox!.x + fieldsBox!.width).toBeLessThanOrEqual(plannerBox!.x + 1);
  await expect(page.locator(".calendar-meeting-footer")).toBeVisible();

  await page.getByRole("checkbox", { name: /Ganztägig/ }).check();

  await expect(page.getByLabel("Startzeit")).toHaveCount(0);
  await expect(page.getByLabel("Endzeit")).toHaveCount(0);
  await expect(page.getByLabel("Ganztägige Termine")).toContainText("Fortbildung");
  await expect(page.getByRole("button", { name: /Speichern/ })).toBeEnabled();
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Contact } from "../types/contact";
import { ContactTable } from "./ContactTable";

function contact(id: number): Contact {
  const number = String(id).padStart(3, "0");
  return {
    id,
    firstName: "Kontakt",
    lastName: number,
    displayName: `Kontakt ${number}`,
    email: `kontakt${number}@example.test`,
    privateEmail: "",
    secondPrivateEmail: "",
    phone: "",
    mobilePhone: "",
    privatePhone: "",
    secondPrivatePhone: "",
    company: "",
    street: "",
    postalCode: "",
    city: "",
    country: "",
    shortInfo: "",
    notes: "",
    groups: [],
    createdAt: "2026-09-24T08:00:00Z",
    updatedAt: "2026-09-24T08:00:00Z"
  };
}

const noop = () => undefined;

function SelectionHarness({ contacts }: { contacts: Contact[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  return (
    <>
      <output data-testid="selected-ids">{Array.from(selected).sort((a, b) => a - b).join(",")}</output>
      <ContactTable
        contacts={contacts}
        paginationKey="all"
        onEdit={noop}
        onDelete={noop}
        onCopyEmail={noop}
        onEmail={noop}
        selectionMode={false}
        selectionActive={selected.size > 0}
        selectedContactIds={selected}
        onSelectionChange={(ids, operation) => setSelected((current) => {
          if (operation === "replace") return new Set(ids);
          const next = new Set(current);
          for (const id of ids) {
            if (operation === "toggle" && next.has(id)) next.delete(id);
            else next.add(id);
          }
          return next;
        })}
        onClearSelection={() => setSelected(new Set())}
        onPointerDragStart={noop}
        managementView
      />
    </>
  );
}

describe("ContactTable", () => {
  it("seleciona intervalos com Shift e contatos avulsos com Ctrl", () => {
    render(<SelectionHarness contacts={Array.from({ length: 6 }, (_, index) => contact(index + 1))} />);
    const rows = screen.getAllByRole("option");

    fireEvent.click(rows[1], { ctrlKey: true });
    fireEvent.click(rows[4], { shiftKey: true });
    expect(screen.getByTestId("selected-ids")).toHaveTextContent("2,3,4,5");

    fireEvent.click(rows[0], { ctrlKey: true });
    expect(screen.getByTestId("selected-ids")).toHaveTextContent("1,2,3,4,5");
    expect(rows[0]).toHaveClass("contact-compact-row");
  });

  it("abre o menu dos três pontos com as ações do contato", async () => {
    const user = userEvent.setup();
    render(<SelectionHarness contacts={[contact(1)]} />);

    await user.click(screen.getByRole("button", { name: "Aktionen für Kontakt 001" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Nachricht/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /E-Mail kopieren/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Löschen/ })).toBeVisible();
  });

  it("permanece na mesma página depois de excluir um contato", async () => {
    function DeleteHarness() {
      const [contacts, setContacts] = useState(Array.from({ length: 205 }, (_, index) => contact(index + 1)));
      return (
        <ContactTable
          contacts={contacts}
          paginationKey="all"
          onEdit={noop}
          onDelete={(target) => setContacts((current) => current.filter((entry) => entry.id !== target.id))}
          onCopyEmail={noop}
          onEmail={noop}
          selectionMode={false}
          selectionActive={false}
          selectedContactIds={new Set()}
          onSelectionChange={noop}
          onClearSelection={noop}
          onPointerDragStart={noop}
          managementView
        />
      );
    }

    render(<DeleteHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    fireEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText(/Seite 3 von 3/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Aktionen für Kontakt 201" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Löschen/ }));

    expect(screen.getByText(/Seite 3 von 3/)).toBeVisible();
    expect(screen.getByText("Kontakt 202")).toBeVisible();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnsavedContactChangesDialog } from "./UnsavedContactChangesDialog";

describe("UnsavedContactChangesDialog", () => {
  it("mostra exatamente o que mudou e permite salvar ou descartar", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(
      <UnsavedContactChangesDialog
        open
        busy={false}
        contactName="Erika Muster"
        changes={[{ label: "Firma", before: "Alt GmbH", after: "Neu GmbH" }]}
        onSave={onSave}
        onDiscard={onDiscard}
        onContinueEditing={() => undefined}
      />
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Alt GmbH");
    expect(screen.getByRole("dialog")).toHaveTextContent("Neu GmbH");
    await user.click(screen.getByRole("button", { name: /Änderungen speichern/ }));
    expect(onSave).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /Änderungen verwerfen/ }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

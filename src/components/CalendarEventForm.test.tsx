import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../types/calendar";
import { CalendarEventForm } from "./CalendarEventForm";

const initialEvent: CalendarEvent = {
  id: "draft",
  title: "Fortbildung",
  startsAt: "2026-09-24T09:00:00",
  endsAt: "2026-09-24T10:00:00",
  isAllDay: false,
  location: "",
  description: "",
  color: "blue",
  category: "",
  source: "local"
};

function Harness() {
  const [event, setEvent] = useState(initialEvent);
  return (
    <CalendarEventForm
      value={event}
      isNew
      categories={[]}
      events={[]}
      onChange={setEvent}
      onSave={() => undefined}
      onDelete={() => undefined}
      onCancel={() => undefined}
    />
  );
}

describe("CalendarEventForm", () => {
  it("converte um compromisso em evento de dia inteiro e o mostra na faixa limpa do planejador", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: /Ganztägig/ }));

    expect(screen.queryByLabelText("Startzeit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Endzeit")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Startdatum")).toHaveValue("2026-09-24");
    expect(screen.getByLabelText("Enddatum")).toHaveValue("2026-09-24");
    expect(screen.getByLabelText("Ganztägige Termine")).toHaveTextContent("Fortbildung");
    expect(screen.getByRole("button", { name: /Speichern/ })).toBeEnabled();
  });
});

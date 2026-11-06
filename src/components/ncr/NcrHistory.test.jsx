import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const history = vi.fn();
vi.mock("../../hooks/useNcr", () => ({ useNcrHistory: () => history() }));

import NcrHistory from "./NcrHistory";

const entry = (over) => ({
  id: "e",
  at: "2026-11-05T09:00:00Z",
  actor: { id: "u1", name: "Ada Owner" },
  action: "update",
  changedFields: [],
  previous: null,
  current: null,
  reason: null,
  source: "api",
  names: {},
  ...over,
});
const linked = (over) => ({
  kind: "raised",
  inspection: { id: "i1", reference: "IPI-26-0004" },
  readings: [],
  hidden: 0,
  wholeInspection: false,
  ...over,
});

const renderHistory = (data) => {
  history.mockReturnValue({ data, isLoading: false, error: null });
  render(
    <MemoryRouter>
      <NcrHistory id="n1" />
    </MemoryRouter>,
  );
};

describe("NC history: readings linked from an inspection", () => {
  it("says the NC was raised from the inspection, with its readings, then that readings were added", () => {
    renderHistory([
      entry({ id: "e1", action: "insert" }),
      entry({
        id: "e2",
        action: "readings_linked",
        linked: linked({
          readings: [
            {
              id: "m1",
              characteristic: "Outer diameter",
              sampleNumber: 5,
              value: "25.07 mm",
            },
          ],
        }),
      }),
      entry({
        id: "e3",
        at: "2026-11-05T11:00:00Z",
        action: "readings_linked",
        linked: linked({
          kind: "added",
          readings: [
            {
              id: "m2",
              characteristic: "Outer diameter",
              sampleNumber: 9,
              value: "25.08 mm",
            },
          ],
        }),
      }),
    ]);
    expect(screen.getByText(/raised this from inspection/)).toBeInTheDocument();
    expect(
      screen.getByText(/added readings from inspection/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "IPI-26-0004" })[0],
    ).toHaveAttribute("href", "/Inspections/i1");
    expect(screen.getByText(/Outer diameter, sample #5/)).toHaveTextContent(
      "25.07 mm",
    );
    expect(screen.getByText(/Outer diameter, sample #9/)).toHaveTextContent(
      "25.08 mm",
    );
  });

  it("handles a whole-inspection link, readings the reader cannot see and an inspection they cannot see", () => {
    renderHistory([
      entry({
        id: "e1",
        action: "readings_linked",
        linked: linked({ wholeInspection: true }),
      }),
      entry({
        id: "e2",
        action: "readings_linked",
        linked: linked({ kind: "added", inspection: null, hidden: 2 }),
      }),
    ]);
    expect(
      screen.getByText(
        "Linked to the inspection as a whole (no single reading)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/an inspection you cannot see/),
    ).toBeInTheDocument();
    expect(screen.getByText("2 readings you cannot see")).toBeInTheDocument();
  });

  it("still shows ordinary changes", () => {
    renderHistory([
      entry({
        changedFields: ["quantity_affected"],
        previous: { quantity_affected: 1 },
        current: { quantity_affected: 2 },
      }),
    ]);
    expect(
      screen.getByText(/Quantity affected|quantity_affected/i),
    ).toHaveTextContent("2");
  });
});

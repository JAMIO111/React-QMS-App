import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Breadcrumb from "./Breadcrumb";
import { clearBreadcrumb, setBreadcrumb, useBreadcrumbNames } from "../lib/breadcrumbs";

const ID = "3f2c9a52-1d7e-4a64-9b1e-5d0c4a1f7a10";
const Page = ({ label, to }) => {
  useBreadcrumbNames([{ path: `/Suppliers/${ID}`, label }, ...(to ? [{ path: `/Suppliers/${ID}/assessments`, to }] : [])]);
  return <Breadcrumb />;
};
const renderAt = (ui, at) => render(<MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>);

describe("breadcrumb", () => {
  it("shows a record's name instead of its id, and never the id", () => {
    renderAt(<Page label="Acme Metals" />, `/Suppliers/${ID}`);
    expect(screen.getByRole("link", { name: "Acme Metals" })).toHaveAttribute("href", `/Suppliers/${ID}`);
    expect(screen.queryByText(ID)).toBeNull();
  });

  it("waits with a mark while the name loads, then shows it", () => {
    const { rerender } = renderAt(<Page label={null} />, `/Suppliers/${ID}`);
    expect(screen.getByRole("link", { name: "…" })).toBeInTheDocument();
    expect(screen.queryByText(ID)).toBeNull();
    rerender(<MemoryRouter initialEntries={[`/Suppliers/${ID}`]}><Page label="Acme Metals" /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Acme Metals" })).toBeInTheDocument();
  });

  it("can send a crumb that has no page of its own somewhere useful", () => {
    renderAt(<Page label="Acme Metals" to={`/Suppliers/${ID}?tab=qualification`} />, `/Suppliers/${ID}/assessments/${ID.replace("a10", "a11")}`);
    expect(screen.getByRole("link", { name: "Assessments" })).toHaveAttribute("href", `/Suppliers/${ID}?tab=qualification`);
  });

  it("forgets the name when the page closes", () => {
    renderAt(<Breadcrumb />, `/Suppliers/${ID}`);
    act(() => setBreadcrumb(`/Suppliers/${ID}`, "Acme Metals"));
    expect(screen.getByRole("link", { name: "Acme Metals" })).toBeInTheDocument();
    act(() => clearBreadcrumb(`/Suppliers/${ID}`));
    expect(screen.getByRole("link", { name: "…" })).toBeInTheDocument();
  });
});

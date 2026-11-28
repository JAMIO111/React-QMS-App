import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SeatPicker from "./SeatPicker";

const plans = [
  { slug: "organisation", kind: "fee", name: "Organisation", description: "One per organisation", monthly: { unitAmount: 9900, currency: "GBP" }, annual: { unitAmount: 99000, currency: "GBP" } },
  { slug: "observer", kind: "seat", name: "Observer", description: "Views", monthly: { unitAmount: 0, currency: "GBP" }, annual: { unitAmount: 0, currency: "GBP" } },
  { slug: "operator", kind: "seat", name: "Operator", description: "Raises NCs, records inspections", monthly: { unitAmount: 600, currency: "GBP" }, annual: { unitAmount: 6000, currency: "GBP" } },
  { slug: "contributor", kind: "seat", name: "Contributor", description: "Does the work", monthly: { unitAmount: 1900, currency: "GBP" }, annual: { unitAmount: 19000, currency: "GBP" } },
  { slug: "controller", kind: "seat", name: "Controller", description: "Signs off", monthly: { unitAmount: 4900, currency: "GBP" }, annual: { unitAmount: 49000, currency: "GBP" } },
];

const Harness = ({ initial, onChange = () => {} }) => {
  const [value, setValue] = useState(initial);
  return (
    <SeatPicker
      plans={plans}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
};

describe("SeatPicker", () => {
  it("offers a card per seat package, shows the organisation fee once and counts it in the total", () => {
    render(<Harness initial={{ interval: "month", seats: { controller: 1, contributor: 0, operator: 2, observer: 0 } }} />);
    expect(screen.getAllByRole("group", { name: /package$/ }).map((g) => g.getAttribute("aria-label"))).toEqual([
      "Observer package",
      "Operator package",
      "Contributor package",
      "Controller package",
    ]);
    expect(within(screen.getByRole("group", { name: "Organisation fee" })).getByText("£99.00")).toBeInTheDocument();
    // 99 + 49 + 2 × 6 = 160 a month, for three seats
    expect(screen.getByRole("status")).toHaveTextContent("£160.00 per month for 3 seats and the organisation fee");
  });

  it("gives Observers free up to twice the paid seats and stops there", async () => {
    const changes = vi.fn();
    render(<Harness initial={{ interval: "month", seats: { controller: 1, contributor: 0, operator: 0, observer: 1 } }} onChange={changes} />);
    const observer = screen.getByRole("group", { name: "Observer package" });
    expect(observer).toHaveTextContent("Free up to twice your paid seats (2)");
    await userEvent.click(within(observer).getByRole("button", { name: "Add Observer seat" }));
    expect(within(observer).getByRole("button", { name: "Add Observer seat" })).toBeDisabled();
    // another paid seat raises the limit
    await userEvent.click(screen.getByRole("button", { name: "Add Operator seat" }));
    expect(observer).toHaveTextContent("(4)");
    expect(within(observer).getByRole("button", { name: "Add Observer seat" })).toBeEnabled();
  });

  it("warns when a saved choice already has more free Observers than allowed", () => {
    render(<Harness initial={{ interval: "month", seats: { controller: 1, observer: 5 } }} />);
    expect(screen.getByText(/Observer seats are free up to twice the paid seats \(2 here\)/)).toBeInTheDocument();
  });
});

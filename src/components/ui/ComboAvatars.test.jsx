import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createSignedUrls = vi.fn();
vi.mock("@/supabase-client", () => ({ default: { storage: { from: () => ({ createSignedUrls, createSignedUrl: vi.fn() }) } } }));

import RHFComboBox from "./RHFComboBox";
import ComboField from "./ComboField";
import { employeeOption, initialsOf } from "@/lib/employees";
import { BoxesIcon } from "@/components/icons";

const employees = [
  { id: "e1", name: "Ada Lovelace", jobTitle: "Inspector", active: true, avatarPath: null },
  { id: "e2", name: "Grace Hopper", jobTitle: null, active: true, avatarPath: "users/u2/avatar.webp" },
];

const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const Combo = ({ options }) => {
  const [value, setValue] = useState(null);
  return <RHFComboBox label="Owner" options={options} value={value} onChange={setValue} />;
};

describe("people and pictures in the combo box", () => {
  beforeEach(() => {
    createSignedUrls.mockReset();
    createSignedUrls.mockResolvedValue({ data: [{ path: "users/u2/avatar.webp", signedUrl: "https://files.test/grace.webp", error: null }], error: null });
  });

  it("works out initials from the first and last word", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Mary Ann Evans")).toBe("ME");
    expect(initialsOf("cher")).toBe("C");
    expect(initialsOf("  ")).toBe("?");
  });

  it("shows initials for someone with no picture and the profile picture for a linked sign-in, signing every picture in one request", async () => {
    wrap(<Combo options={employees.map((e) => employeeOption(e))} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Owner" }));
    const list = screen.getByRole("listbox", { name: "Owner" });
    const ada = within(list).getByRole("option", { name: /Ada Lovelace/ });
    expect(ada.querySelector("[data-initials]")).toHaveTextContent("AL");
    expect(ada).toHaveTextContent("Inspector");
    const grace = within(list).getByRole("option", { name: /Grace Hopper/ });
    await waitFor(() => expect(grace.querySelector("img")).toHaveAttribute("src", "https://files.test/grace.webp"));
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith(["users/u2/avatar.webp"], expect.any(Number));
    // The words stay the option's name: the circle is hidden from screen readers.
    expect(grace.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("falls back to initials when the picture cannot be signed", async () => {
    createSignedUrls.mockResolvedValue({ data: [{ path: "users/u2/avatar.webp", signedUrl: null, error: "Not found" }], error: null });
    wrap(<Combo options={employees.map((e) => employeeOption(e))} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Owner" }));
    const grace = screen.getByRole("option", { name: /Grace Hopper/ });
    await waitFor(() => expect(createSignedUrls).toHaveBeenCalled());
    expect(grace.querySelector("[data-initials]")).toHaveTextContent("GH");
    expect(grace.querySelector("img")).toBeNull();
  });

  it("keeps the chosen person's circle in the box once the list closes", async () => {
    wrap(<Combo options={employees.map((e) => employeeOption(e))} />);
    const box = screen.getByRole("combobox", { name: "Owner" });
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("option", { name: /Ada Lovelace/ }));
    expect(box).toHaveValue("Ada Lovelace");
    expect(box.closest("div.relative").querySelector("[data-initials]")).toHaveTextContent("AL");
  });

  it("passes pictures and icons through ComboField, and options without one look as before", async () => {
    wrap(
      <ComboField
        label="Thing"
        value={null}
        onChange={() => {}}
        options={[
          employeeOption(employees[0], { as: "field" }),
          { value: "x", label: "With an icon", icon: BoxesIcon },
          { value: "y", label: "With an image", image: "https://files.test/logo.png" },
          { value: "z", label: "Plain" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Thing" }));
    expect(screen.getByRole("option", { name: /Ada Lovelace/ }).querySelector("[data-initials]")).toHaveTextContent("AL");
    expect(screen.getByRole("option", { name: "With an icon" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("option", { name: "With an image" }).querySelector("img")).toHaveAttribute("src", "https://files.test/logo.png");
    const plain = screen.getByRole("option", { name: "Plain" });
    expect(plain.querySelector("[data-initials], img, svg")).toBeNull();
  });
});

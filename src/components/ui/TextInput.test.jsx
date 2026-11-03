import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TextInput from "./TextInput";

describe("TextInput", () => {
  it("can be typed in and cleared when the page does not handle changes", async () => {
    render(<TextInput placeholder="Current Password..." />);
    const input = screen.getByPlaceholderText("Current Password...");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    await userEvent.type(input, "secret");
    expect(input).toHaveValue("secret");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("starts from a given value and follows it when it loads later", () => {
    const { rerender } = render(<TextInput value={undefined} placeholder="First Name..." />);
    rerender(<TextInput value="Jamie" placeholder="First Name..." />);
    expect(screen.getByPlaceholderText("First Name...")).toHaveValue("Jamie");
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("works controlled, clearing through onChange", async () => {
    const seen = vi.fn();
    const Controlled = () => {
      const [v, setV] = useState("abc");
      return <TextInput name="code" value={v} onChange={(e) => { seen(e.target); setV(e.target.value); }} placeholder="Code" />;
    };
    render(<Controlled />);
    await userEvent.type(screen.getByPlaceholderText("Code"), "d");
    expect(screen.getByPlaceholderText("Code")).toHaveValue("abcd");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByPlaceholderText("Code")).toHaveValue("");
    expect(seen).toHaveBeenLastCalledWith({ value: "", name: "code" });
  });

  it("offers no clear button when disabled", () => {
    render(<TextInput value="locked" disabled placeholder="Locked" />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});

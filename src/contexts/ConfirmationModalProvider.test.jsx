import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConfirmProvider, useConfirm } from "./ConfirmationModalProvider";

function Asker() {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState("none");
  const ask = async () =>
    setAnswer(String(await confirm({ title: "Move Ivy to their company account?", message: "This cannot be undone here.", confirmText: "Move" })));
  return (
    <>
      <button onClick={ask}>Ask</button>
      <output>{answer}</output>
    </>
  );
}

// index.html holds the pop-up's place (#modal-root).
beforeEach(() => {
  if (!document.getElementById("modal-root")) document.body.appendChild(Object.assign(document.createElement("div"), { id: "modal-root" }));
});

describe("the shared confirmation pop-up", () => {
  it("is an alert dialog named by its title and described by its message, and answers with the choice", async () => {
    render(
      <ConfirmProvider>
        <Asker />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = screen.getByRole("alertdialog", { name: "Move Ivy to their company account?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("This cannot be undone here.");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("true");
  });
});

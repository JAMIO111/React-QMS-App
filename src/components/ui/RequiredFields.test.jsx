import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Field from "./Field";
import { SelectField, TextAreaField } from "../master-data/shared";
import { TextAreaField as PickerTextArea } from "../ncr/Pickers";
import TextInput from "./TextInput";

/** `required` marks the label (data-required, drawn as a red * by index.css) and tells assistive tech with aria-required. */
describe("required fields", () => {
  it("mark the label and the control of each kind of field", () => {
    render(
      <>
        <Field label="Title" required />
        <Field label="Note" />
        <SelectField label="Category" required value="a" onChange={() => {}} options={[{ value: "a", label: "A" }]} />
        <TextAreaField label="Reason" required />
        <PickerTextArea label="Picker reason" required value="" onChange={() => {}} />
        <TextInput label="Name" required value="" onChange={() => {}} />
      </>,
    );
    for (const name of ["Title", "Category", "Reason", "Picker reason", "Name"]) {
      expect(screen.getByText(name, { selector: "label" })).toHaveAttribute("data-required", "true");
    }
    expect(screen.getByText("Note", { selector: "label" })).not.toHaveAttribute("data-required");
    expect(screen.getByLabelText("Title")).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("Reason")).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("Picker reason")).toHaveAttribute("aria-required", "true");
  });
});

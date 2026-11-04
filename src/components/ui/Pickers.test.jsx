import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Controller, useForm } from "react-hook-form";
import { addDays, format } from "date-fns";
import RHFComboBox from "./RHFComboBox";
import RHFDatePickerPopout from "./RHFDatePickerPopout";
import RangeSlider from "./RangeSlider";

const options = [
  { id: "c", name: "Cosmetic" },
  { id: "d", name: "Dimensional", hint: "DIM" },
  { id: "x", name: "Obsolete", disabled: true },
];

const Controlled = ({ initial = null, ...props }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RHFComboBox label="Failure mode" options={options} value={value} onChange={setValue} {...props} />
      <output>{String(value)}</output>
    </>
  );
};

describe("RHFComboBox", () => {
  it("is labelled, searches and picks with the keyboard", async () => {
    render(<Controlled />);
    const box = screen.getByRole("combobox", { name: "Failure mode" });
    await userEvent.click(box);
    await userEvent.type(box, "dim");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("d")).toBeInTheDocument();
    expect(box).toHaveValue("Dimensional");
  });

  it("opens with the arrow key, skips nothing and closes on Escape", async () => {
    render(<Controlled initial="c" />);
    const box = screen.getByRole("combobox", { name: "Failure mode" });
    box.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox", { name: "Failure mode" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cosmetic" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not pick disabled options and clears without submitting the form", async () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Controlled initial="d" />
      </form>
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Failure mode" }));
    await userEvent.click(screen.getByRole("option", { name: "Obsolete" }));
    expect(screen.getByText("d")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear Failure mode" }));
    expect(screen.getByText("null")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can be disabled, and waits for its parent value", () => {
    const { rerender } = render(<Controlled disabled />);
    expect(screen.getByRole("combobox", { name: "Failure mode" })).toBeDisabled();
    rerender(<Controlled dependentKey="parentId" dependentValue={null} dependentPlaceholder="Choose a failure mode first" />);
    expect(screen.getByRole("combobox", { name: "Failure mode" })).toHaveAttribute("placeholder", "Choose a failure mode first");
  });

  it("hands the search to the server when filterLocally is off", async () => {
    const onSearchChange = vi.fn();
    render(<Controlled filterLocally={false} onSearchChange={onSearchChange} />);
    const box = screen.getByRole("combobox", { name: "Failure mode" });
    await userEvent.click(box);
    await userEvent.type(box, "zz");
    expect(onSearchChange).toHaveBeenLastCalledWith("zz");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("works with react-hook-form and shows the field error", async () => {
    const Form = () => {
      const { control, handleSubmit } = useForm({ defaultValues: { mode: null } });
      const [saved, setSaved] = useState(null);
      return (
        <form onSubmit={handleSubmit((v) => setSaved(v.mode))}>
          <Controller
            name="mode"
            control={control}
            rules={{ required: "Choose a failure mode" }}
            render={({ field, fieldState }) => <RHFComboBox {...field} error={fieldState.error} label="Failure mode" options={options} required />}
          />
          <button type="submit">Save</button>
          <p>saved:{String(saved)}</p>
        </form>
      );
    };
    render(<Form />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose a failure mode")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Failure mode/ })).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("combobox", { name: /Failure mode/ }));
    await userEvent.click(screen.getByRole("option", { name: /Dimensional/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved:d")).toBeInTheDocument();
  });
});

describe("RHFDatePickerPopout", () => {
  const Dated = (props) => {
    const [value, setValue] = useState(props.initial ?? null);
    return (
      <form onSubmit={props.onSubmit}>
        <RHFDatePickerPopout label="Detected on" value={value} onChange={setValue} {...props} />
        <output>{value instanceof Date ? `date:${format(value, "yyyy-MM-dd")}` : String(value)}</output>
      </form>
    );
  };

  it("reads and writes ISO dates without shifting the day", async () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<Dated initial="2026-03-01" valueFormat="iso" onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: /^Detected on/ })).toHaveTextContent("Sun 1 March 2026");
    await userEvent.click(screen.getByRole("button", { name: /^Detected on/ }));
    const cal = screen.getByRole("dialog", { name: "Choose detected on" });
    await userEvent.click(within(cal).getByRole("button", { name: "Next month" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Wednesday 15 April 2026" }));
    expect(screen.getByText("2026-04-15")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("gives Dates by default and disables days after maxDate", async () => {
    const today = new Date();
    render(<Dated maxDate={today} />);
    await userEvent.click(screen.getByRole("button", { name: /^Detected on/ }));
    const cal = screen.getByRole("dialog");
    const tomorrow = addDays(today, 1);
    if (tomorrow.getMonth() === today.getMonth()) {
      expect(within(cal).getByRole("button", { name: format(tomorrow, "EEEE d MMMM yyyy") })).toBeDisabled();
    }
    await userEvent.click(within(cal).getByRole("button", { name: format(today, "EEEE d MMMM yyyy") }));
    expect(screen.getByText(`date:${format(today, "yyyy-MM-dd")}`)).toBeInTheDocument();
  });

  it("closes on Escape, can be cleared and disabled", async () => {
    const { rerender } = render(<Dated initial="2026-03-01" valueFormat="iso" clearable />);
    await userEvent.click(screen.getByRole("button", { name: /^Detected on/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear Detected on" }));
    expect(screen.getByText("null")).toBeInTheDocument();
    rerender(<Dated disabled />);
    expect(screen.getByRole("button", { name: /^Detected on/ })).toBeDisabled();
  });
});

describe("RangeSlider", () => {
  const Ranged = (props) => {
    const [v, setV] = useState([0, 100]);
    return (
      <>
        <RangeSlider label="Total cost" min={0} max={100} value={v} onChange={setV} format={(n) => `£${n}`} {...props} />
        <output>{v.join("-")}</output>
      </>
    );
  };

  it("has two labelled handles that cannot cross, and shows the chosen range", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<Ranged />);
    expect(screen.getByRole("group", { name: "Total cost" })).toHaveTextContent("Any");
    const lo = screen.getByRole("slider", { name: "Total cost minimum" });
    const hi = screen.getByRole("slider", { name: "Total cost maximum" });
    fireEvent.change(hi, { target: { value: "40" } });
    fireEvent.change(lo, { target: { value: "70" } });
    expect(screen.getByText("40-40")).toBeInTheDocument();
    fireEvent.change(lo, { target: { value: "10" } });
    expect(screen.getByText("£10 – £40")).toBeInTheDocument();
    expect(lo).toHaveAttribute("aria-valuetext", "£10");
  });

  it("uses native range inputs, so the browser gives keyboard control", () => {
    render(<Ranged />);
    for (const name of ["Total cost minimum", "Total cost maximum"]) {
      const handle = screen.getByRole("slider", { name });
      expect(handle).toHaveAttribute("type", "range");
      expect(handle).toHaveAttribute("step", "1");
    }
  });

  it("can be disabled", () => {
    render(<Ranged disabled hint="No costs yet." />);
    expect(screen.getByRole("slider", { name: "Total cost minimum" })).toBeDisabled();
    expect(screen.getByText("No costs yet.")).toBeInTheDocument();
  });
});

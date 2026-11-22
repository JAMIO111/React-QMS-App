import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { useImportLocks } from "../../hooks/useImportLocks";
import { lockKey } from "../../lib/importLocks";
import Field from "./Field";
import RHFComboBox from "./RHFComboBox";
import Switch from "./Switch";
import Tooltip from "./Tooltip";

beforeEach(() => apiFetch.mockReset());

describe("a field managed by an import", () => {
  it("is disabled and carries a lock whose tooltip explains why, on hover and on keyboard focus, and closes on Escape", async () => {
    render(<Field label="Name" value="Lathe" onChange={() => {}} lockedBy="ERP" />);
    expect(screen.getByRole("textbox", { name: /^Name/ })).toBeDisabled();
    const mark = screen.getByRole("button", { name: "Managed by ERP" });
    await userEvent.hover(mark);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Managed by ERP. It updates this field on a schedule");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.unhover(mark);
    await userEvent.tab(); // the disabled input is skipped, so the lock is the first stop
    expect(mark).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("tells people how to edit it in Fortress", async () => {
    render(<Field label="Name" value="" onChange={() => {}} lockedBy="ERP" />);
    await userEvent.hover(screen.getByRole("button", { name: "Managed by ERP" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Fortress wins.*switch the schedule off/);
  });

  it("is left alone when nothing manages it", () => {
    render(<Field label="Name" value="Lathe" onChange={() => {}} />);
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Managed by/ })).toBeNull();
  });

  it("shows the lock on a switch and on a combo box, and a click on the lock does not flip the switch", async () => {
    const onChange = vi.fn();
    render(
      <>
        <Switch checked onChange={onChange} disabled lockedBy="ERP">
          Active
        </Switch>
        <RHFComboBox label="Site" value={null} onChange={() => {}} options={[]} disabled lockedBy="MES" />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Managed by ERP" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Managed by MES" })).toBeInTheDocument();
  });
});

describe("Tooltip", () => {
  it("shows nothing without content", () => {
    render(
      <Tooltip content="">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Trigger" })).toBeInTheDocument();
  });
});

describe("lockKey", () => {
  it("turns a form's own names into the catalogue's", () => {
    expect(["siteId", "unitCode", "gaugeTypeId", "name", "intervalValue", "notes"].map(lockKey)).toEqual(["site", "unit", "gaugeType", "name", "intervalValue", "notes"]);
  });
});

const Probe = ({ record }) => {
  const { lock, locked } = useImportLocks("machine", record);
  return <div data-testid="p">{JSON.stringify({ name: lock("name"), code: lock("code"), locked })}</div>;
};
const withClient = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe("useImportLocks", () => {
  it("asks for the record's locks and hands back props to spread on the locked fields", async () => {
    apiFetch.mockResolvedValue({ data: [{ field: "name", connection: { id: "k", name: "ERP" } }] });
    withClient(<Probe record="m1" />);
    expect(await screen.findByText(/"lockedBy":"ERP"/)).toHaveTextContent('"name":{"lockedBy":"ERP","disabled":true},"code":{},"locked":true');
    expect(apiFetch).toHaveBeenCalledWith("/import-locks?entityType=machine&recordId=m1", { organisationId: "org-1" });
  });

  it("does not ask for a record that is not saved yet", () => {
    withClient(<Probe record={undefined} />);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("p")).toHaveTextContent('"name":{},"code":{},"locked":false');
  });
});

import { useCallback, useMemo, useState } from "react";
import Switch from "@/components/ui/Switch";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { useMachines, useProcessControlMutation } from "../../hooks/useProcessControl";
import ActiveAlertsBanner from "../documentation/ActiveAlertsBanner";
import DocumentsInForce from "../documents/DocumentsInForce";
import LinkedFmeas from "../fmea/LinkedFmeas";
import LinkedRisks from "../risk/LinkedRisks";
import { ActiveBadge, DataList, FormError, SearchBox, SelectField } from "./shared";
import CTAButton from "@/components/CTAButton";
import { useQuickSave } from "../../hooks/useQuickSave";
import CustomFieldsCard, { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";
import { changesSince } from "../../lib/editConflicts";
import { useImportLocks } from "../../hooks/useImportLocks";
import LinkedChanges from "../change/LinkedChanges";

const MachineForm = ({ machine, onDone }) => {
  const mutation = useProcessControlMutation();
  const quickSave = useQuickSave(useProcessControlMutation());
  const { showToast } = useToast();
  const sites = useSites();
  const [form, setForm] = useState({
    code: machine?.code ?? "",
    name: machine?.name ?? "",
    siteId: machine?.site?.id ?? null,
    workCentre: machine?.workCentre ?? "",
    description: machine?.description ?? "",
    active: machine?.active ?? true,
  });
  const [customValues, setCustomValues] = useState({});
  const [opened] = useState(machine);
  const { lock } = useImportLocks("machine", machine?.id);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      siteId: form.siteId,
      workCentre: form.workCentre.trim(),
      description: form.description.trim(),
      ...(machine ? { active: form.active } : withCustomValues(customValues)),
    };
    if (machine) {
      // Shown at once (the hook's guess); put back with a toast if the server refuses.
      quickSave({ path: `/machines/${machine.id}`, method: "PATCH", body: changesSince(opened, body) });
      onDone();
      return;
    }
    mutation.mutate(
      { path: "/machines", method: "POST", body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `Machine ${body.code.toUpperCase()} added.` });
          onDone();
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {machine && <ActiveAlertsBanner machineId={machine.id} />}
      {machine && <DocumentsInForce machineId={machine.id} />}
      {machine && <LinkedFmeas kind="machine" id={machine.id} />}
      {machine && <LinkedRisks kind="machine" id={machine.id} plain />}
      {machine && <LinkedChanges kind="machine" id={machine.id} plain />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Code" value={form.code} onChange={set("code")} required maxLength={40} hint="e.g. LATHE-01" {...lock("code")} />
        <Field label="Name" value={form.name} onChange={set("name")} required maxLength={120} {...lock("name")} />
        <SelectField
          label="Site"
          value={form.siteId}
          onChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
          options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          {...lock("site")}
        />
        <Field label="Work centre / line" value={form.workCentre} onChange={set("workCentre")} maxLength={100} {...lock("workCentre")} />
      </div>
      <Field label="Description" value={form.description} onChange={set("description")} maxLength={1000} {...lock("description")} />
      {machine && (
        <Switch className="text-sm text-primary-text" checked={form.active} onChange={set("active")} {...lock("active")}>
          Active (inactive machines are hidden from pickers)
        </Switch>
      )}
      {!machine && <CustomFieldInputs entityType="machine" values={customValues} onChange={setCustomValues} />}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : machine ? "Save changes" : "Add machine"}
        </CTAButton>
      </div>
    </form>
  );
};

/** Machines and work centres used by control plans, inspections and SPC filters. */
const MachinesPage = () => {
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | machine
  const query = useMachines({ q, includeInactive });
  const onSearch = useCallback((v) => setQ(v), []);

  const columns = useMemo(
    () => [
      {
        id: "code",
        header: "Code",
        headerString: "Code",
        size: 140,
        cell: ({ row }) =>
          canManage ? (
            <button type="button" className="table-row-item font-medium text-link-color hover:underline cursor-pointer" onClick={() => setEditing(row.original)}>
              {row.original.code}
            </button>
          ) : (
            <span className="table-row-item font-medium">{row.original.code}</span>
          ),
      },
      { id: "name", accessorKey: "name", header: "Name", headerString: "Name", size: 240, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      { id: "site", header: "Site", headerString: "Site", size: 160, cell: ({ row }) => <span className="table-row-item">{row.original.site?.name ?? "—"}</span> },
      { id: "workCentre", accessorKey: "workCentre", header: "Work centre", headerString: "Work centre", size: 160, cell: (i) => <span className="table-row-item">{i.getValue() ?? "—"}</span> },
      { id: "active", accessorKey: "active", header: "Status", headerString: "Status", size: 110, meta: { align: "center" }, cell: (i) => <ActiveBadge active={i.getValue()} /> },
    ],
    [canManage]
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Machines</h1>
          <p className="text-sm text-secondary-text">Machines and work centres. Control plans, inspections and SPC charts refer to them.</p>
        </div>
        {canManage && (
          <CTAButton buttonType="button" type="main" size="lg" className="flex items-center gap-1" onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> Add machine
          </CTAButton>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox label="Search machines" onSearch={onSearch} />
        <Switch className="text-sm text-primary-text" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
          Show inactive
        </Switch>
      </div>
      <DataList entityType="machine"
        storageKey="master:machines"
        columns={columns}
        query={query}
        ariaLabel="Machines"
        emptyMessage={q ? `No machines match “${q}”.` : "No machines yet."}
        onOpen={canManage ? setEditing : undefined}
      />
      {editing && (
        <Dialog title={editing === "new" ? "Add machine" : `Edit ${editing.code}`} onClose={() => setEditing(null)}>
          <MachineForm machine={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
          {editing !== "new" && (
            <CustomFieldsCard
              entityType="machine"
              record={query.data?.items?.find((m) => m.id === editing.id) ?? editing}
              editable={canManage}
              className="mt-4"
            />
          )}
        </Dialog>
      )}
    </div>
  );
};

export default MachinesPage;

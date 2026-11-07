import { useCallback, useMemo, useState } from "react";
import Switch from "@/components/ui/Switch";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMasterDataMutation, useParties } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { ActiveBadge, buttonClass, DataList, SearchBox } from "./shared";

const LABELS = {
  customers: { title: "Customers", one: "customer", intro: "Organisations you supply. Parts and customer complaints link to them." },
  suppliers: { title: "Suppliers", one: "supplier", intro: "Organisations that supply you. Supplier non-conformances link to them." },
};

const emptyForm = { code: "", name: "", displayName: "", companyNumber: "", vatNumber: "", notes: "", active: true };

const PartyForm = ({ kind, party, onDone }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState(party ? { ...emptyForm, ...Object.fromEntries(Object.entries(party).map(([k, v]) => [k, v ?? ""])) } : emptyForm);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const label = LABELS[kind].one;

  const submit = (e) => {
    e.preventDefault();
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      displayName: form.displayName.trim(),
      companyNumber: form.companyNumber.trim(),
      vatNumber: form.vatNumber.trim(),
      notes: form.notes.trim(),
      ...(party ? { active: form.active } : {}),
    };
    mutation.mutate(
      { path: party ? `/${kind}/${party.id}` : `/${kind}`, method: party ? "PATCH" : "POST", body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `The ${label} was ${party ? "updated" : "added"}.` });
          onDone();
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Code" value={form.code} onChange={set("code")} required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,19}" hint="Short reference, e.g. ACME" />
        <Field label="Name" value={form.name} onChange={set("name")} required maxLength={200} />
        <Field label="Display name" value={form.displayName} onChange={set("displayName")} maxLength={100} hint="Shown in lists (optional)" />
        <Field label="Company number" value={form.companyNumber} onChange={set("companyNumber")} maxLength={40} />
        <Field label="VAT number" value={form.vatNumber} onChange={set("vatNumber")} maxLength={40} />
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium text-primary-text">
        Notes
        <textarea
          value={form.notes}
          onChange={set("notes")}
          maxLength={2000}
          rows={3}
          className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary"
        />
      </label>
      {party && (
        <Switch className="text-sm text-primary-text" checked={form.active} onChange={set("active")}>
          Active (inactive {label}s are hidden from pickers)
        </Switch>
      )}
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : party ? "Save changes" : `Add ${label}`}
        </button>
      </div>
    </form>
  );
};

/** Customers or suppliers register (kind: "customers" | "suppliers"). */
const PartiesPage = ({ kind }) => {
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | party
  const query = useParties(kind, { q, includeInactive });
  const onSearch = useCallback((v) => setQ(v), []);
  const label = LABELS[kind];

  const columns = useMemo(
    () => [
      {
        id: "code",
        header: "Code",
        headerString: "Code",
        size: 120,
        cell: ({ row }) =>
          canManage ? (
            <button type="button" className="table-row-item font-medium text-link-color hover:underline cursor-pointer" onClick={() => setEditing(row.original)}>
              {row.original.code}
            </button>
          ) : (
            <span className="table-row-item font-medium">{row.original.code}</span>
          ),
      },
      { id: "name", accessorKey: "name", header: "Name", headerString: "Name", size: 260, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      { id: "displayName", accessorKey: "displayName", header: "Display name", headerString: "Display name", size: 180, cell: (i) => <span className="table-row-item">{i.getValue() ?? "—"}</span> },
      { id: "vatNumber", accessorKey: "vatNumber", header: "VAT number", headerString: "VAT number", size: 150, cell: (i) => <span className="table-row-item">{i.getValue() ?? "—"}</span> },
      { id: "active", accessorKey: "active", header: "Status", headerString: "Status", size: 110, meta: { align: "center" }, cell: (i) => <ActiveBadge active={i.getValue()} /> },
    ],
    [canManage]
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">{label.title}</h1>
          <p className="text-sm text-secondary-text">{label.intro}</p>
        </div>
        {canManage && (
          <button type="button" className={`${buttonClass.primary} flex items-center gap-1`} onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> Add {label.one}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox label={`Search ${label.title.toLowerCase()}`} onSearch={onSearch} />
        <Switch className="text-sm text-primary-text" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
          Show inactive
        </Switch>
      </div>
      <DataList
        storageKey={`master:${kind}`}
        columns={columns}
        query={query}
        ariaLabel={label.title}
        emptyMessage={q ? `No ${label.title.toLowerCase()} match “${q}”.` : `No ${label.title.toLowerCase()} yet.`}
        onOpen={canManage ? setEditing : undefined}
      />
      {editing && (
        <Dialog title={editing === "new" ? `Add ${label.one}` : `Edit ${editing.code}`} onClose={() => setEditing(null)}>
          <PartyForm kind={kind} party={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
    </div>
  );
};

export default PartiesPage;

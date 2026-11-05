import { useCallback, useMemo, useState } from "react";
import Switch from "@/components/ui/Switch";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMasterDataMutation, useParties, useParts } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { ActiveBadge, buttonClass, DataList, SearchBox } from "./shared";

/** Customer picker (active customers). */
export const CustomerSelect = ({ value, onChange, id }) => {
  const customers = useParties("customers", {});
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-primary-text focus:outline-none focus:border-brand-primary">
      <option value="">— None —</option>
      {(customers.data?.items ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.code} · {c.displayName ?? c.name}
        </option>
      ))}
    </select>
  );
};

const NewPartForm = ({ onDone }) => {
  const mutation = useMasterDataMutation();
  const navigate = useNavigate();
  const [form, setForm] = useState({ partNumber: "", name: "", description: "", customerId: null, revision: "A", drawingRef: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: "/parts",
        body: {
          partNumber: form.partNumber.trim(),
          name: form.name.trim(),
          description: form.description.trim(),
          customerId: form.customerId,
          ...(form.revision.trim() ? { initialRevision: { revision: form.revision.trim(), drawingRef: form.drawingRef.trim() } } : {}),
        },
      },
      { onSuccess: (part) => navigate(`/Parts/${part.id}`) }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Part number" value={form.partNumber} onChange={set("partNumber")} required maxLength={60} />
        <Field label="Name" value={form.name} onChange={set("name")} required maxLength={200} />
      </div>
      <Field label="Description" value={form.description} onChange={set("description")} maxLength={2000} />
      <div className="flex flex-col gap-1">
        <label htmlFor="new-part-customer" className="text-sm font-medium text-primary-text">
          Customer
        </label>
        <CustomerSelect id="new-part-customer" value={form.customerId} onChange={(v) => setForm((f) => ({ ...f, customerId: v }))} />
      </div>
      <fieldset className="grid grid-cols-1 gap-3 rounded-xl border border-border-color p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm text-secondary-text">First revision (draft)</legend>
        <Field label="Revision" value={form.revision} onChange={set("revision")} maxLength={10} hint="Leave empty to add revisions later" />
        <Field label="Drawing reference" value={form.drawingRef} onChange={set("drawingRef")} maxLength={100} />
      </fieldset>
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
          {mutation.isPending ? "Adding…" : "Add part"}
        </button>
      </div>
    </form>
  );
};

const PartsPage = () => {
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const query = useParts({ q, includeInactive });
  const onSearch = useCallback((v) => setQ(v), []);

  const columns = useMemo(
    () => [
      {
        id: "partNumber",
        header: "Part number",
        headerString: "Part number",
        size: 170,
        cell: ({ row }) => (
          <Link to={`/Parts/${row.original.id}`} className="table-row-item font-medium text-link-color hover:underline">
            {row.original.partNumber}
          </Link>
        ),
      },
      { id: "name", accessorKey: "name", header: "Name", headerString: "Name", size: 260, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      {
        id: "currentRevision",
        accessorKey: "currentRevision",
        header: "Current revision",
        headerString: "Current revision",
        size: 140,
        meta: { align: "center" },
        cell: (i) => (i.getValue() ? <span className="table-row-item font-mono">{i.getValue()}</span> : <span className="table-row-item text-secondary-text">None released</span>),
      },
      {
        id: "customer",
        header: "Primary customer",
        headerString: "Primary customer",
        size: 200,
        cell: ({ row }) => <span className="table-row-item">{row.original.customer ? row.original.customer.name : "—"}</span>,
      },
      { id: "active", accessorKey: "active", header: "Status", headerString: "Status", size: 110, meta: { align: "center" }, cell: (i) => <ActiveBadge active={i.getValue()} /> },
    ],
    []
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Parts</h1>
          <p className="text-sm text-secondary-text">Parts and their drawing revisions. Inspection plans and NCRs refer to a revision.</p>
        </div>
        {canManage && (
          <button type="button" className={`${buttonClass.primary} flex items-center gap-1`} onClick={() => setAdding(true)}>
            <PlusIcon className="h-4 w-4" /> Add part
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox label="Search part number or name" onSearch={onSearch} />
        <Switch className="text-sm text-primary-text" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
          Show inactive
        </Switch>
      </div>
      <DataList
        storageKey="master:parts"
        columns={columns}
        query={query}
        ariaLabel="Parts"
        emptyMessage={q ? `No parts match “${q}”.` : "No parts yet."}
        onOpen={(part) => navigate(`/Parts/${part.id}`)}
      />
      {adding && (
        <Dialog title="Add part" onClose={() => setAdding(false)}>
          <NewPartForm onDone={() => setAdding(false)} />
        </Dialog>
      )}
    </div>
  );
};

export default PartsPage;

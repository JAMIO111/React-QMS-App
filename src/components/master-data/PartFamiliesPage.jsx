import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePartFamilies, useProcessControlMutation } from "../../hooks/useProcessControl";
import { ActiveBadge, buttonClass, DataList, FormError, SearchBox } from "./shared";

/** Add or edit a part family (code, name, description, active). */
export const PartFamilyForm = ({ family, onDone, onCreated }) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState({ code: family?.code ?? "", name: family?.name ?? "", description: family?.description ?? "", active: family?.active ?? true });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const body = { code: form.code.trim(), name: form.name.trim(), description: form.description.trim(), ...(family ? { active: form.active } : {}) };
    mutation.mutate(
      { path: family ? `/part-families/${family.id}` : "/part-families", method: family ? "PATCH" : "POST", body },
      {
        onSuccess: (saved) => {
          showToast({ type: "success", title: "Saved", message: `Part family ${saved.code} ${family ? "updated" : "added"}.` });
          onDone();
          if (!family) onCreated?.(saved);
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Code" value={form.code} onChange={set("code")} required maxLength={40} hint="e.g. HCR" />
        <Field label="Name" value={form.name} onChange={set("name")} required maxLength={200} hint="e.g. Hydraulic cylinder rods" />
      </div>
      <Field
        label="Description"
        value={form.description}
        onChange={set("description")}
        maxLength={2000}
        hint="What the parts share: material, route, inspection strategy."
      />
      {family && (
        <label className="flex items-center gap-2 text-sm text-primary-text">
          <input type="checkbox" checked={form.active} onChange={set("active")} /> Active
        </label>
      )}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : family ? "Save changes" : "Add family"}
        </button>
      </div>
    </form>
  );
};

/** Part families: groups of part numbers that share a process and inspection strategy. */
const PartFamiliesPage = () => {
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const query = usePartFamilies({ q, includeInactive });
  const onSearch = useCallback((v) => setQ(v), []);

  const columns = useMemo(
    () => [
      {
        id: "code",
        header: "Code",
        headerString: "Code",
        size: 140,
        cell: ({ row }) => (
          <Link to={`/Part-Families/${row.original.id}`} className="table-row-item font-medium text-link-color hover:underline">
            {row.original.code}
          </Link>
        ),
      },
      { id: "name", accessorKey: "name", header: "Name", headerString: "Name", size: 280, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      { id: "partCount", accessorKey: "partCount", header: "Parts", headerString: "Parts", size: 90, meta: { align: "center" }, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      { id: "planCount", accessorKey: "planCount", header: "Control plans", headerString: "Control plans", size: 130, meta: { align: "center" }, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      { id: "active", accessorKey: "active", header: "Status", headerString: "Status", size: 110, meta: { align: "center" }, cell: (i) => <ActiveBadge active={i.getValue()} /> },
    ],
    []
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Part families</h1>
          <p className="text-sm text-secondary-text">Related part numbers that share a process route and inspection strategy, so one control plan can cover them.</p>
        </div>
        {canManage && (
          <button type="button" className={`${buttonClass.primary} flex items-center gap-1`} onClick={() => setAdding(true)}>
            <PlusIcon className="h-4 w-4" /> Add family
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox label="Search families" onSearch={onSearch} />
        <label className="flex items-center gap-2 text-sm text-primary-text">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <DataList
        storageKey="master:part-families"
        columns={columns}
        query={query}
        ariaLabel="Part families"
        emptyMessage={q ? `No families match “${q}”.` : "No part families yet."}
        onOpen={(f) => navigate(`/Part-Families/${f.id}`)}
      />
      {adding && (
        <Dialog title="Add part family" onClose={() => setAdding(false)}>
          <PartFamilyForm onDone={() => setAdding(false)} onCreated={(f) => navigate(`/Part-Families/${f.id}`)} />
        </Dialog>
      )}
    </div>
  );
};

export default PartFamiliesPage;

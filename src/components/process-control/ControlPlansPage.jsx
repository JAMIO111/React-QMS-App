import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { usePermissions } from "../../hooks/useQmsApi";
import { useControlPlans, usePartFamilies, useProcessControlMutation } from "../../hooks/useProcessControl";
import { ActiveBadge, buttonClass, DataList, FormError, SearchBox, SelectField } from "../master-data/shared";
import { RevisionStatusPill } from "./shared";

const STATUS_FILTERS = [
  { value: "effective", label: "With an effective revision" },
  { value: "no_effective", label: "No effective revision" },
  { value: "pending_approval", label: "Awaiting approval" },
];

const NewPlanForm = ({ onDone }) => {
  const mutation = useProcessControlMutation();
  const navigate = useNavigate();
  const families = usePartFamilies();
  const [form, setForm] = useState({ planCode: "", title: "", description: "", partFamilyId: null, revisionCode: "A" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: "/control-plans",
        body: {
          planCode: form.planCode.trim(),
          title: form.title.trim(),
          description: form.description.trim(),
          revisionCode: form.revisionCode.trim() || "A",
          ...(form.partFamilyId ? { partFamilyId: form.partFamilyId } : {}),
        },
      },
      { onSuccess: (plan) => navigate(`/Process-Control/Plans/${plan.id}`) }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Plan code" value={form.planCode} onChange={set("planCode")} required maxLength={40} hint="e.g. CP-HCR-001" />
        <Field label="First revision" value={form.revisionCode} onChange={set("revisionCode")} required maxLength={10} hint="Your convention: A, 01, 1.0…" />
      </div>
      <Field label="Title" value={form.title} onChange={set("title")} required maxLength={200} hint="e.g. Hydraulic cylinder rods – turning and finishing" />
      <Field label="Description" value={form.description} onChange={set("description")} maxLength={2000} />
      <SelectField
        label="Part family"
        value={form.partFamilyId}
        onChange={(v) => setForm((f) => ({ ...f, partFamilyId: v }))}
        options={(families.data?.items ?? []).map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
        hint="The plan applies to this family. You can narrow or add scope later."
      />
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create plan"}
        </button>
      </div>
    </form>
  );
};

/** Register of process control plans. */
const ControlPlansPage = () => {
  const { can } = usePermissions();
  const canManage = can("process_control.manage");
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(null);
  const [partFamilyId, setPartFamilyId] = useState(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const families = usePartFamilies({ includeInactive: true });
  const query = useControlPlans({ q, status, partFamilyId, includeInactive });
  const onSearch = useCallback((v) => setQ(v), []);

  const columns = useMemo(
    () => [
      {
        id: "planCode",
        header: "Plan",
        headerString: "Plan",
        size: 150,
        cell: ({ row }) => (
          <Link to={`/Process-Control/Plans/${row.original.id}`} className="table-row-item font-medium text-link-color hover:underline">
            {row.original.planCode}
          </Link>
        ),
      },
      { id: "title", accessorKey: "title", header: "Title", headerString: "Title", size: 300, cell: (i) => <span className="table-row-item">{i.getValue()}</span> },
      {
        id: "families",
        header: "Scope",
        headerString: "Scope",
        size: 180,
        cell: ({ row }) => {
          const scope = [...row.original.families, ...(row.original.parts ?? [])];
          return <span className="table-row-item">{scope.length ? scope.join(", ") : "—"}</span>;
        },
      },
      {
        id: "effectiveRevision",
        header: "Effective",
        headerString: "Effective revision",
        size: 110,
        meta: { align: "center" },
        cell: ({ row }) =>
          row.original.effectiveRevision ? (
            <span className="table-row-item font-mono">{row.original.effectiveRevision}</span>
          ) : (
            <span className="table-row-item text-secondary-text">None</span>
          ),
      },
      {
        id: "openRevision",
        header: "In progress",
        headerString: "Revision in progress",
        size: 200,
        cell: ({ row }) =>
          row.original.openRevision ? (
            <span className="table-row-item">
              <span className="mr-2 font-mono">{row.original.openRevision.revisionCode}</span>
              <RevisionStatusPill status={row.original.openRevision.status} />
            </span>
          ) : (
            <span className="table-row-item text-secondary-text">—</span>
          ),
      },
      { id: "owner", header: "Owner", headerString: "Owner", size: 160, cell: ({ row }) => <span className="table-row-item">{row.original.owner?.name ?? "—"}</span> },
      { id: "active", accessorKey: "active", header: "Status", headerString: "Status", size: 110, meta: { align: "center" }, cell: (i) => <ActiveBadge active={i.getValue()} /> },
    ],
    []
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Control plans</h1>
          <p className="text-sm text-secondary-text">
            What to inspect, where, how and how often. Plans are revision-controlled: approved revisions are never edited.
          </p>
        </div>
        {canManage && (
          <button type="button" className={`${buttonClass.primary} flex items-center gap-1`} onClick={() => setAdding(true)}>
            <PlusIcon className="h-4 w-4" /> New plan
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search plan code or title" onSearch={onSearch} />
        <SelectField
          label="Part family"
          placeholder="All families"
          value={partFamilyId}
          onChange={setPartFamilyId}
          options={(families.data?.items ?? []).map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
          className="w-56"
        />
        <SelectField label="Revision status" placeholder="Any" value={status} onChange={setStatus} options={STATUS_FILTERS} className="w-56" />
        <label className="flex items-center gap-2 pb-2 text-sm text-primary-text">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <DataList
        storageKey="process-control:plans"
        columns={columns}
        query={query}
        ariaLabel="Control plans"
        emptyMessage={q || status || partFamilyId ? "No plans match these filters." : "No control plans yet."}
        onOpen={(p) => navigate(`/Process-Control/Plans/${p.id}`)}
      />
      {adding && (
        <Dialog title="New control plan" onClose={() => setAdding(false)}>
          <NewPlanForm onDone={() => setAdding(false)} />
        </Dialog>
      )}
    </div>
  );
};

export default ControlPlansPage;

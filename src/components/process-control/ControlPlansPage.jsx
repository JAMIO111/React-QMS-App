import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { REVISION_STATUS, useControlPlans, usePartFamilies, useProcessControlMutation } from "../../hooks/useProcessControl";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { CONTROL_PLAN_FILTER_KEYS, useControlPlanFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { REVISION_STATE_OPTIONS } from "../../lib/controlPlans";
import { formatDay } from "../../lib/qualityAlerts";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import { FormError, SelectField } from "../master-data/shared";
import PlanFilterPane from "./PlanFilterPane";
import { DEFAULT_HIDDEN, planColumns, planHref } from "./planColumns";

const rowLabel = (r) => r.planCode;

const toCsvRow = (p) => ({
  plan: p.planCode,
  title: p.title,
  description: p.description ?? "",
  scope: [...p.families, ...(p.parts ?? [])].join(", "),
  effective_revision: p.effectiveRevision ?? "",
  revision_in_progress: p.openRevision ? `${p.openRevision.revisionCode} (${REVISION_STATUS[p.openRevision.status]?.label ?? p.openRevision.status})` : "",
  owner: p.owner?.name ?? "",
  status: p.active ? "Active" : "Inactive",
  updated: p.updatedAt?.slice(0, 10) ?? "",
  created: p.createdAt?.slice(0, 10) ?? "",
});

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
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create plan"}
        </CTAButton>
      </div>
    </form>
  );
};

/**
 * Control plans: the register — the same server-side table, column set, header search and filter drawer as the other registers. Active plans by
 * default; filters live in the URL. Plans are revision-controlled: approved revisions are never edited.
 */
const ControlPlansPage = () => {
  const { can } = usePermissions();
  const canManage = can("process_control.manage");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useControlPlanFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "planCode", desc: false }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [adding, setAdding] = useState(false);
  const prefs = useTablePreferences("control-plan-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };
  const families = usePartFamilies({ includeInactive: true });
  const familyList = useMemo(() => families.data?.items ?? [], [families.data]);

  const setPage = useCallback(
    (p) =>
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", p);
        return params;
      }),
    [setSearchParams]
  );
  // A new sort order starts from the first page.
  const setSorting = (updater) => {
    setSortingState(updater);
    if (page !== 1) setPage(1);
  };
  const sortColumn = sorting[0] ? planColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useControlPlans({
    status: filters.status,
    partFamilyId: filters.family,
    owner: filters.owner,
    active: filters.active,
    from: filters.from,
    to: filters.to,
    q: filters.search,
    sort: sortColumn,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize]);

  // The header search box feeds the register search (plan code, title, description, family code, part number).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const open = (p) => navigate(planHref(p));
  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const between = (lo, hi) => (lo && hi ? `${formatDay(lo)} – ${formatDay(hi)}` : lo ? `from ${formatDay(lo)}` : `up to ${formatDay(hi)}`);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Revisions: ${list(filters.status).map((k) => REVISION_STATE_OPTIONS.find((o) => o.key === k)?.label ?? k).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.family ? [{ key: "family", label: `Family: ${list(filters.family).map((id) => familyList.find((f) => f.id === id)?.code ?? "…").join(", ")}`, clear: { family: "" } }] : []),
    ...(filters.active ? [{ key: "active", label: filters.active === "all" ? "Active and inactive" : "Inactive plans", clear: { active: "" } }] : []),
    ...(filters.owner === "me" ? [{ key: "owner", label: "Owned by me", clear: { owner: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "changed", label: `Changed ${between(filters.from, filters.to)}`, clear: { from: "", to: "" } }] : []),
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "control plan" : "control plans"}${filters.active ? "" : " (active)"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "control-plans.csv")} text="Export CSV" type="success" title="Export the selected control plans to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={planColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {canManage && <CTAButton callbackFn={() => setAdding(true)} text="New plan" type="main" icon={PlusIcon} iconSize="h-6 w-6" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <PlanFilterPane families={familyList} onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span key={f.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button type="button" aria-label={`Remove filter ${f.label}`} onClick={() => clearFilters(f.clear)} className="rounded-full p-0.5 hover:bg-brand-primary/20 cursor-pointer">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => clearFilters(Object.fromEntries(CONTROL_PLAN_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
            Clear all
          </button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <TableWrapper
          data={rows}
          isLoading={isLoading || isFetching}
          error={error}
          totalCount={total}
          page={page}
          pageSize={pageSize}
          setSelectedRows={setSelectedRows}
          rowActions={rowActions}
          onRefresh={refetch}
          sorting={sorting}
          setSorting={setSorting}
          columns={planColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={open}
          ariaLabel="Control plans"
          rowLabel={rowLabel}
        />
      </div>
      {adding && (
        <Dialog title="New control plan" onClose={() => setAdding(false)}>
          <NewPlanForm onDone={() => setAdding(false)} />
        </Dialog>
      )}
    </div>
  );
};

export default ControlPlansPage;

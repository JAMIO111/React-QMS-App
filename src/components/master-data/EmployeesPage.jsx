import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PencilIcon, PlusIcon, PowerIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useEmployeeRegister, useMasterDataMutation } from "../../hooks/useMasterData";
import { usePermissions, useAllDepartments, useSites } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { EMPLOYEE_FILTER_KEYS, useEmployeeFilters } from "../../hooks/useUrlFilters";
import { describeApiError } from "../../lib/api-client";
import { exportCSV } from "../../lib/csvHelper";
import { formatDate } from "../../lib/ncr";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import EmployeeDialog from "./EmployeeDialog";
import EmployeeFilterPane from "./EmployeeFilterPane";
import { DEFAULT_HIDDEN, employeeColumns } from "./employeeColumns";

const rowLabel = (r) => r.name;

const toCsvRow = (r) => ({
  name: r.name,
  first_name: r.firstName ?? "",
  surname: r.surname ?? "",
  job_title: r.jobTitle ?? "",
  employee_number: r.employeeNumber ?? "",
  email: r.email ?? "",
  site: r.site?.name ?? "",
  department: r.department?.name ?? "",
  status: r.active ? "Active" : "Inactive",
  has_sign_in: r.hasLogin ? "yes" : "no",
  added: formatDate(r.createdAt),
});

/** The employees register (/Employees, under Master Data): the same server-side table, column set and filter drawer as the other registers. */
const EmployeesPage = () => {
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const activeMutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useEmployeeFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const { data: sites } = useSites({ includeInactive: true });
  const { data: departments } = useAllDepartments({ includeInactive: true });
  const [sorting, setSortingState] = useState([{ id: "name", desc: false }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined: closed, null: new, employee: edit
  const headerRef = useRef(null);
  const prefs = useTablePreferences("employee-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };

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
  const sortColumn = sorting[0] ? employeeColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useEmployeeRegister({
    q: filters.search,
    status: filters.status,
    siteId: filters.site,
    departmentId: filters.department,
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

  // The header search box feeds the register search.
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));

  const toggleActive = (item) =>
    activeMutation.mutate(
      { path: `/employees/${item.id}`, method: "PATCH", body: { active: !item.active } },
      {
        onSuccess: () => showToast({ type: "success", title: item.active ? "Deactivated" : "Reactivated", message: `${item.name} is now ${item.active ? "inactive" : "active"}.` }),
        onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }),
      }
    );
  const rowActions = (item) =>
    canManage
      ? [
          { label: "Edit", icon: PencilIcon, onSelect: () => open(item) },
          { label: item.active ? "Deactivate" : "Reactivate", icon: PowerIcon, onSelect: () => toggleActive(item) },
        ]
      : [{ label: "View", icon: PencilIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${list(filters.status).map((k) => (k === "active" ? "Active" : "Inactive")).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.site ? [{ key: "site", label: `Site: ${(sites?.data ?? []).find((s) => s.id === filters.site)?.name ?? "…"}`, clear: { site: "", department: "" } }] : []),
    ...(filters.department
      ? [{ key: "department", label: `Department: ${(departments?.data ?? []).find((d) => d.id === filters.department)?.name ?? "…"}`, clear: { department: "" } }]
      : []),
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };
  const open = (r) => {
    setEditing(r);
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div ref={headerRef} className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "employee" : "employees"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "employees.csv")} text="Export CSV" type="success" title="Export the selected employees to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={employeeColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {canManage && <CTAButton callbackFn={() => setEditing(null)} text="New employee" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Add an employee" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <EmployeeFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
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
          <button type="button" onClick={() => clearFilters(Object.fromEntries(EMPLOYEE_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
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
          columns={employeeColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={open}
          ariaLabel="Employees"
          rowLabel={rowLabel}
        />
      </div>

      {editing !== undefined && <EmployeeDialog employee={editing} readOnly={!canManage} onClose={() => setEditing(undefined)} />}
    </div>
  );
};

export default EmployeesPage;

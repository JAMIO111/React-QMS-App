import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ExternalLinkIcon, SearchIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import DateRangeFilter from "../ui/DateRangeFilter";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { exportCSV } from "../../lib/csvHelper";
import { shortDate } from "../../lib/portal";
import { applyFilters, list, sortRows } from "../../lib/portalRegister";

/**
 * A register for the portal (docs/external-portal-plan.md PT6): the main app's table, column menu, filters and CSV export over the records a supplier
 * or customer has been shown. The lists are small and already limited by the database to what is shared with the person's party, so searching,
 * filtering, sorting and paging happen here; the address keeps the search, the filters and the page so a link or a reload shows the same view.
 *
 * Filters are declared by the page: `pills` (one or more of a few values), `dates` (a range) and `switch` (a yes/no such as "Needs my attention").
 * URL keys: `q`, `f.<key>` (comma list), `d.<key>.from` / `.to`, `s.<key>=1`, `page`, `pageSize`.
 */

export default function PortalRegister({
  storageKey,
  noun,
  plural,
  rows,
  isLoading,
  error,
  onRefresh,
  columns,
  defaultHidden = {},
  defaultSort,
  filters = [],
  searchText,
  csvRow,
  csvName,
  onOpen,
  ariaLabel,
  rowLabel,
  searchPlaceholder,
  children,
}) {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, parseInt(params.get("page") || "1", 10));
  const pageSize = Math.max(1, parseInt(params.get("pageSize") || "25", 10));
  const search = params.get("q") ?? "";
  const [box, setBox] = useState(search);
  const [sorting, setSorting] = useState(defaultSort ? [defaultSort] : []);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const prefs = useTablePreferences(storageKey);
  const columnVisibility = { ...defaultHidden, ...prefs.columnVisibility };

  // The search box writes to the address a moment after typing stops; the address is the truth when it changes elsewhere.
  useEffect(() => {
    setBox(search);
  }, [search]);
  useEffect(() => {
    if (box === search) return undefined;
    const t = setTimeout(() => change((p) => (box ? p.set("q", box) : p.delete("q"))), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box]);

  /** Change the address, always from the first page (a different view starts at its beginning). */
  const change = (edit, { keepPage = false } = {}) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      edit(next);
      if (!keepPage) next.delete("page");
      return next;
    }, { replace: true });

  const filtered = useMemo(() => applyFilters(rows ?? [], { filters, params, search, searchText }), [rows, filters, params, search, searchText]);
  const sorted = useMemo(() => sortRows(filtered, sorting, columns), [filtered, sorting, columns]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visible = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [safePage, pageSize, search]);

  // The chips for what is applied, each one removable.
  const chips = [
    ...(search ? [{ key: "q", label: `Search: “${search}”`, clear: (p) => p.delete("q") }] : []),
    ...filters.flatMap((f) => {
      if (f.type === "pills") {
        const chosen = list(params.get(`f.${f.key}`));
        if (!chosen.length) return [];
        const names = chosen.map((k) => f.options.find((o) => o.key === k)?.label ?? k).join(", ");
        return [{ key: f.key, label: `${f.label}: ${names}`, clear: (p) => p.delete(`f.${f.key}`) }];
      }
      if (f.type === "dates") {
        const from = params.get(`d.${f.key}.from`);
        const to = params.get(`d.${f.key}.to`);
        if (!from && !to) return [];
        const words = from && to ? `${shortDate(from)} to ${shortDate(to)}` : from ? `from ${shortDate(from)}` : `until ${shortDate(to)}`;
        return [{ key: f.key, label: `${f.label}: ${words}`, clear: (p) => { p.delete(`d.${f.key}.from`); p.delete(`d.${f.key}.to`); } }];
      }
      if (f.type === "switch" && params.get(`s.${f.key}`) === "1") return [{ key: f.key, label: f.label, clear: (p) => p.delete(`s.${f.key}`) }];
      return [];
    }),
  ];
  const filterCount = chips.filter((c) => c.key !== "q").length;
  const clearAll = () =>
    change((p) => {
      p.delete("q");
      for (const f of filters) {
        p.delete(`f.${f.key}`);
        p.delete(`d.${f.key}.from`);
        p.delete(`d.${f.key}.to`);
        p.delete(`s.${f.key}`);
      }
    });

  const togglePill = (key, value) =>
    change((p) => {
      const now = list(p.get(`f.${key}`));
      const next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
      if (next.length) p.set(`f.${key}`, next.join(","));
      else p.delete(`f.${key}`);
    });

  const rowActions = (item) => [{ label: "Open", icon: ExternalLinkIcon, onSelect: () => onOpen?.(item) }];

  return (
    <div className="flex w-full min-w-0 min-h-0 flex-1 flex-col gap-3">
      {children}
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <p className="text-sm text-primary-text" aria-live="polite">
          {selectedRows.length > 0
            ? `${selectedRows.length} selected`
            : isLoading
              ? ""
              : `${sorted.length.toLocaleString()} ${sorted.length === 1 ? noun : plural}${sorted.length !== (rows ?? []).length ? ` of ${(rows ?? []).length.toLocaleString()}` : ""}`}
        </p>
        <div className="flex flex-row flex-wrap items-center justify-end gap-3">
          <label className="relative flex items-center">
            <span className="sr-only">Search {plural}</span>
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 h-4 w-4 text-secondary-text" />
            <input
              type="search"
              value={box}
              onChange={(e) => setBox(e.target.value)}
              placeholder={searchPlaceholder ?? `Search ${plural}`}
              className="min-h-9.5 w-64 rounded-lg border border-border-color bg-secondary-bg py-2 pl-9 pr-3 text-sm text-primary-text placeholder:text-secondary-text"
            />
          </label>
          {selectedRows.length > 0 && csvRow && (
            <CTAButton
              callbackFn={() => exportCSV(selectedRows.map(csvRow), csvName ?? `${plural}.csv`)}
              text="Export CSV"
              type="success"
              title={`Export the selected ${plural} to a CSV file`}
              icon={ShareIcon}
              iconSize="h-6 w-6"
            />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {filters.length > 0 && (
            <IconButton count={filterCount} selected={panelOpen} color="blue" title="Filter" callback={() => setPanelOpen((o) => !o)} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          )}
        </div>
      </div>

      {panelOpen && filters.length > 0 && (
        <section aria-label="Filters" className="grid gap-4 rounded-2xl border border-border-color bg-secondary-bg p-4 sm:grid-cols-2 lg:grid-cols-3">
          {filters.map((f) => {
            if (f.type === "pills") {
              const chosen = list(params.get(`f.${f.key}`));
              return (
                <fieldset key={f.key}>
                  <legend className="text-sm font-medium">{f.label}</legend>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {f.options.map((o) => {
                      const on = chosen.includes(o.key);
                      return (
                        <label key={o.key} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => togglePill(f.key, o.key)} />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-secondary-text">{chosen.length ? `${chosen.length} selected` : `Any ${f.label.toLowerCase()}`}</p>
                </fieldset>
              );
            }
            if (f.type === "dates") {
              return (
                <DateRangeFilter
                  key={f.key}
                  label={f.label}
                  direction={f.direction}
                  from={params.get(`d.${f.key}.from`) || null}
                  to={params.get(`d.${f.key}.to`) || null}
                  onChange={({ from, to }) =>
                    change((p) => {
                      if (from) p.set(`d.${f.key}.from`, from); else p.delete(`d.${f.key}.from`);
                      if (to) p.set(`d.${f.key}.to`, to); else p.delete(`d.${f.key}.to`);
                    })
                  }
                />
              );
            }
            if (f.type === "switch") {
              const on = params.get(`s.${f.key}`) === "1";
              return (
                <label key={f.key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={on} onChange={() => change((p) => (on ? p.delete(`s.${f.key}`) : p.set(`s.${f.key}`, "1")))} />
                  {f.label}
                </label>
              );
            }
            return null;
          })}
        </section>
      )}

      {chips.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {chips.map((c) => (
            <span key={c.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {c.label}
              <button type="button" aria-label={`Remove filter ${c.label}`} onClick={() => change(c.clear)} className="cursor-pointer rounded-full p-0.5 hover:bg-brand-primary/20">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAll} className="cursor-pointer text-link-color hover:underline">Clear all</button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <TableWrapper
          data={visible}
          isLoading={isLoading}
          error={error}
          totalCount={sorted.length}
          page={safePage}
          pageSize={pageSize}
          setSelectedRows={setSelectedRows}
          rowActions={rowActions}
          onRefresh={onRefresh}
          sorting={sorting}
          setSorting={setSorting}
          columns={columns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={onOpen}
          ariaLabel={ariaLabel ?? plural}
          rowLabel={rowLabel}
        />
        {!isLoading && !error && sorted.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-secondary-text">
            {(rows ?? []).length === 0 ? `No ${plural} have been shared with you yet.` : `No ${plural} match these filters.`}
          </p>
        )}
      </div>
    </div>
  );
}

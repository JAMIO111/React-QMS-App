import { useState } from "react";
import { Link } from "react-router-dom";
import { useNcrs } from "../../hooks/useNcr";
import { NCR_REGISTER, formatDate, ncrPath, sourceLabel } from "../../lib/ncr";
import { OPEN_NC_STAGES } from "../../lib/supplierQuality";
import { SeverityPill, StagePill } from "../ncr/Pills";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice } from "../master-data/shared";

const PAGE_SIZE = 25;

const FILTERS = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
];

/**
 * The central non-conformances that name this supplier as the responsible party. Where a problem was *found* (the source: supplier, goods
 * receiving, an audit…) is shown beside each row, because it is independent of who is responsible.
 */
export default function SupplierNcs({ supplier }) {
  const [filter, setFilter] = useState("open");
  const [page, setPage] = useState(1);
  const label = supplier.displayName || supplier.name;
  const { data, isLoading, error } = useNcrs({
    supplierId: supplier.id,
    stage: filter === "open" ? OPEN_NC_STAGES : [],
    sort: "detectedAt",
    order: "desc",
    page,
    pageSize: PAGE_SIZE,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const registerLink = `${NCR_REGISTER}?supplier=${supplier.id}&supplierLabel=${encodeURIComponent(label)}`;

  return (
    <MenuCard
      title="Nonconformities"
      subtitle="The central non-conformances that name this supplier as responsible. Where each was found is shown as its source."
      action={
        <SlidingToggle
          ariaLabel="Which non-conformances"
          options={FILTERS}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
        />
      }>
      <div className="flex flex-col gap-3">
        {error && <ErrorNotice error={error} />}
        {isLoading ? (
          <p className="text-sm text-secondary-text">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-secondary-text">{filter === "open" ? "No open non-conformances for this supplier." : "No non-conformances for this supplier."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-secondary-text">
                  <th className="py-1 pr-3 font-medium">Reference</th>
                  <th className="py-1 pr-3 font-medium">Title</th>
                  <th className="py-1 pr-3 font-medium">Found by</th>
                  <th className="py-1 pr-3 font-medium">Part</th>
                  <th className="py-1 pr-3 font-medium">Detected</th>
                  <th className="py-1 pr-3 font-medium">Severity</th>
                  <th className="py-1 font-medium">Stage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <tr key={n.id} className="border-t border-border-color align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Link to={ncrPath(n.id)} className="text-link-color hover:underline">
                        {n.reference}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-primary-text">{n.title}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-secondary-text">{sourceLabel(n.source)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-secondary-text">{n.part ? n.part.partNumber : "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-secondary-text">{formatDate(n.detectedAt)}</td>
                    <td className="py-2 pr-3">
                      <SeverityPill severity={n.severity} />
                    </td>
                    <td className="py-2">
                      <StagePill stage={n.stage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-secondary-text">
          <span>
            {total} {total === 1 ? "non-conformance" : "non-conformances"} · {supplier.counts.openNcs} open, {supplier.counts.totalNcs} in all
          </span>
          <div className="flex items-center gap-3">
            {pages > 1 && (
              <span className="flex items-center gap-2">
                <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <span>
                  Page {page} of {pages}
                </span>
                <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </span>
            )}
            <Link to={registerLink} className="text-link-color hover:underline">
              Open in the register
            </Link>
          </div>
        </div>
      </div>
    </MenuCard>
  );
}

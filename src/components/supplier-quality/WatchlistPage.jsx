import { useState } from "react";
import { Link } from "react-router-dom";
import { DownloadIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useSupplierReport, useWatchlist } from "../../hooks/useSupplierPerformance";
import { describeApiError } from "../../lib/api-client";
import { downloadReport } from "../../lib/reportCsv";
import { DEFAULT_PERIOD, PERIODS, formatScore, periodFor } from "../../lib/supplierPerformance";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import DropdownMenu from "../ui/DropdownMenu";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice } from "../master-data/shared";
import { BandPill, WarningList } from "./PerformanceParts";

/** Active suppliers that need attention, worked out live over the last N days; each warning names the records behind it. Nothing here changes a supplier's status. */
const WatchlistPage = () => {
  const [days, setDays] = useState(DEFAULT_PERIOD);
  const query = useWatchlist(days);
  const { can } = usePermissions();
  const { showToast } = useToast();
  const report = useSupplierReport();
  const exportReport = (kind, slug) =>
    report.mutate({ kind, ...periodFor(days) }, { onSuccess: (r) => downloadReport(r, slug), onError: (e) => showToast({ type: "error", title: "Report not made", message: describeApiError(e) }) });
  const rows = query.data?.data ?? [];
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">Supplier watchlist</h1>
        <p className="text-sm text-secondary-text">Active suppliers with a poor or watch band, or a warning, over the period. Open a supplier to see the figures and save a scorecard.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />
        <DropdownMenu
          label="Export a report"
          items={[
            { label: "Supplier performance (CSV)", hint: "Every active supplier, with the period and definitions", icon: DownloadIcon, onSelect: () => exportReport("performance", "supplier-performance") },
            can("audits.read") && { label: "Supplier audits (CSV)", hint: "Audit records carried out on suppliers", icon: DownloadIcon, onSelect: () => exportReport("audits", "supplier-audits") },
          ]}
          trigger={(props) => <CTAButton {...props} type="secondary" size="default" icon={DownloadIcon} disabled={report.isPending} loading={report.isPending}>{report.isPending ? "Preparing…" : "Export a report"}</CTAButton>}
        />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone="success" title="Nothing to watch">No active supplier has a poor or watch band or a warning over this period.</Callout>
      ) : (
        <div className="flex flex-col gap-3" aria-label="Suppliers to watch">
          {rows.map((r) => (
            <MenuCard key={r.supplierId} title={`${r.code} · ${r.name}`} subtitle={<span className="inline-flex items-center gap-2"><BandPill band={r.band} /><span className="tabular-nums">Score {formatScore(r.score)}</span></span>}
              action={<Link to={`/Suppliers/${r.supplierId}?tab=performance`} className="text-sm text-link-color hover:underline">Open performance</Link>}>
              <WarningList warnings={r.warnings} supplierId={r.supplierId} />
            </MenuCard>
          ))}
        </div>
      )}
    </div>
  );
};

export default WatchlistPage;

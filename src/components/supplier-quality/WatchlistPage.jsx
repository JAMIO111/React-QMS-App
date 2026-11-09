import { useState } from "react";
import { Link } from "react-router-dom";
import { useWatchlist } from "../../hooks/useSupplierPerformance";
import { DEFAULT_PERIOD, PERIODS, formatScore } from "../../lib/supplierPerformance";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice } from "../master-data/shared";
import { BandPill, WarningList } from "./PerformanceParts";

/** Active suppliers that need attention, worked out live over the last N days; each warning names the records behind it. Nothing here changes a supplier's status. */
const WatchlistPage = () => {
  const [days, setDays] = useState(DEFAULT_PERIOD);
  const query = useWatchlist(days);
  const rows = query.data?.data ?? [];
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">Supplier watchlist</h1>
        <p className="text-sm text-secondary-text">Active suppliers with a poor or watch band, or a warning, over the period. Open a supplier to see the figures and save a scorecard.</p>
      </div>
      <SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />
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

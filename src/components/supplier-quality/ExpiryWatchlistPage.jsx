import { Link, useSearchParams } from "react-router-dom";
import { useExpiryWatchlist } from "../../hooks/useSupplierQuality";
import { formatDate } from "../../lib/ncr";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice } from "../master-data/shared";
import { ExpiryBadge } from "./Qualification";

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
];
const KINDS = [
  { value: "", label: "Everything" },
  { value: "certification", label: "Certifications" },
  { value: "document", label: "Documents" },
];

/** Certifications and documents that have expired or expire soon, across all active suppliers. Nothing here changes a supplier's status: it says what to look at. */
const ExpiryWatchlistPage = () => {
  const [params, setParams] = useSearchParams();
  const days = WINDOWS.some((w) => w.value === params.get("days")) ? Number(params.get("days")) : 60;
  const kind = KINDS.some((k) => k.value === params.get("kind")) ? (params.get("kind") ?? "") : "";
  const query = useExpiryWatchlist({ days, kind });
  const set = (k, v, fallback) => setParams((p) => { const n = new URLSearchParams(p); if (v === fallback) n.delete(k); else n.set(k, v); return n; });
  const data = query.data?.data ?? [];
  const counts = query.data?.counts ?? { expired: 0, expiring: 0 };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">Expiry watchlist</h1>
        <p className="text-sm text-secondary-text">Supplier certifications and documents that have expired or will expire soon. An expiry never changes a supplier's approval status; it tells you what to chase.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Look ahead" options={WINDOWS} value={String(days)} onChange={(v) => set("days", v, "60")} />
        <SlidingToggle ariaLabel="Show" options={KINDS} value={kind} onChange={(v) => set("kind", v, "")} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.data && (
        <p className="text-sm text-primary-text" aria-live="polite">
          <strong className="tabular-nums">{counts.expired}</strong> expired · <strong className="tabular-nums">{counts.expiring}</strong> expiring within {days} days
        </p>
      )}
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : data.length === 0 ? (
        <Callout tone="success" title="Nothing to chase">No current certification or document has expired or expires within {days} days.</Callout>
      ) : (
        <MenuCard title="To look at" subtitle="Soonest first. Open the supplier to renew a certification or upload a new version.">
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Expiring records">
            {data.map((i) => (
              <li key={`${i.kind}:${i.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-primary-text">
                    <Link to={`/Suppliers/${i.supplier.id}?tab=${i.kind === "certification" ? "qualification" : "documents"}`} className="text-link-color hover:underline">
                      {i.supplier.code} · {i.supplier.name}
                    </Link>
                  </p>
                  <p className="text-sm text-secondary-text">
                    {i.kind === "certification" ? "Certification" : "Document"}: {i.title}
                    {i.detail ? ` · ${i.detail}` : ""} · expires {formatDate(i.expiresOn)}{i.verified ? "" : " · not verified"}
                  </p>
                </div>
                <ExpiryBadge expiry={{ state: i.state, daysLeft: i.daysLeft }} />
              </li>
            ))}
          </ul>
        </MenuCard>
      )}
    </div>
  );
};

export default ExpiryWatchlistPage;

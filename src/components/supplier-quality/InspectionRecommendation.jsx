import { useInspectionRecommendation } from "../../hooks/useSupplierPerformance";
import { usePermissions } from "../../hooks/useQmsApi";
import { LEVELS, levelLabel, REQUIREMENTS_PATH } from "../../lib/incoming";
import { formatDate } from "../../lib/ncr";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { BandPill } from "./PerformanceParts";

const TONE = { raise: "warning", lower: "info", none: "success" };
const CHANGE_TITLE = {
  raise: (r) => `Consider ${levelLabel(r.level).toLowerCase()} inspection`,
  lower: () => "This supplier has earned a lower level of inspection",
  none: (r) => `The current level (${levelLabel(r.current.level).toLowerCase()}) fits`,
};

/**
 * Risk-based recommendation for the supplier's incoming inspection. Information only: it never changes a requirement. To act on it, write a requirement, which someone else approves;
 * a requirement that reduces inspection is never applied to a part with a critical characteristic.
 */
export default function InspectionRecommendation({ supplier }) {
  const { can } = usePermissions();
  const allowed = can("supplier_quality.read") && can("receiving.read");
  const query = useInspectionRecommendation(supplier.id, 90, { enabled: allowed });
  if (!allowed) return null;
  const r = query.data;
  return (
    <MenuCard title="Recommended inspection level" subtitle="From the supplier's risk rating, approval status and performance over the last 90 days. For information: nothing changes until a requirement is written and approved.">
      {query.error && <ErrorNotice error={query.error} />}
      {!r ? (query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : null) : (
        <div className="flex flex-col gap-3">
          <Callout tone={TONE[r.change]} title={CHANGE_TITLE[r.change](r)}>
            <span className="block">
              Recommended: <strong>{LEVELS.find((l) => l.value === r.level)?.label}</strong>. Today: <strong>{levelLabel(r.current.level)}</strong>
              {r.current.basis === "supplier_rule" ? ` (${r.current.ruleName})` : " (no supplier-wide requirement, so the default applies)"}.
            </span>
          </Callout>
          <ul className="flex flex-col gap-1 text-sm text-primary-text" aria-label="Reasons">
            {r.reasons.map((x) => (
              <li key={x.code} className="flex gap-2"><span aria-hidden="true">{x.kind === "raises" ? "▲" : x.kind === "blocks_reduction" ? "•" : "✓"}</span><span>{x.message}</span></li>
            ))}
          </ul>
          <p className="flex flex-wrap items-center gap-2 text-xs text-secondary-text">
            Performance <BandPill band={r.basis.band} /> · risk {r.basis.riskRating ?? "not assessed"} · {r.basis.approvalStatus.replace(/_/g, " ")} · {formatDate(r.basis.from)} to {formatDate(r.basis.to)}
          </p>
          {r.level === "reduced" && <Callout tone="info">A requirement that reduces inspection is never applied to a part with a critical characteristic: those are always inspected in full.</Callout>}
          {r.change !== "none" && can("supplier_quality.manage") && (
            <CTAButton type="secondary" size="default" to={REQUIREMENTS_PATH} className="self-start">Write a requirement</CTAButton>
          )}
        </div>
      )}
    </MenuCard>
  );
}

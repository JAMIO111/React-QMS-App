import { Link, useSearchParams } from "react-router-dom";
import { ShieldAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import ComboField from "../ui/ComboField";
import { Card } from "../dashboard/DashboardParts";
import { Empty, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { useRiskCategories, useRiskHeatmap, useRiskModel } from "../../hooks/useRisk";
import { describeApiError } from "../../lib/api-client";
import { BAND_LABEL, BAND_PILL, cellBand, kindLabel, riskPath, statusLabel, statusPill } from "../../lib/risk";
import RiskMatrix from "./RiskMatrix";

const PHASES = [
  { value: "effective", label: "In force", hint: "After treatment when it has been assessed, else before" },
  { value: "inherent", label: "Before treatment" },
  { value: "residual", label: "After treatment" },
];
const KINDS = [
  { value: "", label: "Both" },
  { value: "risk", label: "Risks" },
  { value: "opportunity", label: "Opportunities" },
];

/**
 * Heat map (`/Risk/Heat-map`): live risks counted on the matrix, before treatment, after it, or as in force. Choosing a cell lists its risks.
 * Everything chosen is in the address (`phase`, `kind`, `category`, `mine`, `cell=<likelihood>-<consequence>`), so a view can be shared.
 */
const RiskHeatMapPage = () => {
  const [params, setParams] = useSearchParams();
  const phase = PHASES.some((p) => p.value === params.get("phase")) ? params.get("phase") : "effective";
  const kind = params.get("kind") ?? "";
  const category = params.get("category") ?? "";
  const mine = params.get("mine") === "true";
  const [l, c] = (params.get("cell") ?? "").split("-").map(Number);
  const chosen = l >= 1 && l <= 5 && c >= 1 && c <= 5 ? { likelihood: l, consequence: c } : null;
  const set = (changes) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
        return next;
      },
      { replace: true },
    );

  const model = useRiskModel();
  const categories = useRiskCategories();
  const heat = useRiskHeatmap({ phase, kind: kind || undefined, categoryId: category || undefined, owner: mine ? "me" : undefined });
  const cells = new Map((heat.data?.cells ?? []).map((x) => [`${x.likelihood}:${x.consequence}`, x]));
  const config = model.data?.config;
  const selectedCell = chosen ? cells.get(`${chosen.likelihood}:${chosen.consequence}`) : null;
  const phaseWords = PHASES.find((p) => p.value === phase)?.label.toLowerCase();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ShieldAlertIcon className="h-6 w-6" aria-hidden="true" />
            Heat map
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {heat.data ? `${heat.data.placed} live ${heat.data.placed === 1 ? "risk" : "risks"} placed ${phaseWords}` : "Live risks on the matrix"}
            {heat.data?.notPlaced ? ` · ${heat.data.notPlaced} not placed (${phase === "residual" ? "not assessed after treatment" : "not assessed yet"})` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Link to="/Risk" className={linkClass}>
            Dashboard
          </Link>
          <Link to="/Risk/Register" className={linkClass}>
            Risk register
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <SlidingToggle ariaLabel="Which assessment" options={PHASES.map(({ value, label, hint }) => ({ value, label, title: hint }))} value={phase} onChange={(v) => set({ phase: v === "effective" ? "" : v, cell: "" })} />
        <SlidingToggle ariaLabel="Risks or opportunities" options={KINDS} value={kind} onChange={(v) => set({ kind: v, cell: "" })} />
        <SlidingToggle ariaLabel="Whose" options={[{ value: "", label: "Everyone's" }, { value: "true", label: "Mine" }]} value={mine ? "true" : ""} onChange={(v) => set({ mine: v, cell: "" })} />
        <div className="w-60">
          <ComboField
            label="Category"
            value={category || null}
            onChange={(v) => set({ category: v ?? "", cell: "" })}
            options={(categories.data?.data ?? []).map((x) => ({ value: x.id, label: x.label }))}
            placeholder="Any category"
            clearable
          />
        </div>
      </div>

      {(heat.error || model.error) && (
        <Callout tone="error" role="alert">
          {describeApiError(heat.error ?? model.error)}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Where they sit" subtitle="The number in each cell is how many live risks are there; choose a cell to list them" className="xl:col-span-7">
          {config && heat.data ? (
            <RiskMatrix
              config={config}
              selected={chosen}
              onPick={(likelihood, consequence) => set({ cell: chosen?.likelihood === likelihood && chosen?.consequence === consequence ? "" : `${likelihood}-${consequence}` })}
              marks={(li, co) => {
                const n = cells.get(`${li}:${co}`)?.count;
                return n ? `${n} ${n === 1 ? "risk" : "risks"}` : null;
              }}
              cellLabel={(li, co, band) => {
                const n = cells.get(`${li}:${co}`)?.count ?? 0;
                return `${config.likelihood[li - 1]?.label} and ${config.consequence[co - 1]?.label}: ${li * co}, ${BAND_LABEL[band]}, ${n} ${n === 1 ? "risk" : "risks"}`;
              }}
              ariaLabel="Heat map"
            />
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card
          title={chosen && config ? `${config.likelihood[chosen.likelihood - 1]?.label} × ${config.consequence[chosen.consequence - 1]?.label}` : "Risks in a cell"}
          subtitle={chosen && config ? `Score ${chosen.likelihood * chosen.consequence} · ${BAND_LABEL[cellBand(config, chosen.likelihood, chosen.consequence)]}` : "Choose a cell of the map"}
          className="xl:col-span-5">
          {!chosen ? (
            <Empty>Choose a cell to see the risks in it.</Empty>
          ) : selectedCell?.risks.length ? (
            <ul aria-label="Risks in the chosen cell" className="flex flex-col divide-y divide-border-color text-sm">
              {selectedCell.risks.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-col">
                    <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                      {r.reference} · {r.title}
                    </Link>
                    <span className="text-xs text-secondary-text">
                      {kindLabel(r.kind)} · {r.owner ?? "No owner"}
                    </span>
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(r.status)}`}>{statusLabel(r.status)}</span>
                </li>
              ))}
              {selectedCell.count > selectedCell.risks.length && <li className="py-2 text-xs text-secondary-text">And {selectedCell.count - selectedCell.risks.length} more</li>}
            </ul>
          ) : (
            <Empty>No live risks in this cell.</Empty>
          )}
        </Card>
      </div>

      {config && (
        <p className="text-xs text-secondary-text">
          Levels the organisation accepts: up to <span className={`rounded-full px-2 py-0.5 font-medium ${BAND_PILL[config.acceptanceBand]}`}>{BAND_LABEL[config.acceptanceBand]}</span>. Closed and retired risks are not shown.
        </p>
      )}
    </div>
  );
};

export default RiskHeatMapPage;

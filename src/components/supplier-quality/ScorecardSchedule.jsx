import { useState } from "react";
import { XIcon } from "@/components/icons";
import { usePerformanceMutation, useScorecardSchedule } from "../../hooks/useSupplierPerformance";
import { useSupplierClassifications } from "../../hooks/useSupplierQuality";
import { formatDateTime } from "../../lib/processControl";
import { PERIOD_KINDS, periodWords } from "../../lib/supplierPerformance";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import Switch from "../ui/Switch";
import { ErrorNotice } from "../master-data/shared";

const SCOPES = [
  { value: "all", label: "Every supplier in use" },
  { value: "classifications", label: "Chosen classifications" },
];

const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Settings → Data Management → Supplier quality: scorecards saved by the schedule. Monthly, quarterly and annual are switched on and off separately; each
 * switch saves at once (optimistic). The schedule covers every supplier in use or only those holding a chosen classification, and uses the authority of
 * whoever last changed it.
 */
export default function ScorecardScheduleCard() {
  const query = useScorecardSchedule();
  const classes = useSupplierClassifications();
  const mutation = usePerformanceMutation();
  const [choosing, setChoosing] = useState(false);
  if (query.isLoading) return null;
  if (query.error) return <ErrorNotice error={query.error} />;
  const s = query.data;
  const can = s.canChange;
  const save = (body) => mutation.mutate({ action: "saveSchedule", body });
  const scope = choosing ? "classifications" : s.scope;
  const chosen = s.classifications.map((c) => c.id);
  const addable = (classes.data?.data ?? []).filter((c) => c.active && !chosen.includes(c.id)).map((c) => ({ value: c.id, label: c.label }));
  const anyOn = s.monthly || s.quarterly || s.annual;

  const pickScope = (v) => {
    if (v === "all") {
      setChoosing(false);
      if (s.scope !== "all") save({ scope: "all" });
    } else if (chosen.length) save({ scope: "classifications" });
    else setChoosing(true); // saved once the first classification is chosen
  };
  const add = (id) => {
    if (!id) return;
    setChoosing(false);
    save({ scope: "classifications", classificationIds: [...chosen, id] });
  };
  const remove = (id) => save({ classificationIds: chosen.filter((c) => c !== id) });

  return (
    <MenuCard
      title="Scheduled scorecards"
      subtitle="Save a scorecard for every supplier at the end of each period, so its trend has no gaps. Each one is frozen like a scorecard saved by hand. A fall in a supplier's band is announced to supplier quality managers. Nothing here changes a supplier's approval or risk.">
      <div className="flex flex-col gap-4">
        <ul aria-label="Scorecard periods" className="flex flex-col divide-y divide-border-color">
          {PERIOD_KINDS.map((k) => {
            const next = s.next[k.value];
            return (
              <li key={k.value} className="flex flex-wrap items-center gap-3 py-2">
                <Switch checked={s[k.value]} disabled={!can} onChange={(e) => save({ [k.value]: e.target.checked })} aria-label={`${k.label} scorecards`}>
                  <span className="text-sm font-medium text-primary-text">{k.label}</span>
                </Switch>
                <span className="text-xs text-secondary-text">
                  {s[k.value] && next ? `Next: ${periodWords(k.value, next.from)}, saved after ${longDate(next.to)}` : k.hint}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-secondary-text" id="scorecard-scope-label">Which suppliers</span>
          {can ? (
            <SlidingToggle ariaLabel="Which suppliers" options={SCOPES} value={scope} onChange={pickScope} />
          ) : (
            <span className="text-sm text-primary-text">{SCOPES.find((o) => o.value === s.scope)?.label}</span>
          )}
          <p className="text-xs text-secondary-text">Suppliers in use are active and neither archived nor disqualified. A supplier with too little data still gets a scorecard, marked as not enough data.</p>
          {scope === "classifications" && (
            <div className="flex flex-wrap items-end gap-2">
              <ul aria-label="Chosen classifications" className="flex flex-wrap gap-2">
                {s.classifications.map((c) => (
                  <li key={c.id} className="flex items-center gap-1 rounded-full border border-border-color bg-secondary-bg px-3 py-1 text-sm text-primary-text">
                    {c.label}
                    {!c.active && <span className="text-xs text-secondary-text">(switched off)</span>}
                    {can && (
                      <button
                        type="button"
                        className="rounded-full p-0.5 text-secondary-text hover:text-primary-text disabled:opacity-40"
                        aria-label={`Remove ${c.label}`}
                        title={chosen.length === 1 ? "Choose another first, or switch to every supplier" : undefined}
                        disabled={chosen.length === 1}
                        onClick={() => remove(c.id)}>
                        <XIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {can && addable.length > 0 && (
                <ComboField className="min-w-60" label="Add a classification" value={null} onChange={add} options={addable} placeholder="Choose…" />
              )}
              {choosing && !chosen.length && <p className="w-full text-xs text-secondary-text">Choose a classification to save this.</p>}
            </div>
          )}
        </div>

        {s.problem && <Callout tone="error" title="Scorecards are not being saved">{s.problem}</Callout>}
        {anyOn && (
          <p className="text-xs text-secondary-text">
            {s.setBy ? `Scorecards are worked out with ${s.setBy.name}'s access, as the person who last changed this.` : "Nobody's access is lent to the schedule yet: change it to start."}
            {s.lastSavedAt ? ` Last saved ${formatDateTime(s.lastSavedAt)}.` : ""}
          </p>
        )}
      </div>
    </MenuCard>
  );
}

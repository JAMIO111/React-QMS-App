import { useState } from "react";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePerformance, usePerformanceMutation, useScorecard, useScorecards } from "../../hooks/useSupplierPerformance";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { DEFAULT_PERIOD, PERIODS, formatScore, periodFor } from "../../lib/supplierPerformance";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import { BandPill, ComponentCards, FiguresTable, Trend, WarningList } from "./PerformanceParts";
import SupplierScoringSettings from "./SupplierScoringSettings";

const SaveDialog = ({ supplierId, period, onClose }) => {
  const mutation = usePerformanceMutation();
  const [note, setNote] = useState("");
  return (
    <Dialog title="Save a scorecard" onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!mutation.isPending) mutation.mutate({ action: "saveScorecard", id: supplierId, body: { from: period.from, to: period.to, note: note.trim() || null } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">Freezes the figures for {formatDate(period.from)} to {formatDate(period.to)} as they are now, with the scoring model in force. A saved scorecard never changes, even if the records or the model do.</p>
        <TextAreaField label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} hint="For example: quarterly review" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save scorecard"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A saved scorecard exactly as it was frozen. */
const ScorecardDialog = ({ id, supplierId, onClose }) => {
  const query = useScorecard(id);
  const c = query.data;
  return (
    <Dialog title="Saved scorecard" onClose={onClose} width="max-w-3xl">
      {query.error && <ErrorNotice error={query.error} />}
      {!c ? <p className="text-sm text-secondary-text">Loading…</p> : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-secondary-text">
            {formatDate(c.periodFrom)} to {formatDate(c.periodTo)} · model version {c.modelVersion} · saved {formatDateTime(c.createdAt)}{c.createdBy ? ` by ${c.createdBy.name}` : ""}{c.note ? ` · ${c.note}` : ""}
          </p>
          <div className="flex items-center gap-3"><span className="text-3xl font-semibold tabular-nums text-primary-text">{formatScore(c.score)}</span><BandPill band={c.band} /></div>
          <ComponentCards components={c.components} />
          <WarningList warnings={c.warnings} supplierId={supplierId} />
          <FiguresTable metrics={c.metrics} />
        </div>
      )}
    </Dialog>
  );
};

/** The supplier's Performance tab: live figures for a period, the warnings with the records behind them, and the saved scorecards. */
export default function SupplierPerformance({ supplier }) {
  const { can } = usePermissions();
  const [days, setDays] = useState(DEFAULT_PERIOD);
  const [dialog, setDialog] = useState(null); // "save" | { id }
  const period = periodFor(days);
  const live = usePerformance(supplier.id, period);
  const cards = useScorecards(supplier.id);
  const p = live.data;

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Performance"
        subtitle="Worked out from receipts, orders, non-conformances, corrective action requests and certifications. Nothing here changes the supplier's approval status."
        action={<SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />}>
        {live.error && <ErrorNotice error={live.error} />}
        {!p ? <p className="text-sm text-secondary-text">Loading…</p> : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-4xl font-semibold tabular-nums text-primary-text" aria-label="Score">{formatScore(p.score)}</span>
              <BandPill band={p.band} />
              <span className="text-sm text-secondary-text">{formatDate(period.from)} to {formatDate(period.to)} · model version {p.model.version}</span>
              {can("supplier_quality.manage") && <CTAButton type="secondary" size="default" className="ml-auto" onClick={() => setDialog("save")}>Save as a scorecard</CTAButton>}
            </div>
            {p.band === "insufficient" && <Callout tone="info" title="Not enough data to score">Less than half of the scoring weight has data for this period. The figures below are still shown; try a longer period.</Callout>}
            <ComponentCards components={p.components} />
            <WarningList warnings={p.warnings} supplierId={supplier.id} />
            <FiguresTable metrics={p.metrics} />
          </div>
        )}
      </MenuCard>
      <SupplierScoringSettings supplier={supplier} canConfigure={can("supplier_quality.configure")} />
      <MenuCard title="Saved scorecards" subtitle="Frozen records: they keep the figures and the model version they were saved with.">
        {cards.error && <ErrorNotice error={cards.error} />}
        {!cards.data ? null : cards.data.length === 0 ? <p className="text-sm text-secondary-text">No scorecards saved yet.</p> : (
          <div className="flex flex-col gap-3">
            <Trend cards={cards.data} />
            <ul className="flex flex-col divide-y divide-border-color" aria-label="Saved scorecards">
              {cards.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <button type="button" className="text-link-color hover:underline" onClick={() => setDialog({ id: c.id })}>{formatDate(c.periodFrom)} to {formatDate(c.periodTo)}</button>
                  <span className="tabular-nums text-primary-text">{formatScore(c.score)}</span>
                  <BandPill band={c.band} />
                  <span className="text-secondary-text">v{c.modelVersion} · {c.warningCount} {c.warningCount === 1 ? "warning" : "warnings"}{c.note ? ` · ${c.note}` : ""}</span>
                  <span className="ml-auto text-xs text-secondary-text">{formatDateTime(c.createdAt)}{c.createdBy ? ` · ${c.createdBy.name}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </MenuCard>
      {dialog === "save" && <SaveDialog supplierId={supplier.id} period={period} onClose={() => setDialog(null)} />}
      {dialog?.id && <ScorecardDialog id={dialog.id} supplierId={supplier.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

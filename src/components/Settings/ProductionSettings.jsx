import { useState } from "react";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useBackfillProduction } from "../../hooks/useProduction";
import { useUpdateOrganisation } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import MenuCard from "../ui/MenuCard";
import CTAButton from "@/components/CTAButton";

const Switch = ({ id, checked, disabled, onClick }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={id}
    disabled={disabled}
    onClick={onClick}
    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand-primary" : "bg-border-dark-color"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-5.5" : "left-0.5"}`} />
  </button>
);

const SETTINGS = [
  { key: "useLotsAndSerials", title: "Track lots and serial numbers", text: "Off for shops that work to work orders only: Lots and Serial numbers disappear from the menu and from the pickers. Nothing is deleted." },
  { key: "allowInlineOrders", title: "Let operators make an order from a job", text: "People who only record inspections can add a production order (not a lot or serial number) when it is not listed. Otherwise only people who manage production can." },
  { key: "requireProductionOrder", title: "Require a production order to complete a job", text: "A job cannot be completed until it is linked to a production order. Starting and recording are not affected." },
];

const Count = ({ n, one, many }) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What the backfill did or would do, in words. */
const Report = ({ report }) => (
  <div aria-label="Backfill report" className="flex flex-col gap-1 rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">
    <p className="font-medium">{report.dryRun ? "This is what would happen (nothing has changed):" : "Done:"}</p>
    <ul className="list-disc pl-5">
      <li>
        <Count n={report.orders.new} one="production order" many="production orders" /> {report.dryRun ? "would be made" : "made"}
        {report.orders.matched > 0 && <>, {report.orders.matched.toLocaleString()} already exist and would be used</>}.
      </li>
      <li>
        <Count n={report.lots.new} one="lot" many="lots" /> and <Count n={report.serialNumbers.new} one="serial number" many="serial numbers" /> {report.dryRun ? "would be made" : "made"}.
      </li>
      <li>
        {report.dryRun ? (
          <Count n={report.recordsToLink} one="inspection or non-conformance" many="inspections and non-conformances" />
        ) : (
          <>
            <Count n={report.inspectionsLinked} one="inspection" many="inspections" /> and <Count n={report.ncrsLinked} one="non-conformance" many="non-conformances" />
          </>
        )}{" "}
        {report.dryRun ? "would be linked" : "linked"}. What was typed on them is not changed.
      </li>
      {report.noPart > 0 && <li>{Count({ n: report.noPart, one: "record has", many: "records have" })} text but no part, so they are left alone.</li>}
      {report.unusableText > 0 && <li>{Count({ n: report.unusableText, one: "record has", many: "records have" })} a number that is blank or over 60 characters, which is skipped.</li>}
      {report.conflicts > 0 && <li>{Count({ n: report.conflicts, one: "record disagrees", many: "records disagree" })} with a production record that already exists, so they are left alone.</li>}
    </ul>
    {report.orders.skipped.length > 0 && (
      <div>
        <p>Work orders skipped (an order is for one part):</p>
        <ul className="list-disc pl-5 text-secondary-text">
          {report.orders.skipped.map((s) => (
            <li key={s.number}>
              {s.number}: {s.reason}
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

/** Settings → Organisation → Production: which parts of the production records the organisation uses, and linking the work orders, lots and serial numbers typed on existing records. */
const ProductionSettings = ({ settings, canManage }) => {
  const update = useUpdateOrganisation();
  const backfill = useBackfillProduction();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [report, setReport] = useState(null);

  const toggle = (key, title) =>
    update.mutate(
      { body: { settings: { [key]: !settings[key] } }, reason: `${title}: ${settings[key] ? "off" : "on"}` },
      { onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }) }
    );
  const run = async (dryRun) => {
    if (!dryRun) {
      const ok = await confirm({
        title: "Link the existing records?",
        message: "Production orders, lots and serial numbers will be made from the ones typed on existing inspections and non-conformances, and those records linked to them. What was typed is not changed.",
        confirmText: "Link them",
        cancelText: "Cancel",
        type: "warning",
      });
      if (!ok) return;
    }
    backfill.mutate(
      { dryRun },
      {
        onSuccess: (r) => {
          setReport(r);
          if (!dryRun) showToast({ type: "success", title: "Linked", message: "The existing records are linked to production records." });
        },
        onError: (error) => showToast({ type: "error", title: dryRun ? "Could not check" : "Not linked", message: describeApiError(error) }),
      }
    );
  };

  return (
    <MenuCard title="Production" subtitle="Orders, lots and serial numbers" aria-label="Production settings" bodyClassName="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {SETTINGS.map((s) => (
          <li key={s.key} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id={`prod-${s.key}`} className="font-medium text-primary-text">
                {s.title}
              </p>
              <p className="text-sm text-secondary-text">{s.text}</p>
            </div>
            <Switch id={`prod-${s.key}`} checked={!!settings[s.key]} disabled={!canManage || update.isPending} onClick={() => toggle(s.key, s.title)} />
          </li>
        ))}
      </ul>
      {canManage && (
        <section aria-label="Link existing records" className="flex flex-col gap-2 border-t border-border-color pt-4">
          <p className="font-medium text-primary-text">Link existing records</p>
          <p className="text-sm text-secondary-text">
            Inspections and non-conformances recorded before you used production orders have the work order, lot and serial number typed in as text. This makes real records from them and links them, so
            they show up in the order, lot and serial number registers. Preview it first.
          </p>
          <div className="flex flex-wrap gap-2">
            <CTAButton buttonType="button" type="secondary" size="md" disabled={backfill.isPending} loading={backfill.isPending} onClick={() => run(true)}>
              {backfill.isPending ? "Working…" : "Preview"}
            </CTAButton>
            {report?.dryRun && (
              <CTAButton buttonType="button" type="main" size="lg" disabled={backfill.isPending || report.recordsToLink === 0} loading={backfill.isPending} onClick={() => run(false)}>
                Link them
              </CTAButton>
            )}
          </div>
          {report && <Report report={report} />}
        </section>
      )}
    </MenuCard>
  );
};

export default ProductionSettings;

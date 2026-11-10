import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import LinkNotices from "../production/LinkNotices";
import TraceLinks from "../production/TraceLinks";
import { ArrowLeftIcon, CircleAlertIcon, HistoryIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { useGauges } from "../../hooks/useCalibration";
import { useInspection } from "../../hooks/useInspection";
import { formatDateTime } from "../../lib/processControl";
import { ErrorNotice } from "../master-data/shared";
import Failures from "./Failures";
import { ReadingDialog, ReadingsGrid, RunControls, SampleEntry, SamplePlan } from "./recording";
import { ResultBadge, StatusPill } from "./shared";
import LoadingScreen from "../ui/LoadingScreen";
import RHFComboBox from "../ui/RHFComboBox";
import CustomFieldsCard from "../custom-fields/CustomFieldsCard";

/** One in-process inspection: context, due checks, sample entry, readings, completion. */
const InspectionPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const { data: inspection, isLoading, error } = useInspection(id);
  const gaugesQuery = useGauges({ pageSize: 200, sort: "assetNumber" });
  const gauges = gaugesQuery.data?.data ?? [];
  const [opened, setOpened] = useState(null); // { requirement, reading }
  const open = inspection?.status === "in_progress";
  const canRecord = can("inspection.record");
  const notApplicable = inspection?.requirements.filter((q) => !q.applicable) ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Inspections" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Inspections
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <ErrorNotice error={error} />}
      {inspection && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">{inspection.reference}</h1>
            <StatusPill status={inspection.status} />
            {inspection.result && <ResultBadge result={inspection.result} size="lg" />}
            {open && inspection.failures > 0 && <span className="text-sm text-error-color">{inspection.failures} failed reading{inspection.failures > 1 ? "s" : ""} so far</span>}
          </div>
          <LinkNotices links={inspection.links} />
          <TraceLinks links={inspection.links} />
          <MenuCard title="Context" subtitle="Frozen when the inspection started; later plan or part changes do not alter it.">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              {[
                ["Part", `${inspection.part.partNumber} · ${inspection.part.name}`],
                ["Part revision", inspection.partRevision],
                ["Control plan", <Link key="p" to={`/Process-Control/Plans/${inspection.plan.id}`} className="text-link-color hover:underline">{`${inspection.plan.planCode} rev ${inspection.plan.revisionCode}`}</Link>],
                ["Operation", inspection.operationCode ?? "All"],
                ["Site", inspection.site.name],
                ["Machine", inspection.machine ? `${inspection.machine.code} · ${inspection.machine.name}` : "—"],
                ["Work order", inspection.links?.productionOrder ? <Link key="wo" to={`/Production/Orders/${inspection.links.productionOrder.id}`} className="text-link-color hover:underline">{inspection.links.productionOrder.orderNumber}</Link> : (inspection.workOrder ?? "—")],
                ["Lot / serial", [inspection.lot, inspection.serial].filter(Boolean).join(" · ") || "—"],
                ["Lot size", inspection.lotSize ?? "—"],
                ["Operator", inspection.startedBy?.name ?? "—"],
                ["Started", formatDateTime(inspection.startedAt)],
                [inspection.status === "abandoned" ? "Abandoned" : "Completed", inspection.completedAt ? `${formatDateTime(inspection.completedAt)} · ${inspection.completedBy?.name ?? ""}` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-secondary-text">{k}</dt>
                  <dd className="truncate text-primary-text">{v}</dd>
                </div>
              ))}
            </dl>
            {inspection.abandonReason && <p className="mt-2 text-sm text-primary-text">Reason: “{inspection.abandonReason}”</p>}
          </MenuCard>
          <CustomFieldsCard entityType="inspection" record={inspection} editable={canRecord && open} />

          {open && <SamplePlan inspection={inspection} />}
          {open && canRecord && <SampleEntry key={inspection.samples.length} inspection={inspection} gauges={gauges} canOverride={can("inspection.override_gauge")} />}

          <MenuCard title="Readings" subtitle="Select a reading for its history, a correction or a retest.">
            <ReadingsGrid inspection={inspection} onOpen={(requirement, reading) => setOpened({ requirement, reading })} />
          </MenuCard>

          <Failures inspection={inspection} canRecord={canRecord} canRaise={can("ncr.create") && inspection.status !== "abandoned"} canUpdateNcr={can("ncr.update") && inspection.status !== "abandoned"} />

          {notApplicable.length > 0 && (
            <MenuCard title="Not applicable to this part" subtitle="Listed with the rule that excludes them.">
              <ul className="text-sm text-secondary-text">
                {notApplicable.map((q) => (
                  <li key={q.id}>
                    {q.name} — {q.applicability}
                  </li>
                ))}
              </ul>
            </MenuCard>
          )}

          {open && canRecord && <RunControls inspection={inspection} />}

          {opened && (
            <ReadingDialog
              inspection={inspection}
              requirement={opened.requirement}
              reading={inspection.measurements.find((m) => m.id === opened.reading.id) ?? opened.reading}
              gauges={gauges}
              canCorrect={can("inspection.correct")}
              canRecord={canRecord}
              canOverride={can("inspection.override_gauge")}
              onClose={() => setOpened(null)}
            />
          )}
        </>
      )}
    </div>
  );
};

export default InspectionPage;

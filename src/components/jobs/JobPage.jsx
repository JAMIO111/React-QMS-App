import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  ClipboardListIcon,
  HistoryIcon,
  TriangleAlertIcon,
} from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import LoadingScreen from "../ui/LoadingScreen";
import { ErrorNotice, FormError } from "../master-data/shared";
import { ResultBadge, StatusPill } from "../inspection/shared";
import Failures from "../inspection/Failures";
import {
  ReadingDialog,
  ReadingsGrid,
  RunControls,
  SampleEntry,
  SamplePlan,
} from "../inspection/recording";
import { usePermissions } from "../../hooks/useQmsApi";
import { useGauges } from "../../hooks/useCalibration";
import { useInspection } from "../../hooks/useInspection";
import {
  useJobLinks,
  useJobMutation,
  useJobNcrs,
  useJobRevisions,
} from "../../hooks/useJobs";
import { useProductionSettings } from "../../hooks/useProduction";
import LinkNotices from "../production/LinkNotices";
import { LotPicker, OrderPickerWithCreate, SerialPicker } from "../production/pickers";
import { useActiveAlerts } from "../../hooks/useDocumentation";
import SidePanes from "./panes/SidePanes";
import AlertsPane from "./panes/AlertsPane";
import NcrsPane from "./panes/NcrsPane";
import RevisionsPane from "./panes/RevisionsPane";
import { formatDateTime } from "../../lib/processControl";
import { elapsed } from "../../lib/jobs";

/** Elapsed time that keeps counting while the job is running. */
const useNow = (running) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [running]);
  return now;
};

const text = (v) => v ?? "";

/** Work order, lot, quantity and serial: typed in on the hub once they are known, and saved as the field is left. */
const JobInfo = ({ inspection, editable }) => {
  const mutation = useJobMutation();
  const { can } = usePermissions();
  const settings = useProductionSettings();
  const linkMutation = useJobLinks();
  const links = inspection.links ?? { productionOrder: null, lot: null, serial: null };
  const canLink = can("production.read");
  const link = (patch) => linkMutation.mutate({ id: inspection.id, ...patch });
  const server = {
    workOrder: text(inspection.workOrder),
    lot: text(inspection.lot),
    lotSize: text(inspection.lotSize),
    serial: text(inspection.serial),
  };
  const [form, setForm] = useState(server);
  const key = JSON.stringify(server);
  useEffect(() => setForm(JSON.parse(key)), [key]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const qtyValid =
    form.lotSize === "" || /^[1-9]\d{0,8}$/.test(String(form.lotSize).trim());

  // A failed save puts what is on record back in the field as well as in the cache.
  const back = () => setForm(JSON.parse(key));
  const save = (k) => {
    const value = String(form[k]).trim();
    if (value === server[k]) return;
    if (k === "lotSize") {
      if (value === "" || !qtyValid)
        return setForm((f) => ({ ...f, lotSize: server.lotSize })); // a quantity cannot be cleared, only changed
      return mutation.mutate(
        { id: inspection.id, lotSize: Number(value) },
        { onError: back },
      );
    }
    mutation.mutate({ id: inspection.id, [k]: value }, { onError: back });
  };
  const bind = (k, extra) => ({
    value: form[k],
    onChange: set(k),
    onBlur: () => save(k),
    onKeyDown: (e) =>
      e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur()),
    disabled: !editable,
    ...extra,
  });

  return (
    <MenuCard
      title="Job"
      subtitle={
        editable
          ? "Fill in the work order and quantity when you have them. Each is saved as you leave the field."
          : undefined
      }
      aria-label="Job information"
    >
      {canLink && (
        <div className="mb-3 flex flex-col gap-2" aria-label="Production records">
          <div className={`grid grid-cols-1 gap-3 ${settings.useLotsAndSerials ? "md:grid-cols-3" : "md:grid-cols-1"}`}>
            <OrderPickerWithCreate
              label="Production order"
              part={inspection.part}
              siteId={inspection.site.id}
              value={links.productionOrder?.id ?? null}
              current={links.productionOrder}
              disabled={!editable}
              onChange={(id) => link({ productionOrderId: id ?? null })}
            />
            {settings.useLotsAndSerials && (
              <LotPicker partId={inspection.part.id} productionOrderId={links.productionOrder?.id} value={links.lot?.id ?? null} current={links.lot} disabled={!editable} onChange={(id) => link({ lotId: id ?? null })} />
            )}
            {settings.useLotsAndSerials && (
              <SerialPicker partId={inspection.part.id} lotId={links.lot?.id} value={links.serial?.id ?? null} current={links.serial} disabled={!editable} onChange={(id) => link({ serialId: id ?? null })} />
            )}
          </div>
          <LinkNotices links={links} />
          <FormError error={linkMutation.error} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Work order" maxLength={60} {...bind("workOrder")} disabled={!editable || !!links.productionOrder} hint={links.productionOrder ? "From the production order" : undefined} />
        <Field
          label="Quantity (parts)"
          inputMode="numeric"
          maxLength={9}
          {...bind("lotSize")}
          error={!qtyValid ? "Enter a whole number of parts" : undefined}
        />
        <Field label="Lot / batch" maxLength={60} {...bind("lot")} disabled={!editable || !!links.lot} hint={links.lot ? "From the lot" : undefined} />
        <Field label="Serial" maxLength={60} {...bind("serial")} disabled={!editable || !!links.serial} hint={links.serial ? "From the serial number" : undefined} />
      </div>
      <FormError error={mutation.error} />
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
        {[
          ["Part", `${inspection.part.partNumber} · ${inspection.part.name}`],
          ["Part revision", inspection.partRevision],
          [
            "Control plan",
            <Link
              key="p"
              to={`/Process-Control/Plans/${inspection.plan.id}`}
              className="text-link-color hover:underline"
            >{`${inspection.plan.planCode} rev ${inspection.plan.revisionCode}`}</Link>,
          ],
          ["Operation", inspection.operationCode ?? "All"],
          [
            "Machine",
            inspection.machine
              ? `${inspection.machine.code} · ${inspection.machine.name}`
              : "—",
          ],
          ["Site", inspection.site.name],
          ["Operator", inspection.startedBy?.name ?? "—"],
          ["Started", formatDateTime(inspection.startedAt)],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-secondary-text">{k}</dt>
            <dd className="truncate text-primary-text">{v}</dd>
          </div>
        ))}
      </dl>
    </MenuCard>
  );
};

/** The revisions now in force when the job is still running on older ones: information only, nothing is blocked. */
const SupersededBanner = ({ inspection, revisions }) => {
  const now = (kind) =>
    revisions.data.find((r) => r.kind === kind && r.current);
  const parts = [];
  const part = now("part_revision");
  // A correction keeps the drawing's letter: say so, rather than calling it a newer revision.
  const corrected =
    revisions.partRevisionSuperseded &&
    part &&
    part.version > 1 &&
    part.revision === inspection.partRevision;
  if (revisions.partRevisionSuperseded && part && !corrected)
    parts.push(
      `part revision ${part.revision} (this job runs on ${inspection.partRevision})`,
    );
  if (revisions.planRevisionSuperseded && now("plan_revision"))
    parts.push(
      `control plan revision ${now("plan_revision").revision} (this job runs on ${inspection.plan.revisionCode})`,
    );
  if (parts.length === 0 && !corrected) return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-warning-color bg-warning-color/15 p-3 text-sm text-primary-text"
    >
      {corrected && (
        <>
          Our record of revision {part.revision} has been corrected (now v
          {part.version}); the drawing's revision is unchanged. This job keeps
          the values it started with.{" "}
        </>
      )}
      {parts.length > 0 && (
        <>A newer {parts.join(" and a newer ")} is now in force. </>
      )}
      {parts.length > 0 && "This job keeps the checks it started with. "}
      Open the Revisions pane to see what changed, or abandon this job and
      start it again to use the new one.
    </p>
  );
};

/**
 * The operator job hub: one place for a job. The checks to record, live results and the sample plan are the same components as the inspection page;
 * the job's own details are editable here while it runs.
 */
const JobPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const { data: inspection, isLoading, error } = useInspection(id);
  const gauges =
    useGauges({ pageSize: 200, sort: "assetNumber" }).data?.data ?? [];
  const [opened, setOpened] = useState(null);
  const open = inspection?.status === "in_progress";
  const now = useNow(open);
  const canRecord = can("inspection.record");
  const notApplicable =
    inspection?.requirements.filter((q) => !q.applicable) ?? [];

  // What the panes hold. Each is fetched only for people who may read it, and a pane they cannot read is not shown at all.
  const alertsQuery = useActiveAlerts(
    {
      partId: inspection?.part.id,
      machineId: inspection?.machine?.id,
      operationCode: inspection?.operationCode ?? undefined,
    },
    { enabled: !!inspection && can("documentation.read") },
  );
  const ncrsQuery = useJobNcrs(id, {
    enabled: !!inspection && can("ncr.read"),
  });
  const revisionsQuery = useJobRevisions(id, {
    enabled: !!inspection && canRecord,
  });
  const alerts = alertsQuery.data ?? [];
  const ncrs = ncrsQuery.data;
  const revisions = revisionsQuery.data;
  const panes = [
    can("documentation.read") && {
      key: "alerts",
      label: "Alerts",
      title: "Quality alerts",
      icon: TriangleAlertIcon,
      count: alerts.length,
      attention: alerts.some((a) => a.acknowledged === false),
      content: <AlertsPane alerts={alerts} />,
    },
    can("ncr.read") &&
      ncrs?.canRead && {
        key: "ncrs",
        label: "NCs",
        title: "Recent non-conformances",
        icon: ClipboardListIcon,
        count: ncrs.data.length,
        attention: ncrs.data.some((n) => n.open),
        content: <NcrsPane ncrs={ncrs} />,
      },
    can("master_data.read") &&
      revisions && {
        key: "revisions",
        label: "Revisions",
        title: "Recent revisions",
        icon: HistoryIcon,
        count: revisions.data.length,
        attention: revisions.data.some((r) => r.isNew),
        content: <RevisionsPane revisions={revisions} />,
      },
  ].filter(Boolean);

  return (
    <div className="relative h-full min-h-0 w-full min-w-0 overflow-hidden">
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4 pr-16">
        <Link
          to="/"
          className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline"
        >
          <ArrowLeftIcon className="h-4 w-4" /> Dashboard
        </Link>
        {isLoading && <LoadingScreen />}
        {error && <ErrorNotice error={error} />}
        {inspection && (
          <>
            <header
              className="flex flex-wrap items-center gap-x-4 gap-y-2"
              aria-label="Job summary"
            >
              <h1 className="text-2xl font-semibold text-primary-text">
                {inspection.part.partNumber}
                {inspection.machine ? ` · ${inspection.machine.code}` : ""}
              </h1>
              <StatusPill status={inspection.status} />
              {inspection.result && (
                <ResultBadge result={inspection.result} size="lg" />
              )}
              <span className="text-sm text-secondary-text">
                {inspection.reference} ·{" "}
                {open
                  ? `running ${elapsed(inspection.startedAt, now)}`
                  : `ended ${formatDateTime(inspection.completedAt)}`}
              </span>
              {open && inspection.failures > 0 && (
                <span className="text-sm text-error-color">
                  {inspection.failures} failed reading
                  {inspection.failures > 1 ? "s" : ""} so far
                </span>
              )}
            </header>
            {inspection.abandonReason && (
              <p className="text-sm text-primary-text">
                Abandoned: “{inspection.abandonReason}”
              </p>
            )}
            {open && revisions && (
              <SupersededBanner inspection={inspection} revisions={revisions} />
            )}

            <JobInfo inspection={inspection} editable={open && canRecord} />

            {open && <SamplePlan inspection={inspection} />}
            {open && canRecord && (
              <SampleEntry
                key={inspection.samples.length}
                inspection={inspection}
                gauges={gauges}
                canOverride={can("inspection.override_gauge")}
              />
            )}

            <MenuCard
              title="Readings"
              subtitle="Select a reading for its history, a correction or a retest."
            >
              <ReadingsGrid
                inspection={inspection}
                onOpen={(requirement, reading) =>
                  setOpened({ requirement, reading })
                }
              />
            </MenuCard>

            <Failures
              inspection={inspection}
              canRecord={canRecord}
              canRaise={can("ncr.create") && inspection.status !== "abandoned"}
              canUpdateNcr={
                can("ncr.update") && inspection.status !== "abandoned"
              }
            />

            {notApplicable.length > 0 && (
              <MenuCard
                title="Not applicable to this part"
                subtitle="Listed with the rule that excludes them."
              >
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
            {!open && (
              <Link
                to="/"
                className="w-fit text-sm text-link-color hover:underline"
              >
                Back to the dashboard to start another job
              </Link>
            )}

            {opened && (
              <ReadingDialog
                inspection={inspection}
                requirement={opened.requirement}
                reading={
                  inspection.measurements.find(
                    (m) => m.id === opened.reading.id,
                  ) ?? opened.reading
                }
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
      <SidePanes panes={panes} />
    </div>
  );
};

export default JobPage;
